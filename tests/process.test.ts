import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProcessObserver,
  descendantPids,
  parseEtimeToMs,
  parsePs,
  scoreCandidates,
  shouldObserveProcesses,
} from "../src/process.ts";
import type { ToolObservation } from "../src/types.ts";

const now = 100_000;
const bash: ToolObservation = {
  toolCallId: "t1",
  toolName: "bash",
  argsSummary: "sleep 8",
  startedAt: now - 10_000,
};

test("read/edit/write 阶段不观察进程，bash 才观察", () => {
  assert.equal(shouldObserveProcesses([{ ...bash, toolName: "read", argsSummary: "file.ts" }]), false);
  assert.equal(shouldObserveProcesses([{ ...bash, toolName: "edit", argsSummary: "file.ts" }]), false);
  assert.equal(shouldObserveProcesses([bash]), true);
});

test("parseEtimeToMs 解析 mm:ss / hh:mm:ss / dd-hh:mm:ss", () => {
  assert.equal(parseEtimeToMs("00:08"), 8_000);
  assert.equal(parseEtimeToMs("01:02:03"), (1 * 3600 + 2 * 60 + 3) * 1000);
  assert.equal(parseEtimeToMs("2-03:04:05"), (2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000);
  assert.equal(parseEtimeToMs("??"), undefined);
  assert.equal(parseEtimeToMs("-"), undefined);
});

test("唯一高可信 Pi 后代候选", () => {
  const stdout = [
    "  1  0 00:01 0.0 1000 init",
    " 10  1 00:01 1.0 2000 pi",
    " 20 10 00:08 0.2 3000 sleep 8",
  ].join("\n");
  const rows = parsePs(stdout);
  const descendants = descendantPids(rows, 10);
  const scored = scoreCandidates(rows, descendants, 10, [bash], now);
  assert.equal(scored[0]?.pid, 20);
  assert.equal(scored[0]?.confidence, "high");
  assert.equal(scored[0]?.descendantOfPi, true);
  assert.ok(scored[0]?.evidence.some((item) => /工具窗口相容/.test(item)));
});

test("旧进程即使命令唯一相似也不得 high", () => {
  const oldTool: ToolObservation = { ...bash, startedAt: now - 3_000 };
  const stdout = [
    " 10  1 00:01 1.0 2000 pi",
    " 20 10 00:08 0.2 3000 sleep 8",
  ].join("\n");
  const scored = scoreCandidates(parsePs(stdout), descendantPids(parsePs(stdout), 10), 10, [oldTool], now);
  assert.equal(scored[0]?.pid, 20);
  assert.notEqual(scored[0]?.confidence, "high");
  assert.ok(scored[0]?.evidence.some((item) => /早于工具开始/.test(item)));
});

test("无法解析启动时间不得 high", () => {
  const stdout = [
    " 10  1 00:01 1.0 2000 pi",
    " 20 10 ?? 0.2 3000 sleep 8",
  ].join("\n");
  const scored = scoreCandidates(parsePs(stdout), descendantPids(parsePs(stdout), 10), 10, [bash], now);
  assert.equal(scored[0]?.pid, 20);
  assert.notEqual(scored[0]?.confidence, "high");
  assert.ok(scored[0]?.evidence.some((item) => /无法解析进程启动时间/.test(item)));
});

test("子进程树含 node worker 时给出中等可信候选", () => {
  const stdout = [
    " 10  1 00:01 1.0 2000 pi",
    " 21 10 00:02 3.0 4000 node --test worker",
  ].join("\n");
  const rows = parsePs(stdout);
  const scored = scoreCandidates(rows, descendantPids(rows, 10), 10, [bash], now);
  assert.equal(scored[0]?.pid, 21);
  assert.equal(scored[0]?.confidence, "medium");
});

test("多个并行 bash 产生多个候选", () => {
  const tools: ToolObservation[] = [
    { ...bash, toolCallId: "a", argsSummary: "sleep 3" },
    { ...bash, toolCallId: "b", argsSummary: "sleep 4" },
  ];
  const stdout = [
    " 10  1 00:01 1.0 2000 pi",
    " 31 10 00:03 0.1 1000 sleep 3",
    " 32 10 00:04 0.1 1000 sleep 4",
  ].join("\n");
  const scored = scoreCandidates(parsePs(stdout), descendantPids(parsePs(stdout), 10), 10, tools, now);
  assert.equal(scored.length, 2);
  assert.ok(scored.every((item) => item.confidence !== "high"));
  assert.ok(scored.every((item) => item.confidence === "medium" || item.confidence === "low"));
});

test("工具仍在运行但候选已退出时快照可为空", async () => {
  const observer = new ProcessObserver({
    platform: "darwin",
    rootPid: 10,
    exec: async () => ({ stdout: " 10  1 00:01 1.0 2000 pi\n", stderr: "", code: 0, killed: false }),
  });
  const snapshot = await observer.snapshot([bash]);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.candidates.length, 0);
});

test("自身 ps 探测进程不得作为当前工具候选", async () => {
  const tool: ToolObservation = { ...bash, argsSummary: "command=sleep 8 timeout=15" };
  const stdout = [
    "  10  1 00:01 1.0 2000 pi",
    "  20 10 00:08 0.2 3000 sleep 8",
    "  21 10 00:00 0.1 1200 ps -axo pid=,ppid=,etime=,pcpu=,rss=,command=",
  ].join("\n");
  const observer = new ProcessObserver({
    platform: "darwin",
    rootPid: 10,
    now: () => now,
    exec: async () => ({ stdout, stderr: "", code: 0, killed: false }),
  });
  const snapshot = await observer.snapshot([tool]);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.candidates.length, 1);
  assert.equal(snapshot.candidates[0]?.pid, 20);
  assert.match(snapshot.candidates[0]?.command ?? "", /sleep 8/);
  assert.doesNotMatch(snapshot.candidates[0]?.command ?? "", /(?:^|\/)ps(?:\s|$)/);
  assert.ok(snapshot.candidates[0]?.confidence === "high" || snapshot.candidates[0]?.confidence === "medium");
  assert.ok(snapshot.candidates[0]?.evidence.some((item) => /Pi 进程后代/.test(item)));
  assert.ok(snapshot.candidates[0]?.evidence.some((item) => /相似|工具窗口相容/.test(item)));

  const linuxRows = parsePs([
    "  10  1 00:01 1.0 2000 pi",
    "  20 10 00:08 0.2 3000 sleep 8",
    "  22 10 00:00 0.1 1100 /bin/ps -eo pid=,ppid=,etime=,pcpu=,rss=,args=",
  ].join("\n"));
  const linuxScored = scoreCandidates(linuxRows, descendantPids(linuxRows, 10), 10, [tool], now);
  assert.equal(linuxScored.length, 1);
  assert.equal(linuxScored[0]?.pid, 20);

  const userPsTool: ToolObservation = { ...bash, argsSummary: "command=ps aux timeout=15" };
  const userPsRows = parsePs([
    "  10  1 00:01 1.0 2000 pi",
    "  30 10 00:02 0.1 900 ps aux",
    "  21 10 00:00 0.1 1200 ps -axo pid=,ppid=,etime=,pcpu=,rss=,command=",
  ].join("\n"));
  const userPsScored = scoreCandidates(userPsRows, descendantPids(userPsRows, 10), 10, [userPsTool], now);
  assert.equal(userPsScored.length, 1);
  assert.equal(userPsScored[0]?.pid, 30);
  assert.match(userPsScored[0]?.command ?? "", /ps aux/);
});

test("低信息 token 如 command/timeout 不得制造候选", () => {
  const tool: ToolObservation = { ...bash, argsSummary: "command=sleep 8 timeout=15" };
  const stdout = [
    "  10  1 00:01 1.0 2000 pi",
    "  20 10 00:08 0.2 3000 sleep 8",
    "  40 10 00:01 0.0 800 helper command timeout",
  ].join("\n");
  const rows = parsePs(stdout);
  const scored = scoreCandidates(rows, descendantPids(rows, 10), 10, [tool], now);
  assert.equal(scored.length, 1);
  assert.equal(scored[0]?.pid, 20);
  assert.ok(scored[0]?.confidence === "high" || scored[0]?.confidence === "medium");
  assert.doesNotMatch(scored.map((item) => item.command).join("\n"), /helper command timeout/);
});

test("无权限、命令缺失、平台不支持和超时均局部降级", async () => {
  const win = await new ProcessObserver({ platform: "win32", rootPid: 1 }).snapshot([bash]);
  assert.equal(win.complete, false);
  assert.match(win.reason ?? "", /暂不支持/);

  const missing = await new ProcessObserver({
    platform: "darwin",
    exec: async () => {
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  }).snapshot([bash]);
  assert.match(missing.reason ?? "", /未找到 ps/);

  const denied = await new ProcessObserver({
    platform: "linux",
    exec: async () => {
      throw new Error("EPERM: not permitted");
    },
  }).snapshot([bash]);
  assert.match(denied.reason ?? "", /无权限/);

  const timeout = await new ProcessObserver({
    platform: "darwin",
    exec: async () => ({ stdout: "", stderr: "", code: null, killed: true }),
  }).snapshot([bash]);
  assert.match(timeout.reason ?? "", /超时/);
});
