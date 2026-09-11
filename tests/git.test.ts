import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { execArgv } from "../src/exec.ts";
import { GitObserver, diffSnapshots, hashFile, parsePorcelainZ } from "../src/git.ts";
import { LIMITS } from "../src/constants.ts";
import type { ExecResult } from "../src/exec.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), ".tmp", "git");

async function git(cwd: string, args: string[]): Promise<ExecResult> {
  return execArgv("git", args, { cwd, timeoutMs: 8_000 });
}

async function initRepo(name: string): Promise<string> {
  const cwd = join(root, name);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  const init = await git(cwd, ["init"]);
  assert.equal(init.code, 0, init.stderr);
  await git(cwd, ["config", "user.email", "observer-test@example.com"]);
  await git(cwd, ["config", "user.name", "observer-test"]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);
  return cwd;
}

test("parsePorcelainZ 处理 untracked、rename 与特殊路径", () => {
  const parsed = parsePorcelainZ("?? 中文 文件.txt\0R  new file.txt\0old.txt\0 M src/app.ts\0");
  const files = parsed.files;
  assert.equal(parsed.total, 3);
  assert.equal(files[0]?.untracked, true);
  assert.equal(files[0]?.path, "中文 文件.txt");
  assert.equal(files[1]?.path, "new file.txt");
  assert.equal(files[1]?.renamedFrom, "old.txt");
  assert.equal(files[2]?.unstaged, true);
});

test("干净仓库快照为空", async () => {
  const cwd = await initRepo("clean");
  writeFileSync(join(cwd, "README.md"), "ok\n");
  await git(cwd, ["add", "README.md"]);
  await git(cwd, ["commit", "-m", "init"]);
  const snapshot = await new GitObserver().capture(cwd);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.files.length, 0);
  assert.ok(snapshot.branch);
  assert.ok(snapshot.head);
});

test("初始 dirty、再改、staged/unstaged/untracked/删除/重命名/特殊路径", async () => {
  const cwd = await initRepo("dirty");
  writeFileSync(join(cwd, "tracked.ts"), "v1\n");
  writeFileSync(join(cwd, "will-rename.ts"), "rename\n");
  writeFileSync(join(cwd, "will-delete.ts"), "gone\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", "init"]);

  writeFileSync(join(cwd, "tracked.ts"), "v2\n");
  const observer = new GitObserver();
  const baseline = await observer.capture(cwd);
  assert.ok(baseline.files.some((file) => file.path === "tracked.ts" && file.unstaged));

  writeFileSync(join(cwd, "tracked.ts"), "v3\n");
  writeFileSync(join(cwd, "staged.ts"), "staged\n");
  await git(cwd, ["add", "staged.ts"]);
  writeFileSync(join(cwd, "中文 文件.txt"), "unicode\n");
  writeFileSync(join(cwd, "file with spaces.ts"), "spaces\n");
  rmSync(join(cwd, "will-delete.ts"));
  await git(cwd, ["mv", "will-rename.ts", "renamed.ts"]);

  const current = await observer.capture(cwd);
  const diffs = diffSnapshots(baseline, current);
  assert.ok(diffs.some((item) => item.path === "tracked.ts" && item.kind === "baseline-further-changed"));
  assert.ok(current.files.some((file) => file.path === "staged.ts" && file.staged));
  assert.ok(current.files.some((file) => file.path === "中文 文件.txt" && file.untracked));
  assert.ok(current.files.some((file) => file.path === "file with spaces.ts" && file.untracked));
  const renamed = diffs.find((item) => item.path === "renamed.ts");
  assert.equal(renamed?.kind, "renamed");
  assert.equal(renamed?.after?.renamedFrom, "will-rename.ts");
  const deleted = diffs.find((item) => item.path === "will-delete.ts");
  assert.equal(deleted?.kind, "deleted");
  assert.equal(deleted?.after?.unstaged, true);
  assert.equal(diffs.some((item) => item.path === "will-delete.ts" && item.kind === "status-changed"), false);
});

test("基线 modified 恢复干净或 untracked 消失时是 no-longer-changed，不伪造删除", () => {
  const baseline = {
    ts: 1,
    complete: true,
    files: [
      { path: "dirty.ts", status: " M", staged: false, unstaged: true, untracked: false, fingerprint: "aaaa" },
      { path: "new.ts", status: "??", staged: false, unstaged: false, untracked: true, fingerprint: "bbbb" },
    ],
    startedAt: 1,
  };
  const current = {
    ts: 2,
    complete: true,
    files: [],
    startedAt: 2,
  };
  const diffs = diffSnapshots(baseline, current);
  assert.equal(diffs.find((item) => item.path === "dirty.ts")?.kind, "no-longer-changed");
  assert.equal(diffs.find((item) => item.path === "new.ts")?.kind, "no-longer-changed");
  assert.equal(diffs.some((item) => item.kind === "deleted"), false);
});

test("真正删除只能由当前 D 状态证明", () => {
  const baseline = {
    ts: 1,
    complete: true,
    files: [{ path: "kept.ts", status: " M", staged: false, unstaged: true, untracked: false, fingerprint: "aaaa" }],
    startedAt: 1,
  };
  const current = {
    ts: 2,
    complete: true,
    files: [{ path: "kept.ts", status: " D", staged: false, unstaged: true, untracked: false }],
    startedAt: 2,
  };
  const diffs = diffSnapshots(baseline, current);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0]?.kind, "deleted");
  assert.equal(diffs[0]?.after?.unstaged, true);
  assert.equal(diffs.some((item) => item.kind === "status-changed"), false);
});

test("非 Git 目录局部降级", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pto-nongit-"));
  const snapshot = await new GitObserver().capture(cwd);
  assert.equal(snapshot.complete, false);
  assert.match(snapshot.reason ?? "", /不是 Git 仓库/);
  rmSync(cwd, { recursive: true, force: true });
});

test("Git 超时只降级工作区", async () => {
  const observer = new GitObserver({
    exec: async () => ({ stdout: "", stderr: "", code: null, killed: true }),
  });
  const snapshot = await observer.capture("/tmp");
  assert.equal(snapshot.complete, false);
  assert.match(snapshot.reason ?? "", /超时/);
});

test("Git 文件记录固定容量，超出只计总数/省略数", async () => {
  const total = 3000;
  const lines = Array.from({ length: total }, (_, index) => `?? f${index}.txt`);
  const observer = new GitObserver({
    exec: async (_command, args) => {
      if (args.includes("--is-inside-work-tree")) return { stdout: "true\n", stderr: "", code: 0, killed: false };
      if (args.includes("--show-toplevel")) return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
      if (args.includes("--abbrev-ref")) return { stdout: "main\n", stderr: "", code: 0, killed: false };
      if (args.includes("HEAD")) return { stdout: "abc\n", stderr: "", code: 0, killed: false };
      return { stdout: `${lines.join("\0")}\0`, stderr: "", code: 0, killed: false };
    },
    readFile: async () => ({ hash: "abcd", partial: false, size: 4, bytesRead: 4 }),
  });
  const snapshot = await observer.capture("/repo");
  assert.equal(snapshot.files.length, LIMITS.gitMaxFiles);
  assert.equal(snapshot.totalFiles, total);
  assert.equal(snapshot.filesDropped, total - LIMITS.gitMaxFiles);
  assert.equal(snapshot.complete, false);
  assert.match(snapshot.reason ?? "", /省略/);
});

test("Git 单文件字节预算标记 partial", async () => {
  const observer = new GitObserver({
    exec: async (_command, args) => {
      if (args.includes("--is-inside-work-tree")) return { stdout: "true\n", stderr: "", code: 0, killed: false };
      if (args.includes("--show-toplevel")) return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
      if (args.includes("--abbrev-ref")) return { stdout: "main\n", stderr: "", code: 0, killed: false };
      if (args.includes("HEAD")) return { stdout: "abc\n", stderr: "", code: 0, killed: false };
      return { stdout: "?? huge.bin\0", stderr: "", code: 0, killed: false };
    },
    readFile: async (_path, maxBytes) => ({ hash: "ffff", partial: true, size: maxBytes + 1, bytesRead: maxBytes }),
  });
  const snapshot = await observer.capture("/repo");
  assert.equal(snapshot.files[0]?.fingerprintPartial, true);
  assert.equal(snapshot.complete, false);
});

test("hashFile 精确等于预算时不标 partial，超过才标，消失则诚实降级", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pto-hash-"));
  const exact = join(dir, "exact.bin");
  const over = join(dir, "over.bin");
  writeFileSync(exact, Buffer.alloc(8, 1));
  writeFileSync(over, Buffer.alloc(9, 1));
  const exactHash = await hashFile(exact, 8);
  assert.equal(exactHash.partial, false);
  assert.equal(exactHash.missing, undefined);
  assert.equal(exactHash.size, 8);
  assert.equal(exactHash.bytesRead, 8);
  const overHash = await hashFile(over, 8);
  assert.equal(overHash.partial, true);
  assert.equal(overHash.size, 9);
  assert.equal(overHash.bytesRead, 8);
  const missing = await hashFile(join(dir, "gone.bin"), 8);
  assert.equal(missing.missing, true);
  assert.equal(missing.partial, false);
  rmSync(dir, { recursive: true, force: true });
});

function gitMockOk(stdout: string): ExecResult {
  return { stdout, stderr: "", code: 0, killed: false };
}

test("unborn HEAD 仍采集 status，不把整张快照判失败", async () => {
  const cwd = await initRepo("unborn");
  writeFileSync(join(cwd, "a.txt"), "hi\n");
  const snapshot = await new GitObserver().capture(cwd);
  assert.equal(snapshot.head, undefined);
  assert.ok(snapshot.files.some((file) => file.path === "a.txt" && file.untracked));
  assert.equal(snapshot.files.length > 0, true);
  assert.doesNotMatch(snapshot.reason ?? "", /不是 Git 仓库/);
});

test("rev-parse 中途超时停止后续命令，不把错误当完整 unknown", async () => {
  const calls: string[] = [];
  const observer = new GitObserver({
    exec: async (_command, args) => {
      calls.push(args.join(" "));
      if (args.includes("--is-inside-work-tree")) return gitMockOk("true\n");
      if (args.includes("--show-toplevel")) return { stdout: "", stderr: "killed", code: null, killed: true };
      return gitMockOk("should-not-run");
    },
  });
  const snapshot = await observer.capture("/repo");
  assert.equal(snapshot.complete, false);
  assert.match(snapshot.reason ?? "", /超时/);
  assert.equal(snapshot.files.length, 0);
  assert.equal(calls.some((item) => item.includes("status")), false);
  assert.equal(calls.some((item) => item.includes("--abbrev-ref")), false);
});

test("HEAD 非 unborn 失败时仍采集 status，并返回不完整原因", async () => {
  const observer = new GitObserver({
    exec: async (_command, args) => {
      if (args.includes("--is-inside-work-tree")) return gitMockOk("true\n");
      if (args.includes("--show-toplevel")) return gitMockOk("/repo\n");
      if (args.includes("--abbrev-ref")) return gitMockOk("main\n");
      if (args.includes("HEAD") && !args.includes("--abbrev-ref")) {
        return { stdout: "", stderr: "permission denied", code: 128, killed: false };
      }
      return { stdout: "?? a.txt\0", stderr: "", code: 0, killed: false };
    },
    readFile: async () => ({ hash: "abcd", partial: false, size: 4 }),
  });
  const snapshot = await observer.capture("/repo");
  assert.equal(snapshot.complete, false);
  assert.match(snapshot.reason ?? "", /permission denied/);
  assert.equal(snapshot.head, undefined);
  assert.equal(snapshot.branch, "main");
  assert.equal(snapshot.files[0]?.path, "a.txt");
});

test("缓存命中的 Git 快照带 fromCache，不伪装实时", async () => {
  let now = 1_000;
  const observer = new GitObserver({
    now: () => now,
    exec: async (_command, args) => {
      if (args.includes("--is-inside-work-tree")) return gitMockOk("true\n");
      if (args.includes("--show-toplevel")) return gitMockOk("/repo\n");
      if (args.includes("--abbrev-ref")) return gitMockOk("main\n");
      if (args.includes("HEAD")) return gitMockOk("abc\n");
      return gitMockOk("");
    },
  });
  const live = await observer.capture("/repo");
  assert.equal(live.fromCache, undefined);
  now = 1_500;
  const cached = await observer.captureCached("/repo");
  assert.equal(cached.fromCache, true);
  assert.equal(cached.ts, live.ts);
});

test("真实仓库中 modified 恢复干净不归类为删除", async () => {
  const cwd = await initRepo("restored");
  writeFileSync(join(cwd, "tracked.ts"), "v1\n");
  await git(cwd, ["add", "tracked.ts"]);
  await git(cwd, ["commit", "-m", "init"]);
  writeFileSync(join(cwd, "tracked.ts"), "v2\n");
  const observer = new GitObserver();
  const baseline = await observer.capture(cwd);
  await git(cwd, ["checkout", "--", "tracked.ts"]);
  const current = await observer.capture(cwd);
  const diffs = diffSnapshots(baseline, current);
  const entry = diffs.find((item) => item.path === "tracked.ts");
  assert.equal(entry?.kind, "no-longer-changed");
  assert.notEqual(entry?.kind, "deleted");
});

test("Git 总预算按 bytesRead 累加，超大文件 partial 后仍可读后续文件", async () => {
  const hugeSize = 100 * 1024 * 1024;
  const observer = new GitObserver({
    exec: async (_command, args) => {
      if (args.includes("--is-inside-work-tree")) return gitMockOk("true\n");
      if (args.includes("--show-toplevel")) return gitMockOk("/repo\n");
      if (args.includes("--abbrev-ref")) return gitMockOk("main\n");
      if (args.includes("HEAD")) return gitMockOk("abc\n");
      return gitMockOk("?? huge.bin\0?? small.txt\0");
    },
    readFile: async (absolutePath, maxBytes) => {
      if (absolutePath.endsWith("huge.bin")) {
        return { hash: "aaaa", partial: true, size: hugeSize, bytesRead: Math.min(maxBytes, LIMITS.gitMaxFileBytes) };
      }
      return { hash: "bbbb", partial: false, size: 4, bytesRead: 4 };
    },
  });
  const snapshot = await observer.capture("/repo");
  assert.equal(snapshot.files.find((file) => file.path === "huge.bin")?.fingerprintPartial, true);
  assert.equal(snapshot.files.find((file) => file.path === "small.txt")?.fingerprint, "bbbb");
  assert.equal(snapshot.files.find((file) => file.path === "small.txt")?.fingerprintPartial, false);
});

test("git status stdout 截断时快照不完整", async () => {
  const observer = new GitObserver({
    exec: async (_command, args) => {
      if (args.includes("--is-inside-work-tree")) return gitMockOk("true\n");
      if (args.includes("--show-toplevel")) return gitMockOk("/repo\n");
      if (args.includes("--abbrev-ref")) return gitMockOk("main\n");
      if (args.includes("HEAD")) return gitMockOk("abc\n");
      return { stdout: "?? a.txt\0", stderr: "", code: 0, killed: false, stdoutTruncated: true };
    },
    readFile: async () => ({ hash: "abcd", partial: false, size: 4, bytesRead: 4 }),
  });
  const snapshot = await observer.capture("/repo");
  assert.equal(snapshot.statusOutputTruncated, true);
  assert.equal(snapshot.complete, false);
  assert.match(snapshot.reason ?? "", /截断/);
});
