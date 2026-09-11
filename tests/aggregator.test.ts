import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPACITY_REASONS, LIMITS } from "../src/constants.ts";
import { formatSummary, formatTimeline } from "../src/formatter.ts";
import { TaskAggregator } from "../src/aggregator.ts";

function startNormal(agg: TaskAggregator, prompt: string, source: "interactive" | "extension" = "interactive"): void {
  agg.onInput(prompt, source);
  agg.onBeforeAgentStart(prompt);
  agg.onAgentStart();
  agg.onTurnStart(0);
  agg.onUserMessage(prompt);
  agg.onAssistantMessage();
  agg.onTurnEnd(0);
}

function deliverUsers(agg: TaskAggregator, turnIndex: number, texts: string[]): void {
  agg.onTurnStart(turnIndex);
  for (const text of texts) agg.onUserMessage(text);
  agg.onAssistantMessage();
  agg.onTurnEnd(turnIndex);
}

test("空闲普通输入创建新任务", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "实现 Gate 2");
  const current = agg.snapshotCurrent();
  assert.ok(current);
  assert.equal(current?.source, "interactive");
  assert.equal(current?.promptSummary, "实现 Gate 2");
  assert.equal(current?.completeness, "complete");
  assert.equal(current?.executionSegments.length, 1);
  assert.equal(agg.snapshotHistory().length, 0);
});

test("Skill/Template 类输入同样创建任务", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "/skill:build", "extension");
  assert.equal(agg.snapshotCurrent()?.source, "extension");
});

test("steering 归入当前任务且不占历史", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "原始任务");
  const id = agg.snapshotCurrent()?.id;
  agg.onInput("改用中文注释", "interactive", "steer");
  deliverUsers(agg, 1, ["改用中文注释"]);
  assert.equal(agg.snapshotCurrent()?.id, id);
  assert.equal(agg.snapshotHistory().length, 0);
  assert.ok(agg.snapshotCurrent()?.timeline.some((event) => event.kind === "steering"));
});

test("follow-up 入队不新建，one-at-a-time 按每次交付分别建任务并共享 Run ID", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "原始任务");
  const original = agg.snapshotCurrent();
  const runId = original?.executionSegments[0]?.runId;
  assert.ok(runId);
  agg.onInput("后续一", "interactive", "followUp");
  agg.onInput("后续二", "interactive", "followUp");
  assert.equal(agg.snapshotCurrent()?.id, original?.id);
  assert.equal(agg.snapshotHistory().length, 0);

  deliverUsers(agg, 1, ["后续一"]);
  const firstFollow = agg.snapshotCurrent();
  assert.notEqual(firstFollow?.id, original?.id);
  assert.equal(firstFollow?.source, "follow-up");
  assert.equal(firstFollow?.executionSegments[0]?.runId, runId);
  assert.equal(agg.snapshotHistory()[0]?.endReason, "continued-by-follow-up");
  assert.equal(agg.snapshotHistory()[0]?.executionSegments[0]?.runId, runId);
  assert.ok(agg.snapshotHistory()[0]?.executionSegments[0]?.endedAt);
  assert.equal(agg.snapshotHistory()[0]?.executionSegments.some((segment) => !segment.endedAt), false);

  deliverUsers(agg, 2, ["后续二"]);
  const secondFollow = agg.snapshotCurrent();
  assert.notEqual(secondFollow?.id, firstFollow?.id);
  assert.equal(secondFollow?.executionSegments[0]?.runId, runId);
  assert.equal(agg.snapshotHistory().length, 2);
  assert.equal(agg.snapshotHistory()[0]?.id, firstFollow?.id);

  agg.onAgentEnd();
  agg.onAgentSettled(true);
  assert.equal(agg.snapshotCurrent(), undefined);
  assert.equal(agg.snapshotHistory().length, 3);
  const allRunIds = agg.snapshotHistory().flatMap((task) => task.executionSegments.map((segment) => segment.runId));
  assert.ok(allRunIds.every((id) => id === runId));
});

test("follow-up all 一次批次建一个任务并保留各条来源", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "原始任务");
  const runId = agg.snapshotCurrent()?.executionSegments[0]?.runId;
  agg.onInput("批次甲", "interactive", "followUp");
  agg.onInput("批次乙", "interactive", "followUp");
  deliverUsers(agg, 1, ["批次甲", "批次乙"]);
  const current = agg.snapshotCurrent();
  assert.equal(current?.source, "follow-up");
  assert.deepEqual(current?.sourceSummaries, ["批次甲", "批次乙"]);
  assert.equal(current?.executionSegments[0]?.runId, runId);
  assert.equal(agg.snapshotHistory().length, 1);
});

test("follow-up 证据不足时标记 partial，不猜测拆分", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "原始任务");
  const id = agg.snapshotCurrent()?.id;
  agg.onInput("真实 follow-up", "interactive", "followUp");
  deliverUsers(agg, 1, ["完全不同的文本"]);
  assert.equal(agg.snapshotCurrent()?.id, id);
  assert.equal(agg.snapshotCurrent()?.completeness, "partial");
  assert.equal(agg.snapshotHistory().length, 0);
  assert.ok(agg.snapshotCurrent()?.completenessReasons.some((reason) => /未猜测拆分/.test(reason)));
});

test("并行工具按 toolCallId 独立，不互相覆盖", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "并行");
  agg.onToolStart("call-a", "bash", "sleep 3");
  agg.onToolStart("call-b", "bash", "sleep 4");
  const current = agg.snapshotCurrent();
  assert.equal(current?.state, "tool-running");
  assert.equal(current?.activeTools.length, 2);
  agg.onToolEnd("call-b", "bash", false, "done b");
  const after = agg.snapshotCurrent();
  assert.equal(after?.activeTools.length, 1);
  assert.equal(after?.activeTools[0]?.toolCallId, "call-a");
  assert.equal(after?.finishedTools[0]?.toolCallId, "call-b");
  agg.onToolUpdate("call-a", "bash", "still running");
  agg.onToolEnd("call-a", "bash", false, "done a");
  assert.equal(agg.snapshotCurrent()?.activeTools.length, 0);
});

test("follow-up 拆分后，仍在运行的工具结束归原任务", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "原始任务");
  agg.onToolStart("call-a", "bash", "sleep 8");
  agg.onInput("后续", "interactive", "followUp");
  deliverUsers(agg, 1, ["后续"]);
  agg.onToolEnd("call-a", "bash", false, "done");
  assert.equal(agg.snapshotHistory()[0]?.finishedTools[0]?.toolCallId, "call-a");
  assert.equal(agg.snapshotCurrent()?.finishedTools.length, 0);
});

test("retry/compaction 不拆成新用户任务，但建立新 Run/Segment", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "原始任务");
  const id = agg.snapshotCurrent()?.id;
  const firstRun = agg.snapshotCurrent()?.executionSegments[0]?.runId;
  agg.onAgentEnd();
  agg.onCompaction("start", "overflow", true);
  agg.onCompaction("success", "overflow", true);
  agg.onAgentStart();
  const current = agg.snapshotCurrent();
  assert.equal(current?.id, id);
  assert.equal(current?.executionSegments.length, 2);
  assert.notEqual(current?.executionSegments[1]?.runId, firstRun);
  assert.ok(current?.timeline.some((event) => event.kind === "retry"));
  assert.equal(agg.snapshotHistory().length, 0);
});

test("abort 进入历史且不伪装为独立成功结束", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "将被中止");
  agg.onAssistantMessage("aborted");
  agg.onAgentEnd(["aborted"]);
  agg.onAgentSettled(true);
  assert.equal(agg.snapshotCurrent(), undefined);
  assert.equal(agg.snapshotHistory()[0]?.endReason, "aborted");
  assert.equal(agg.snapshotHistory()[0]?.state, "aborted");
});

test("正常 settled 归档；第 4 条淘汰最早记录", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  for (let i = 1; i <= 4; i += 1) {
    startNormal(agg, `任务 ${i}`);
    agg.onAgentEnd();
    agg.onAgentSettled(true);
  }
  const history = agg.snapshotHistory();
  assert.equal(history.length, 3);
  assert.equal(history[0]?.promptSummary, "任务 4");
  assert.equal(history[2]?.promptSummary, "任务 2");
  assert.equal(history.some((item) => item.promptSummary === "任务 1"), false);
});

test("reload 中途加载标记部分观测；Session 替换不混淆状态", () => {
  const first = new TaskAggregator();
  first.resetSession("old", "/ws", "startup", false);
  startNormal(first, "旧会话任务");
  first.resetSession("new", "/ws", "new", false);
  assert.equal(first.snapshotCurrent(), undefined);
  assert.equal(first.snapshotHistory().length, 0);

  const reloaded = new TaskAggregator();
  reloaded.resetSession("new", "/ws", "reload", true);
  assert.equal(reloaded.snapshotCurrent()?.completeness, "partial");
  assert.ok(reloaded.snapshotCurrent()?.completenessReasons.some((reason) => /中途加载/.test(reason)));
});

test("时间线容量淘汰被记录", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "长任务");
  for (let i = 0; i < 300; i += 1) {
    agg.onToolStart(`id-${i}`, "read", `file ${i}`);
    agg.onToolEnd(`id-${i}`, "read", false, "ok");
  }
  const current = agg.snapshotCurrent();
  assert.equal(current?.timeline.length, 256);
  assert.ok((current?.timelineDropped ?? 0) > 0);
});

test("/status 自身 custom UI 不写入 waiting-user，其他扩展 UI 仍观察", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "观察中");
  const id = agg.snapshotCurrent()?.id;
  agg.expectOwnCustomUi();
  agg.onUiPrompt(true, "custom");
  assert.equal(agg.snapshotCurrent()?.id, id);
  assert.notEqual(agg.snapshotCurrent()?.state, "waiting-user");
  assert.equal(agg.snapshotCurrent()?.timeline.some((event) => event.kind === "ui-wait"), false);
  agg.onUiPrompt(false, "custom");
  agg.onUiPrompt(true, "select", "其他扩展");
  assert.equal(agg.snapshotCurrent()?.state, "waiting-user");
  assert.ok(agg.snapshotCurrent()?.timeline.some((event) => event.kind === "ui-wait"));
});

test("并发自身 custom 与延迟的 ui_prompt_end 不会污染时间线", async () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "观察中");
  agg.expectOwnCustomUi();
  agg.expectOwnCustomUi();
  agg.onUiPrompt(true, "custom");
  await Promise.resolve();
  agg.onUiPrompt(true, "custom");
  agg.onUiPrompt(false, "custom");
  await Promise.resolve();
  agg.onUiPrompt(false, "custom");
  assert.equal(agg.snapshotCurrent()?.timeline.some((event) => event.kind === "ui-wait"), false);
  agg.onUiPrompt(true, "confirm");
  assert.ok(agg.snapshotCurrent()?.timeline.some((event) => /confirm/.test(event.summary)));
});

test("agent_end error 且 willRetry 时不判失败、不归档", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "可能重试");
  const id = agg.snapshotCurrent()?.id;
  agg.onAgentEnd(["error"], true);
  assert.equal(agg.snapshotCurrent()?.id, id);
  assert.notEqual(agg.snapshotCurrent()?.state, "failed");
  assert.equal(agg.snapshotHistory().length, 0);
  assert.ok(agg.snapshotCurrent()?.timeline.some((event) => event.kind === "retry"));
  agg.onAgentStart();
  assert.equal(agg.snapshotCurrent()?.id, id);
  assert.equal(agg.snapshotCurrent()?.executionSegments.length, 2);
});

test("agent_end error 无 willRetry 时等到 settled 才失败归档", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "将失败");
  agg.onAgentEnd(["error"]);
  assert.equal(agg.snapshotCurrent()?.state === "failed", false);
  assert.equal(agg.snapshotHistory().length, 0);
  agg.onAgentSettled(true);
  assert.equal(agg.snapshotHistory()[0]?.endReason, "failed");
});

test("数千已结束工具 FIFO 截断并只记录一次容量提示", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "长工具流");
  for (let i = 0; i < 2_000; i += 1) {
    agg.onToolStart(`id-${i}`, "read", `file ${i}`);
    agg.onToolEnd(`id-${i}`, "read", false, "ok");
  }
  const current = agg.snapshotCurrent();
  assert.equal(current?.finishedTools.length, LIMITS.finishedToolsCapacity);
  assert.equal(current?.finishedToolsDropped, 2_000 - LIMITS.finishedToolsCapacity);
  assert.equal(current?.finishedTools[0]?.toolCallId, `id-${2_000 - LIMITS.finishedToolsCapacity}`);
  assert.equal(current?.completeness, "partial");
  assert.equal(current?.completenessReasons.filter((reason) => reason === CAPACITY_REASONS.finishedTools).length, 1);
  assert.ok((current?.completenessReasons.length ?? 0) <= LIMITS.completenessReasonsCapacity);
  assert.match(formatTimeline(current), /已结束工具：已淘汰最早/);
  assert.match(formatSummary(current), /已结束工具：已淘汰最早/);
});

test("steering/follow-up/普通输入队列有固定容量", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "容量");
  for (let i = 0; i < 500; i += 1) {
    agg.onInput(`steer-${i}`, "interactive", "steer");
    agg.onInput(`fu-${i}`, "interactive", "followUp");
    agg.onInput(`n-${i}`, "interactive");
  }
  const current = agg.snapshotCurrent();
  assert.equal(current?.pendingInputsDropped, 500 - LIMITS.pendingInputCapacity + 500 - LIMITS.pendingInputCapacity + 500 - LIMITS.pendingInputCapacity);
  assert.ok(current?.completenessReasons.includes(CAPACITY_REASONS.pendingInputs));
  assert.equal(current?.completenessReasons.filter((reason) => reason === CAPACITY_REASONS.pendingInputs).length, 1);
});

test("retry segment 超出容量 FIFO 淘汰", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "重试很多");
  for (let i = 0; i < 50; i += 1) {
    agg.onAgentEnd();
    agg.onAgentStart();
  }
  const current = agg.snapshotCurrent();
  assert.equal(current?.executionSegments.length, LIMITS.executionSegmentsCapacity);
  assert.equal(current?.executionSegmentsDropped, 51 - LIMITS.executionSegmentsCapacity);
  assert.ok(current?.completenessReasons.includes(CAPACITY_REASONS.executionSegments));
});

test("follow-up all 大批次来源摘要截断且 turn 用户消息有上限", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "原始任务");
  const total = 200;
  for (let i = 0; i < total; i += 1) {
    agg.onInput(`batch-${i}`, "interactive", "followUp");
  }
  const kept = Array.from({ length: LIMITS.pendingInputCapacity }, (_, index) => `batch-${total - LIMITS.pendingInputCapacity + index}`);
  deliverUsers(agg, 1, kept);
  const current = agg.snapshotCurrent();
  assert.equal(current?.source, "follow-up");
  assert.equal(current?.sourceSummaries?.length, LIMITS.sourceSummariesCapacity);
  assert.equal(current?.sourceSummariesDropped, LIMITS.pendingInputCapacity - LIMITS.sourceSummariesCapacity);
  assert.deepEqual(current?.sourceSummaries?.[0], `batch-${total - LIMITS.sourceSummariesCapacity}`);
  assert.ok(current?.completenessReasons.includes(CAPACITY_REASONS.sourceSummaries));
});

test("历史当前+3 的已结束工具总量受每任务上限约束", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  for (let taskIndex = 1; taskIndex <= 4; taskIndex += 1) {
    startNormal(agg, `任务 ${taskIndex}`);
    for (let i = 0; i < 300; i += 1) {
      agg.onToolStart(`t${taskIndex}-${i}`, "read", "f");
      agg.onToolEnd(`t${taskIndex}-${i}`, "read", false, "ok");
    }
    agg.onAgentEnd();
    agg.onAgentSettled(true);
  }
  const history = agg.snapshotHistory();
  assert.equal(history.length, 3);
  assert.equal(agg.snapshotCurrent(), undefined);
  for (const item of history) {
    assert.ok(item.finishedTools.length <= LIMITS.finishedToolsCapacity);
  }
});

test("长 session 淘汰历史后 RingBuffer 不超过当前+3", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  for (let i = 1; i <= 200; i += 1) {
    startNormal(agg, `任务 ${i}`);
    assert.ok(agg.timelineBufferCount <= LIMITS.historyLimit + 1);
    agg.onAgentEnd();
    agg.onAgentSettled(true);
  }
  assert.equal(agg.snapshotHistory().length, 3);
  assert.equal(agg.snapshotCurrent(), undefined);
  assert.equal(agg.timelineBufferCount, 3);
});

test("数千并行 tool_start 有界，tool_end 不误归 follow-up", () => {
  const agg = new TaskAggregator();
  agg.resetSession("sess-1", "/ws", "startup", false);
  startNormal(agg, "并行洪峰");
  const originalId = agg.snapshotCurrent()?.id;
  for (let i = 0; i < 2_000; i += 1) {
    agg.onToolStart(`flood-${i}`, "bash", `sleep ${i}`);
  }
  const during = agg.snapshotCurrent();
  assert.equal(during?.activeTools.length, LIMITS.activeToolsCapacity);
  assert.equal(during?.activeToolsDropped, 2_000 - LIMITS.activeToolsCapacity);
  assert.ok(during?.completenessReasons.includes(CAPACITY_REASONS.activeTools));

  agg.onInput("后续", "interactive", "followUp");
  deliverUsers(agg, 1, ["后续"]);
  const followId = agg.snapshotCurrent()?.id;
  assert.notEqual(followId, originalId);

  for (let i = 0; i < 2_000; i += 1) {
    agg.onToolEnd(`flood-${i}`, "bash", false, "done");
  }
  const original = agg.snapshotHistory()[0];
  const follow = agg.snapshotCurrent();
  assert.equal(original?.id, originalId);
  assert.equal(original?.finishedTools.length, LIMITS.activeToolsCapacity);
  assert.equal(original?.finishedTools.some((tool) => tool.toolCallId === "flood-0"), true);
  assert.equal(original?.finishedTools.some((tool) => tool.toolCallId === "flood-1999"), false);
  assert.equal(follow?.finishedTools.length, 0);
  assert.equal(follow?.activeTools.length, 0);
  assert.equal(follow?.finishedTools.some((tool) => tool.toolCallId.startsWith("flood-")), false);
});
