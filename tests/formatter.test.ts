import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatAnalyze,
  formatFiles,
  formatHistory,
  formatProcessBlock,
  formatSummary,
  formatTimeline,
} from "../src/formatter.ts";
import { fixtureSnapshot } from "./helpers.ts";
import type { FileDiffEntry, ProcessSnapshot } from "../src/types.ts";

test("摘要使用中文状态且不把内部枚举直接当说明", () => {
  const text = formatSummary(fixtureSnapshot({ state: "tool-running" }));
  assert.match(text, /【观察事实】/);
  assert.match(text, /工具执行中/);
  assert.doesNotMatch(text, /^tool-running$/m);
  assert.match(text, /不能证明由当前 Agent 修改|数据限制/);
});

test("follow-up 接续结束原因单独说明", () => {
  const text = formatSummary(fixtureSnapshot({
    state: "settled",
    endReason: "continued-by-follow-up",
    endedAt: 2_000,
  }));
  assert.match(text, /已被后续 follow-up 任务接续/);
  assert.doesNotMatch(text, /伪装/);
});

test("摘要标明工作区快照时间与缓存年龄，不伪装实时", () => {
  const ts = Date.now() - 2500;
  const text = formatSummary(fixtureSnapshot(), {
    workspace: {
      ts,
      complete: true,
      files: [],
      startedAt: ts,
      fromCache: true,
    },
  });
  assert.match(text, /工作区快照：/);
  assert.match(text, /缓存/);
  assert.match(text, /非实时/);
});

test("时间线保留工具 ID 并标注淘汰", () => {
  const text = formatTimeline(fixtureSnapshot({
    timelineDropped: 12,
    timeline: Array.from({ length: 70 }, (_, index) => ({
      ts: 1_000 + index,
      kind: "tool-end" as const,
      summary: `事件 ${index}`,
      toolCallId: `call-${index}`,
    })),
  }));
  assert.match(text, /【观察事实 \/ 时间线】/);
  assert.match(text, /已淘汰最早 12 条/);
  assert.match(text, /未展开/);
});

test("files 区分基线/进一步变化/当前，且不归因 Agent", () => {
  const diffs: FileDiffEntry[] = [
    { path: "kept.ts", kind: "baseline-unchanged", after: { path: "kept.ts", status: " M", staged: false, unstaged: true, untracked: false } },
    { path: "dirty.ts", kind: "baseline-further-changed", after: { path: "dirty.ts", status: " M", staged: false, unstaged: true, untracked: false } },
    { path: "new.ts", kind: "appeared", after: { path: "new.ts", status: "??", staged: false, unstaged: false, untracked: true } },
    { path: "gone.ts", kind: "deleted", before: { path: "gone.ts", status: " D", staged: false, unstaged: true, untracked: false } },
  ];
  const text = formatFiles(fixtureSnapshot({
    baseline: {
      ts: 1_000,
      complete: true,
      files: [],
      startedAt: 1_000,
      repoRoot: "/ws",
      branch: "main",
      head: "abcdef123",
    },
  }), diffs, { ts: 2_000, complete: true, files: [], startedAt: 2_000 });
  assert.match(text, /【工作区事实】/);
  assert.match(text, /不能证明由当前 Agent 修改/);
  assert.match(text, /基线已有且指纹未变：1/);
  assert.match(text, /基线已有且内容进一步变化：1/);
  assert.match(text, /untracked/);
  assert.match(text, /当前快照证明的删除：1/);
});

test("files 明确区分 staged/unstaged 删除与 rename，不归入笼统 status-changed", () => {
  const diffs: FileDiffEntry[] = [
    {
      path: "gone-unstaged.ts",
      kind: "deleted",
      after: { path: "gone-unstaged.ts", status: " D", staged: false, unstaged: true, untracked: false },
    },
    {
      path: "gone-staged.ts",
      kind: "deleted",
      after: { path: "gone-staged.ts", status: "D ", staged: true, unstaged: false, untracked: false },
    },
    {
      path: "renamed.ts",
      kind: "renamed",
      after: { path: "renamed.ts", status: "R ", staged: true, unstaged: false, untracked: false, renamedFrom: "old.ts" },
    },
  ];
  const text = formatFiles(fixtureSnapshot({
    baseline: { ts: 1, complete: true, files: [], startedAt: 1 },
  }), diffs, { ts: 2, complete: true, files: [], startedAt: 2 });
  assert.match(text, /unstaged 删除/);
  assert.match(text, /staged 删除/);
  assert.match(text, /old\.ts → renamed\.ts/);
  assert.doesNotMatch(text, /status-changed/);
});

test("files 对 no-longer-changed 不声称删除", () => {
  const diffs: FileDiffEntry[] = [
    {
      path: "dirty.ts",
      kind: "no-longer-changed",
      before: { path: "dirty.ts", status: " M", staged: false, unstaged: true, untracked: false },
    },
    {
      path: "new.ts",
      kind: "no-longer-changed",
      before: { path: "new.ts", status: "??", staged: false, unstaged: false, untracked: true },
    },
  ];
  const text = formatFiles(fixtureSnapshot({
    baseline: { ts: 1, complete: true, files: [], startedAt: 1 },
  }), diffs, { ts: 2, complete: true, files: [], startedAt: 2 });
  assert.match(text, /当前不再报告为变化（可能已恢复干净或已提交，不能证明删除）：2/);
  assert.match(text, /当前快照证明的删除：0/);
  assert.doesNotMatch(text, /dirty\.ts.*删除/);
  assert.doesNotMatch(text, /new\.ts.*删除/);
});

test("history 编号 1 为最近结束", () => {
  const text = formatHistory([
    fixtureSnapshot({ id: "task_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", promptSummary: "最近" }),
    fixtureSnapshot({ id: "task_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", promptSummary: "更早" }),
  ]);
  assert.match(text, /1\. .*最近/);
  assert.match(text, /2\. .*更早/);
});

test("analyze 显著标注 AI 推断", () => {
  const text = formatAnalyze("推断阶段：实现中", { usage: "input=10 output=20" });
  assert.match(text, /【AI 推断】/);
  assert.match(text, /不是观测事实/);
  assert.match(text, /额外调用：input=10 output=20/);
});

test("进程区块展示事实与可信度，空候选不误导为文件归属", () => {
  const snapshot: ProcessSnapshot = {
    ts: 1,
    complete: true,
    platform: "darwin",
    rootPid: 1,
    candidates: [{
      pid: 99,
      ppid: 1,
      command: "sleep 8",
      alive: true,
      descendantOfPi: true,
      confidence: "high",
      evidence: ["是 Pi 进程后代"],
    }],
  };
  const text = formatProcessBlock(snapshot).join("\n");
  assert.match(text, /PID 99/);
  assert.match(text, /可信度=高/);
  assert.doesNotMatch(text, /修改了文件/);
  assert.match(formatProcessBlock({ ...snapshot, candidates: [] }).join("\n"), /未发现存活的可靠候选/);
});

test("摘要和时间线展示 pending/segments/source/active 淘汰计数", () => {
  const snapshot = fixtureSnapshot({
    finishedToolsDropped: 12,
    activeToolsDropped: 3,
    executionSegmentsDropped: 4,
    sourceSummariesDropped: 5,
    pendingInputsDropped: 6,
    sourceSummaries: ["a", "b"],
  });
  const summary = formatSummary(snapshot);
  assert.match(summary, /已结束工具：已淘汰最早 12 条/);
  assert.match(summary, /活跃工具：已省略 3 个未保存记录/);
  assert.match(summary, /执行区段：已淘汰最早 4 条/);
  assert.match(summary, /批次来源：已淘汰最早 5 条/);
  assert.match(summary, /输入队列：已淘汰 6 条/);
  const timeline = formatTimeline(snapshot);
  assert.match(timeline, /已结束工具：已淘汰最早 12 条/);
  assert.match(timeline, /执行区段：已淘汰最早 4 条/);
  assert.match(timeline, /批次来源：已淘汰最早 5 条/);
  assert.match(timeline, /输入队列：已淘汰 6 条/);
});

test("files 展示工作区文件总数、省略数和 status 截断", () => {
  const text = formatFiles(fixtureSnapshot({
    baseline: { ts: 1, complete: true, files: [], startedAt: 1 },
  }), [], {
    ts: 2,
    complete: false,
    reason: "工作区文件记录超出容量",
    files: [{ path: "a.ts", status: "??", staged: false, unstaged: false, untracked: true }],
    totalFiles: 900,
    filesDropped: 388,
    statusOutputTruncated: true,
    startedAt: 2,
  });
  assert.match(text, /文件记录：保留 1 \/ 共 900，省略 388/);
  assert.match(text, /git status 输出被截断/);
});
