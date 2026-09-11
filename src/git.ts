import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS } from "./constants.ts";
import { execArgv, type ExecResult } from "./exec.ts";
import { truncateText } from "./redactor.ts";
import type { FileDiffEntry, GitFileRecord, WorkspaceSnapshot } from "./types.ts";

export type ExecFn = (command: string, args: string[], options: {
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxStdoutBytes?: number;
}) => Promise<ExecResult>;

export interface HashFileResult {
  hash?: string;
  partial: boolean;
  size?: number;
  bytesRead?: number;
  missing?: boolean;
}

export interface GitObserverOptions {
  exec?: ExecFn;
  now?: () => number;
  readFile?: (absolutePath: string, maxBytes: number) => Promise<HashFileResult>;
}

interface CaptureBudget {
  files: number;
  bytes: number;
}

export class GitObserver {
  private readonly exec: ExecFn;
  private readonly now: () => number;
  private readonly readFile: GitObserverOptions["readFile"];
  private cache = new Map<string, { ts: number; snapshot: WorkspaceSnapshot; inflight?: Promise<WorkspaceSnapshot> }>();

  constructor(options: GitObserverOptions = {}) {
    this.exec = options.exec ?? ((command, args, opts) => execArgv(command, args, opts));
    this.now = options.now ?? Date.now;
    this.readFile = options.readFile ?? hashFile;
  }

  async capture(cwd: string, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    const startedAt = this.now();
    const failed = (reason: string): WorkspaceSnapshot => ({
      ts: this.now(),
      complete: false,
      reason,
      files: [],
      startedAt,
      endedAt: this.now(),
    });
    const timeout = AbortSignal.timeout(LIMITS.gitSnapshotTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const inside = await this.git(cwd, ["rev-parse", "--is-inside-work-tree"], combined);
      const insideHalt = haltGit(inside, combined, timeout, "Git 命令");
      if (insideHalt) return failed(insideHalt);
      if (inside.code !== 0 || inside.stdout.trim() !== "true") {
        return failed("当前目录不是 Git 仓库");
      }

      const rootRes = await this.git(cwd, ["rev-parse", "--show-toplevel"], combined);
      const rootHalt = haltGit(rootRes, combined, timeout, "Git toplevel");
      if (rootHalt) return failed(rootHalt);
      if (rootRes.code !== 0) {
        return failed(truncateText(rootRes.stderr || "git rev-parse --show-toplevel 失败", LIMITS.timelineDetailChars, LIMITS.timelineDetailBytes));
      }
      const root = rootRes.stdout.trim();

      const incompleteReasons: string[] = [];
      const branchRes = await this.git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], combined);
      const branchHalt = haltGit(branchRes, combined, timeout, "Git 分支");
      if (branchHalt) return failed(branchHalt);
      let branch: string | undefined;
      if (branchRes.code !== 0) {
        if (!isUnbornHead(branchRes)) {
          incompleteReasons.push(truncateText(branchRes.stderr || "git 分支查询失败", LIMITS.timelineDetailChars, LIMITS.timelineDetailBytes));
        }
      } else {
        const name = branchRes.stdout.trim();
        branch = name && name !== "HEAD" ? name : undefined;
      }

      const headRes = await this.git(cwd, ["rev-parse", "HEAD"], combined);
      const headHalt = haltGit(headRes, combined, timeout, "Git HEAD");
      if (headHalt) return failed(headHalt);
      let head: string | undefined;
      if (headRes.code !== 0) {
        if (!isUnbornHead(headRes)) {
          incompleteReasons.push(truncateText(headRes.stderr || "git HEAD 查询失败", LIMITS.timelineDetailChars, LIMITS.timelineDetailBytes));
        }
      } else {
        head = headRes.stdout.trim() || undefined;
      }

      const status = await this.git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], combined, LIMITS.gitStatusMaxStdoutBytes);
      const statusHalt = haltGit(status, combined, timeout, "Git status");
      if (statusHalt) return failed(statusHalt);
      if (status.code !== 0) return failed(truncateText(status.stderr || "git status 失败", LIMITS.timelineDetailChars, LIMITS.timelineDetailBytes));
      if (status.stdoutTruncated) incompleteReasons.push("git status 输出被截断，文件列表可能不完整");
      const parsed = parsePorcelainZ(status.stdout, LIMITS.gitMaxFiles);
      const files = parsed.files;
      const totalFiles = parsed.total;
      const filesDropped = Math.max(0, totalFiles - files.length);
      if (filesDropped > 0) {
        incompleteReasons.push(`工作区文件记录超出容量 ${LIMITS.gitMaxFiles}，已省略 ${filesDropped} 个`);
      }
      const budget: CaptureBudget = { files: 0, bytes: 0 };
      for (const file of files) {
        if (combined.aborted) return failed("Git 快照总超时");
        if (isDeleted(file)) continue;
        if (budget.files >= LIMITS.gitMaxFiles || budget.bytes >= LIMITS.gitMaxTotalBytes) {
          file.fingerprintPartial = true;
          continue;
        }
        if (file.untracked || file.unstaged || file.staged) {
          const abs = join(root || cwd, file.path);
          const hashed = await this.readFile!(abs, remainingFileBudget(budget));
          file.size = hashed.size;
          if (hashed.missing) {
            file.missing = true;
            continue;
          }
          file.fingerprint = hashed.hash;
          const read = hashed.bytesRead ?? 0;
          file.fingerprintPartial = hashed.partial || budget.bytes + read > LIMITS.gitMaxTotalBytes;
          budget.files += 1;
          budget.bytes += read;
        }
      }
      const fingerprintIncomplete = files.some((file) => file.fingerprintPartial || file.missing);
      const fingerprintReason = files.some((file) => file.missing)
        ? "部分文件在采集指纹时已消失，未知"
        : files.some((file) => file.fingerprintPartial)
          ? "Git 指纹超出文件数或字节预算，精度已降低"
          : undefined;
      const uniqueReasons = [...new Set([...incompleteReasons, ...(fingerprintReason ? [fingerprintReason] : [])])];
      const snapshot: WorkspaceSnapshot = {
        ts: this.now(),
        complete: !fingerprintIncomplete && incompleteReasons.length === 0,
        reason: uniqueReasons.length > 0 ? uniqueReasons.join("；") : undefined,
        repoRoot: root || cwd,
        head,
        branch,
        files,
        totalFiles,
        filesDropped,
        statusOutputTruncated: Boolean(status.stdoutTruncated),
        startedAt,
        endedAt: this.now(),
      };
      this.cache.set(cwd, { ts: snapshot.ts, snapshot });
      return snapshot;
    } catch (error) {
      if (combined.aborted || (error instanceof Error && error.name === "AbortError")) {
        return failed(timeout.aborted ? "Git 快照总超时" : "Git 命令超时");
      }
      const message = error instanceof Error ? error.message : String(error);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return failed("未找到 git 命令");
      return failed(truncateText(message, LIMITS.timelineDetailChars, LIMITS.timelineDetailBytes));
    }
  }

  private git(cwd: string, args: string[], signal?: AbortSignal, maxStdoutBytes?: number): Promise<ExecResult> {
    return this.exec("git", args, { cwd, timeoutMs: LIMITS.gitCommandTimeoutMs, signal, maxStdoutBytes });
  }

  async captureCached(cwd: string, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    const cached = this.cache.get(cwd);
    if (cached && this.now() - cached.ts < LIMITS.gitCacheMs && !cached.inflight) {
      return { ...cached.snapshot, fromCache: true };
    }
    if (cached?.inflight) return cached.inflight;
    const inflight = this.capture(cwd, signal);
    this.cache.set(cwd, { ts: cached?.ts ?? 0, snapshot: cached?.snapshot ?? emptySnapshot(this.now()), inflight });
    try {
      const snapshot = await inflight;
      return snapshot;
    } finally {
      const latest = this.cache.get(cwd);
      if (latest) latest.inflight = undefined;
    }
  }

  async waitForSnapshot(cwd: string, pending: Promise<WorkspaceSnapshot> | undefined, waitMs: number): Promise<WorkspaceSnapshot | undefined> {
    if (!pending) {
      const cached = this.cache.get(cwd);
      return cached?.snapshot;
    }
    return await Promise.race([
      pending,
      new Promise<undefined>((resolve) => {
        setTimeout(() => resolve(undefined), waitMs);
      }),
    ]);
  }
}

export function diffSnapshots(baseline: WorkspaceSnapshot | undefined, current: WorkspaceSnapshot | undefined): FileDiffEntry[] {
  if (!current) return [];
  const before = new Map((baseline?.files ?? []).map((file) => [file.path, file]));
  const after = new Map(current.files.map((file) => [file.path, file]));
  const renamedAway = new Set(
    current.files.map((file) => file.renamedFrom).filter((path): path is string => Boolean(path)),
  );
  const paths = new Set([...before.keys(), ...after.keys()]);
  const result: FileDiffEntry[] = [];
  for (const path of [...paths].sort()) {
    const prev = before.get(path);
    const next = after.get(path);
    if (next?.renamedFrom) {
      result.push({ path, kind: "renamed", before: prev, after: next });
      continue;
    }
    if (next && isDeletedRecord(next)) {
      result.push({ path, kind: "deleted", before: prev, after: next });
      continue;
    }
    if (prev && next) {
      if (prev.fingerprint && next.fingerprint && prev.fingerprint === next.fingerprint && prev.status === next.status) {
        result.push({ path, kind: "baseline-unchanged", before: prev, after: next });
      } else if (prev.fingerprint && next.fingerprint && prev.fingerprint !== next.fingerprint) {
        result.push({ path, kind: "baseline-further-changed", before: prev, after: next });
      } else if (prev.status !== next.status) {
        result.push({ path, kind: "status-changed", before: prev, after: next });
      } else {
        result.push({ path, kind: "current", before: prev, after: next });
      }
    } else if (!prev && next) {
      result.push({ path, kind: "appeared", after: next });
    } else if (prev && !next) {
      if (renamedAway.has(path)) continue;
      result.push({ path, kind: "no-longer-changed", before: prev });
    }
  }
  return result;
}

export function parsePorcelainZ(stdout: string, maxFiles = Number.POSITIVE_INFINITY): { files: GitFileRecord[]; total: number } {
  const parts = stdout.split("\0").filter((part) => part.length > 0);
  const files: GitFileRecord[] = [];
  let total = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (entry.length < 3) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    let renamedFrom: string | undefined;
    if ((status.startsWith("R") || status.startsWith("C") || status.includes("R") || status.includes("C")) && parts[i + 1] && !looksLikeStatus(parts[i + 1])) {
      renamedFrom = parts[i + 1];
      i += 1;
    }
    const x = status[0] ?? " ";
    const y = status[1] ?? " ";
    total += 1;
    if (files.length >= maxFiles) continue;
    files.push({
      path,
      status,
      staged: x !== " " && x !== "?",
      unstaged: y !== " " && y !== "?",
      untracked: x === "?" || y === "?",
      renamedFrom,
    });
  }
  return { files, total };
}

function isDeleted(file: GitFileRecord): boolean {
  return isDeletedRecord(file);
}

export function isDeletedRecord(file: GitFileRecord): boolean {
  return file.status.includes("D") && !file.untracked && !file.renamedFrom;
}

function looksLikeStatus(value: string): boolean {
  return value.length >= 3 && /[ MADRCU?!]{2} /.test(`${value.slice(0, 2)} `);
}

function remainingFileBudget(budget: CaptureBudget): number {
  const remainingTotal = Math.max(0, LIMITS.gitMaxTotalBytes - budget.bytes);
  return Math.min(LIMITS.gitMaxFileBytes, remainingTotal);
}

function emptySnapshot(ts: number): WorkspaceSnapshot {
  return { ts, complete: false, files: [], startedAt: ts };
}

function haltGit(result: ExecResult, combined: AbortSignal, timeout: AbortSignal, label: string): string | undefined {
  if (combined.aborted || result.killed) return timeout.aborted ? "Git 快照总超时" : `${label} 超时`;
  return undefined;
}

export function isUnbornHead(result: Pick<ExecResult, "stdout" | "stderr">): boolean {
  const text = `${result.stderr}\n${result.stdout}`;
  return /unknown revision|bad revision|ambiguous argument ['"]HEAD['"]|does not have any commits yet|Needed a single revision/i.test(text);
}

export async function hashFile(absolutePath: string, maxBytes: number): Promise<HashFileResult> {
  if (maxBytes <= 0) return { partial: true, bytesRead: 0 };
  let fileSize: number;
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) return { missing: true, partial: false };
    fileSize = info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { missing: true, partial: false, size: 0, bytesRead: 0 };
    return { missing: true, partial: false, bytesRead: 0 };
  }
  const overBudget = fileSize > maxBytes;
  if (fileSize === 0) {
    return { hash: createHash("sha256").update("").digest("hex").slice(0, 16), partial: false, size: 0, bytesRead: 0 };
  }
  const bytesToRead = overBudget ? maxBytes : fileSize;
  return await new Promise((resolve) => {
    const hash = createHash("sha256");
    let bytesRead = 0;
    const stream = createReadStream(absolutePath, { start: 0, end: bytesToRead - 1 });
    stream.on("data", (chunk: string | Buffer) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytesRead += buf.length;
      hash.update(buf);
    });
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") resolve({ missing: true, partial: false, size: bytesRead, bytesRead });
      else resolve({ missing: true, partial: false, size: bytesRead, bytesRead });
    });
    stream.on("end", () => {
      resolve({
        hash: hash.digest("hex").slice(0, 16),
        partial: overBudget,
        size: fileSize,
        bytesRead,
      });
    });
  });
}
