import { LIMITS } from "./constants.ts";
import { execArgv, type ExecResult } from "./exec.ts";
import { truncateText } from "./redactor.ts";
import type { Confidence, ProcessCandidate, ProcessSnapshot, ToolObservation } from "./types.ts";

export type ExecFn = (command: string, args: string[], options: {
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<ExecResult>;

export interface ProcessObserverOptions {
  exec?: ExecFn;
  now?: () => number;
  platform?: NodeJS.Platform;
  rootPid?: number;
}

interface ProcRow {
  pid: number;
  ppid: number;
  elapsed?: string;
  cpu?: string;
  rssKb?: number;
  command: string;
}

const LONG_TOOLS = new Set(["bash", "powershell", "shell"]);
const FILEISH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);

const PS_SNAPSHOT_ARGV = {
  darwin: ["-axo", "pid=,ppid=,etime=,pcpu=,rss=,command="],
  linux: ["-eo", "pid=,ppid=,etime=,pcpu=,rss=,args="],
} as const;

const OVERLAP_STOPWORDS = new Set([
  "command",
  "timeout",
  "cmd",
  "args",
  "argv",
  "cwd",
  "env",
  "workdir",
  "timeoutms",
  "timeout_ms",
  "signal",
  "stdin",
  "stdout",
  "stderr",
  "description",
  "tool",
  "name",
  "type",
  "options",
]);

export function shouldObserveProcesses(activeTools: ToolObservation[], now = Date.now()): boolean {
  return activeTools.some((tool) => {
    if (LONG_TOOLS.has(tool.toolName)) return true;
    if (FILEISH_TOOLS.has(tool.toolName)) return false;
    return now - tool.startedAt > 1500;
  });
}

export class ProcessObserver {
  private readonly exec: ExecFn;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly rootPid: number;

  constructor(options: ProcessObserverOptions = {}) {
    this.exec = options.exec ?? ((command, args, opts) => execArgv(command, args, opts));
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.rootPid = options.rootPid ?? process.pid;
  }

  async snapshot(activeTools: ToolObservation[], signal?: AbortSignal): Promise<ProcessSnapshot> {
    const ts = this.now();
    if (this.platform === "win32") {
      return {
        ts,
        complete: false,
        reason: "当前平台暂不支持进程候选观察",
        platform: this.platform,
        rootPid: this.rootPid,
        candidates: [],
      };
    }
    try {
      const args = [...(this.platform === "darwin" ? PS_SNAPSHOT_ARGV.darwin : PS_SNAPSHOT_ARGV.linux)];
      const result = await this.exec("ps", args, { timeoutMs: LIMITS.processTimeoutMs, signal });
      if (result.killed) {
        return this.fail(ts, "进程探测超时");
      }
      if (result.code !== 0) {
        return this.fail(ts, truncateText(result.stderr || "ps 失败", LIMITS.timelineDetailChars, LIMITS.timelineDetailBytes));
      }
      const rows = parsePs(result.stdout);
      const descendants = descendantPids(rows, this.rootPid);
      const candidates = scoreCandidates(rows, descendants, this.rootPid, activeTools, this.now());
      return {
        ts,
        complete: true,
        platform: this.platform,
        rootPid: this.rootPid,
        candidates,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.fail(ts, "未找到 ps 命令");
      const message = error instanceof Error ? error.message : String(error);
      if (/EPERM|EACCES|not permitted/i.test(message)) return this.fail(ts, "进程探测无权限");
      return this.fail(ts, truncateText(message, LIMITS.timelineDetailChars, LIMITS.timelineDetailBytes));
    }
  }

  private fail(ts: number, reason: string): ProcessSnapshot {
    return {
      ts,
      complete: false,
      reason,
      platform: this.platform,
      rootPid: this.rootPid,
      candidates: [],
    };
  }
}

export function parsePs(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      elapsed: match[3],
      cpu: match[4],
      rssKb: Number(match[5]),
      command: match[6],
    });
  }
  return rows;
}

export function descendantPids(rows: ProcRow[], rootPid: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const out = new Set<number>();
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (out.has(pid)) continue;
    out.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

const START_SLACK_MS = 1000;

export function parseEtimeToMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-" || trimmed === "?") return undefined;
  const daySplit = trimmed.split("-");
  let days = 0;
  let rest = trimmed;
  if (daySplit.length === 2) {
    days = Number(daySplit[0]);
    rest = daySplit[1] ?? "";
    if (!Number.isFinite(days) || days < 0) return undefined;
  }
  const parts = rest.split(":").map((part) => Number(part));
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) return undefined;
  let seconds = 0;
  if (parts.length === 2) seconds = (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  else seconds = (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  return (days * 86400 + seconds) * 1000;
}

export function scoreCandidates(
  rows: ProcRow[],
  descendants: Set<number>,
  rootPid: number,
  activeTools: ToolObservation[],
  now = Date.now(),
): ProcessCandidate[] {
  const longTools = activeTools.filter((tool) => LONG_TOOLS.has(tool.toolName));
  const commands = longTools.map((tool) => tool.argsSummary.toLowerCase());
  const earliestToolStart = longTools.reduce<number | undefined>(
    (min, tool) => (min == null || tool.startedAt < min ? tool.startedAt : min),
    undefined,
  );
  const highOverlapDescendants = rows.filter(
    (row) => (
      row.pid !== rootPid
      && !isObserverSnapshotProcess(row.command)
      && descendants.has(row.pid)
      && commandOverlap(row.command, commands) >= 0.6
    ),
  );
  const parallel = highOverlapDescendants.length > 1;
  const scored: ProcessCandidate[] = [];
  for (const row of rows) {
    if (row.pid === rootPid) continue;
    if (isObserverSnapshotProcess(row.command)) continue;
    const descendant = descendants.has(row.pid);
    const cmd = truncateText(row.command, LIMITS.processCmdChars, LIMITS.processCmdBytes);
    const overlap = commandOverlap(row.command, commands);
    const evidence: string[] = [];
    const elapsedMs = parseEtimeToMs(row.elapsed);
    const processStartedAt = elapsedMs == null ? undefined : now - elapsedMs;
    let timeFit: "ok" | "too-old" | "unknown" = "unknown";
    if (processStartedAt == null || earliestToolStart == null) {
      timeFit = "unknown";
    } else if (processStartedAt + START_SLACK_MS < earliestToolStart) {
      timeFit = "too-old";
    } else {
      timeFit = "ok";
    }
    let confidence: Confidence = "unknown";
    if (descendant) evidence.push("是 Pi 进程后代");
    if (overlap >= 0.6) evidence.push("命令与当前 bash 摘要高度相似");
    else if (overlap > 0) evidence.push("命令与当前 bash 摘要部分相似");
    if (timeFit === "ok") evidence.push("启动时间与当前工具窗口相容");
    else if (timeFit === "too-old") evidence.push("进程启动早于工具开始时间");
    else evidence.push("无法解析进程启动时间");
    const uniqueHigh = descendant && overlap >= 0.6 && !parallel && timeFit === "ok";
    if (uniqueHigh) {
      confidence = "high";
    } else if (descendant && overlap >= 0.6) {
      confidence = "medium";
    } else if (descendant && overlap > 0) {
      confidence = "medium";
    } else if (descendant && /\b(sleep|bash|sh|zsh|python|node|ruby)\b/.test(row.command)) {
      confidence = "medium";
      evidence.push("Pi 后代且命令像长时间外部进程");
    } else if (overlap >= 0.6) {
      confidence = "low";
      evidence.push("仅命令近似，父子关系未确认");
    } else {
      continue;
    }
    scored.push({
      pid: row.pid,
      ppid: row.ppid,
      command: cmd,
      cpu: row.cpu,
      rssKb: row.rssKb,
      elapsed: row.elapsed,
      alive: true,
      descendantOfPi: descendant,
      confidence,
      evidence,
    });
  }
  scored.sort((a, b) => rank(b.confidence) - rank(a.confidence));
  return scored;
}

function isObserverSnapshotProcess(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  const bin = (tokens[0] ?? "").split(/[/\\]/).pop() ?? "";
  if (bin !== "ps") return false;
  const args = tokens.slice(1);
  return Object.values(PS_SNAPSHOT_ARGV).some((expected) => argvEquals(args, expected));
}

function argvEquals(actual: string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((item, index) => item === expected[index]);
}

function meaningfulTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s/\\=,]+/)
    .map((token) => token.replace(/^['"]+|['"]+$/g, ""))
    .filter((token) => token.length > 1 && !OVERLAP_STOPWORDS.has(token));
}

function commandOverlap(command: string, toolCommands: string[]): number {
  if (toolCommands.length === 0) return 0;
  const tokens = new Set(meaningfulTokens(command));
  if (tokens.size === 0) return 0;
  let best = 0;
  for (const summary of toolCommands) {
    const parts = meaningfulTokens(summary);
    if (parts.length === 0) continue;
    const hit = parts.filter((part) => tokens.has(part)).length;
    best = Math.max(best, hit / parts.length);
  }
  return best;
}

function rank(confidence: Confidence): number {
  switch (confidence) {
    case "confirmed":
      return 5;
    case "high":
      return 4;
    case "medium":
      return 3;
    case "low":
      return 2;
    default:
      return 1;
  }
}
