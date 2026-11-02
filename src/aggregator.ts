import { CAPACITY_REASONS, LIMITS } from "./constants.ts";
import { HistoryStore, snapshotTask } from "./history.ts";
import { createId } from "./ids.ts";
import { boundText, fingerprint, summarize } from "./redactor.ts";
import { RingBuffer } from "./ring-buffer.ts";
import type {
  Completeness,
  ExecutionSegment,
  InputSource,
  ObservedTask,
  PendingInput,
  TaskEndReason,
  TaskSnapshot,
  TaskState,
  TimelineEvent,
  TimelineKind,
  ToolObservation,
} from "./types.ts";

export interface AggregatorOptions {
  now?: () => number;
  onTaskCreated?: (task: ObservedTask) => void;
  onTaskArchived?: (task: ObservedTask) => void;
}

interface TurnBuffer {
  turnIndex?: number;
  userTexts: string[];
}

export class TaskAggregator {
  readonly store = new HistoryStore();
  private readonly now: () => number;
  private readonly onTaskCreated?: (task: ObservedTask) => void;
  private readonly onTaskArchived?: (task: ObservedTask) => void;
  sessionId = "unknown";
  cwd = "";
  private pendingNormals: PendingInput[] = [];
  private pendingSteers: PendingInput[] = [];
  private pendingFollowUps: PendingInput[] = [];
  private currentRunId?: string;
  private originalUserConsumed = false;
  private startedWithoutPrompt = false;
  private turn = newTurn();
  private toolsById = new Map<string, { taskId: string; tool: ToolObservation }>();
  private idle = true;
  private buffers = new Map<string, RingBuffer<TimelineEvent>>();
  private lastStopReasons: string[] = [];
  private ownCustomExpected = 0;
  private ownCustomOpen = 0;
  private pendingDroppedUnassigned = 0;
  private droppedToolById = new Map<string, string>();
  private droppedToolOrder: string[] = [];

  constructor(options: AggregatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.onTaskCreated = options.onTaskCreated;
    this.onTaskArchived = options.onTaskArchived;
  }

  resetSession(sessionId: string, cwd: string, reason: string, running: boolean): void {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.pendingNormals = [];
    this.pendingSteers = [];
    this.pendingFollowUps = [];
    this.currentRunId = undefined;
    this.originalUserConsumed = false;
    this.startedWithoutPrompt = false;
    this.turn = newTurn();
    this.toolsById.clear();
    this.idle = !running;
    this.buffers.clear();
    this.lastStopReasons = [];
    this.ownCustomExpected = 0;
    this.ownCustomOpen = 0;
    this.pendingDroppedUnassigned = 0;
    this.droppedToolById.clear();
    this.droppedToolOrder = [];
    this.store.current = undefined;
    this.store.history = [];
    if (running) {
      const task = this.createTask({
        source: "unknown",
        summary: undefined,
        completeness: "partial",
        reason: `session_start(${reason}) 时 Agent 已在运行，观测不完整`,
      });
      this.markPartial(task, "中途加载，缺少完整起点");
    }
  }

  onInput(text: string, source: InputSource, streamingBehavior?: "steer" | "followUp"): void {
    const pending = this.toPending(text, source, streamingBehavior);
    if (streamingBehavior === "steer") {
      this.enqueuePending(this.pendingSteers, pending);
      this.pushTimeline(this.store.current, "steering", `steering：${pending.summary}`);
      return;
    }
    if (streamingBehavior === "followUp") {
      this.enqueuePending(this.pendingFollowUps, pending);
      this.pushTimeline(this.store.current, "followup-queued", `follow-up 已入队：${pending.summary}`);
      return;
    }
    this.enqueuePending(this.pendingNormals, pending);
  }

  onBeforeAgentStart(prompt: unknown): void {
    this.startedWithoutPrompt = false;
    if (this.store.current) return;
    // custom message triggerTurn 等启动不带普通 prompt：不匹配、不消费 pending，交 agent_start 兜底。
    if (typeof prompt !== "string") {
      this.startedWithoutPrompt = true;
      return;
    }
    const fp = fingerprint(prompt);
    const matched = this.takePending(this.pendingNormals, fp);
    this.createTask({
      source: matched?.source ?? "unknown",
      summary: matched?.summary ?? summarize(prompt, LIMITS.promptChars, LIMITS.promptBytes),
      acceptedAt: matched?.acceptedAt,
      completeness: matched ? "complete" : "partial",
      reason: matched ? undefined : "无法匹配 pending 普通输入，已建立部分观测任务",
    });
  }

  onAgentStart(): void {
    this.idle = false;
    this.flushTurnUsers();
    const continuation = Boolean(this.store.current && this.store.current.executionSegments.length > 0);
    this.currentRunId = createId("run");
    this.turn = newTurn();
    const withoutPrompt = this.startedWithoutPrompt;
    this.startedWithoutPrompt = false;
    // custom 启动不存在原始 user 消息，首条实际交付的 user 消息只能是 steer/follow-up，不得当原始输入消费。
    if (!continuation) this.originalUserConsumed = withoutPrompt;
    if (!this.store.current) {
      this.createTask({
        source: "unknown",
        summary: undefined,
        completeness: "partial",
        reason: withoutPrompt
          ? "before_agent_start 未携带普通 prompt（如 custom message 触发），已用 agent_start 兜底"
          : "缺少 before_agent_start，已用 agent_start 兜底",
      });
    }
    const task = this.store.current;
    if (!task || !this.currentRunId) return;
    if (continuation) {
      this.pushTimeline(task, "retry", "同一任务的新 Execution Run（retry/compaction），未拆成新任务", this.currentRunId);
    }
    this.openSegment(task, this.currentRunId, continuation ? "agent_start（retry/compaction 续跑）" : "agent_start");
    this.pushTimeline(task, "run-start", `Execution Run ${short(this.currentRunId)} 开始`, this.currentRunId);
    this.setState(task, "model-running");
  }

  onAgentEnd(stopReasons: string[] = [], willRetry = false): void {
    const task = this.store.current;
    const runId = this.currentRunId;
    this.lastStopReasons = stopReasons;
    if (task && runId) {
      this.flushTurnUsers();
      this.closeSegment(task, runId, willRetry ? "agent_end（将重试）" : "agent_end");
      this.pushTimeline(task, "run-end", `Execution Run ${short(runId)} 结束`, runId);
      if (willRetry) {
        this.onRetry("底层 Execution Run 将自动重试，未结束用户任务");
      } else if (stopReasons.includes("aborted")) {
        this.pushTimeline(task, "abort", "检测到 abort，等待 agent_settled 确认结束");
      } else if (stopReasons.includes("error")) {
        this.pushTimeline(task, "partial", "底层 run 出现 error，等待 retry 或 agent_settled，未判为任务失败");
      }
    }
    this.currentRunId = undefined;
  }

  onAgentSettled(isIdle: boolean): void {
    this.idle = isIdle;
    const task = this.store.current;
    if (!task) {
      this.pendingFollowUps = [];
      return;
    }
    if (this.pendingFollowUps.length > 0) {
      this.markPartial(task, "agent_settled 时仍有未交付 follow-up，已按未消费处理");
      this.pendingFollowUps = [];
    }
    this.pushTimeline(task, "settled", "agent_settled");
    const reasons = this.lastStopReasons;
    const end: TaskEndReason = reasons.includes("aborted")
      ? "aborted"
      : reasons.includes("error")
        ? "failed"
        : "settled";
    this.finishTask(task, end);
  }

  onTurnStart(turnIndex: number): void {
    this.flushTurnUsers();
    this.turn = { turnIndex, userTexts: [] };
    this.pushTimeline(this.store.current, "turn-start", `turn ${turnIndex} 开始`, this.currentRunId);
  }

  onTurnEnd(turnIndex: number): void {
    this.flushTurnUsers();
    this.pushTimeline(this.store.current, "turn-end", `turn ${turnIndex} 结束`, this.currentRunId);
    this.refreshState();
  }

  onUserMessage(text: string): void {
    this.turn.userTexts.push(boundText(text));
    while (this.turn.userTexts.length > LIMITS.turnUserTextsCapacity) {
      this.turn.userTexts.shift();
      const task = this.store.current;
      if (task) {
        task.pendingInputsDropped += 1;
        this.markPartial(task, CAPACITY_REASONS.turnUserTexts);
      } else {
        this.pendingDroppedUnassigned += 1;
      }
    }
  }

  onAssistantMessage(stopReason?: string): void {
    this.flushTurnUsers();
    if (stopReason === "aborted") {
      if (!this.lastStopReasons.includes("aborted")) this.lastStopReasons.push("aborted");
      const task = this.store.current;
      if (task) {
        this.pushTimeline(task, "abort", "Assistant stopReason=aborted");
      }
    } else {
      this.pushTimeline(this.store.current, "model", "模型输出");
      this.refreshState();
    }
  }

  get timelineBufferCount(): number {
    return this.buffers.size;
  }

  onToolUpdate(toolCallId: string, toolName: string, partialSummary?: string): void {
    const owned = this.toolsById.get(toolCallId);
    if (!owned) {
      if (this.droppedToolById.has(toolCallId)) return;
      return;
    }
    const task = this.findTask(owned.taskId);
    if (!task) return;
    const buffer = this.buffers.get(task.id);
    const last = buffer?.last();
    if (last && last.kind === "tool-update" && last.toolCallId === toolCallId) {
      last.ts = this.now();
      last.summary = `${toolName} 输出更新`;
      last.detail = partialSummary;
      return;
    }
    this.pushTimeline(task, "tool-update", `${toolName} 输出更新`, this.currentRunId, toolCallId, partialSummary);
  }

  onToolStart(toolCallId: string, toolName: string, argsSummary: string): void {
    const task = this.store.current;
    if (!task) return;
    if (
      task.activeTools.size >= LIMITS.activeToolsCapacity
      || this.toolsById.size >= LIMITS.activeToolsCapacity
    ) {
      task.activeToolsDropped += 1;
      this.rememberDroppedTool(toolCallId, task.id);
      this.markPartial(task, CAPACITY_REASONS.activeTools);
      this.pushTimeline(task, "tool-start", `${toolName} 开始（未保存完整记录）`, this.currentRunId, toolCallId, argsSummary);
      this.setState(task, "tool-running");
      return;
    }
    const tool: ToolObservation = {
      toolCallId,
      toolName,
      argsSummary,
      startedAt: this.now(),
    };
    task.activeTools.set(toolCallId, tool);
    this.toolsById.set(toolCallId, { taskId: task.id, tool });
    this.pushTimeline(task, "tool-start", `${toolName} 开始`, this.currentRunId, toolCallId, argsSummary);
    this.setState(task, "tool-running");
  }

  onToolEnd(toolCallId: string, toolName: string, isError: boolean, resultSummary?: string): void {
    const owned = this.toolsById.get(toolCallId);
    if (!owned) {
      const droppedTaskId = this.droppedToolById.get(toolCallId);
      if (droppedTaskId) {
        this.forgetDroppedTool(toolCallId);
        const droppedTask = this.findTask(droppedTaskId);
        if (droppedTask) {
          this.pushTimeline(
            droppedTask,
            "tool-end",
            `${toolName} ${isError ? "失败" : "结束"}（开始时未保存完整记录）`,
            this.currentRunId,
            toolCallId,
            resultSummary,
          );
        }
        return;
      }
      return;
    }
    const task = this.findTask(owned.taskId);
    if (!task) return;
    const current = task.activeTools.get(toolCallId) ?? owned?.tool;
    const ended: ToolObservation = {
      toolCallId,
      toolName: current?.toolName ?? toolName,
      argsSummary: current?.argsSummary ?? "",
      startedAt: current?.startedAt ?? this.now(),
      endedAt: this.now(),
      isError,
      resultSummary,
    };
    task.activeTools.delete(toolCallId);
    task.finishedTools.push(ended);
    this.trimFifo(task.finishedTools, LIMITS.finishedToolsCapacity, () => {
      task.finishedToolsDropped += 1;
      this.markPartial(task, CAPACITY_REASONS.finishedTools);
    });
    this.toolsById.delete(toolCallId);
    this.pushTimeline(
      task,
      "tool-end",
      `${ended.toolName} ${isError ? "失败" : "结束"}`,
      this.currentRunId,
      toolCallId,
      resultSummary,
    );
    this.refreshState();
  }

  onCompaction(kind: "start" | "success" | "failed", reason: string, willRetry?: boolean): void {
    const task = this.store.current;
    if (!task) return;
    if (kind === "start") {
      this.setState(task, "compacting");
      this.pushTimeline(task, "compaction", `compaction 开始 (${reason})`);
      return;
    }
    if (kind === "failed") {
      this.pushTimeline(task, "compaction-failed", `compaction 失败 (${reason})`);
      this.refreshState();
      return;
    }
    this.pushTimeline(task, "compaction", `compaction 完成 (${reason})${willRetry ? "，将重试当前 turn" : ""}`);
    if (willRetry) this.onRetry(`overflow/compaction 将重试当前 turn，仍属当前任务`);
    this.refreshState();
  }

  onRetry(summary: string): void {
    const task = this.store.current;
    if (!task) return;
    this.setState(task, "retrying");
    this.pushTimeline(task, "retry", summary);
  }

  expectOwnCustomUi(): void {
    this.ownCustomExpected += 1;
  }

  onUiPrompt(start: boolean, kind: string, _title?: string): void {
    const task = this.store.current;
    if (kind === "custom") {
      if (start) {
        if (this.ownCustomExpected > 0) {
          this.ownCustomExpected -= 1;
          this.ownCustomOpen += 1;
          return;
        }
      } else if (this.ownCustomOpen > 0) {
        this.ownCustomOpen -= 1;
        return;
      }
    }
    if (!task) return;
    if (start) {
      this.setState(task, "waiting-user");
      this.pushTimeline(task, "ui-wait", `等待用户（${kind}）`);
    } else {
      this.refreshState();
    }
  }

  snapshotCurrent(): TaskSnapshot | undefined {
    return this.store.current ? snapshotTask(this.store.current) : undefined;
  }

  snapshotHistory(): TaskSnapshot[] {
    return this.store.history.map(snapshotTask);
  }

  snapshotTarget(historyIndex?: 1 | 2 | 3): TaskSnapshot | undefined {
    const task = this.store.displayTarget(historyIndex);
    return task ? snapshotTask(task) : undefined;
  }

  private flushTurnUsers(): void {
    const texts = this.turn.userTexts;
    if (texts.length === 0) return;
    this.turn.userTexts = [];
    if (!this.originalUserConsumed) {
      this.originalUserConsumed = true;
      const [first, ...rest] = texts;
      this.consumeOriginal(first);
      if (rest.length > 0) this.deliverUserBatch(rest);
      return;
    }
    this.deliverUserBatch(texts);
  }

  private consumeOriginal(text: string): void {
    const task = this.store.current;
    if (!task) return;
    const fp = fingerprint(text);
    this.takePending(this.pendingNormals, fp);
    if (!task.promptSummary) {
      task.promptSummary = summarize(text, LIMITS.promptChars, LIMITS.promptBytes);
    }
    this.pushTimeline(task, "input", `普通输入：${task.promptSummary ?? ""}`);
  }

  private deliverUserBatch(texts: string[]): void {
    if (texts.length === 0) return;
    const fps = texts.map(fingerprint);
    if (this.matchesQueue(this.pendingSteers, fps)) {
      this.pendingSteers.splice(0, fps.length);
      this.pushTimeline(this.store.current, "steering", `steering 已交付（${texts.length} 条）`);
      return;
    }
    if (this.matchesQueue(this.pendingFollowUps, fps)) {
      const delivered = this.pendingFollowUps.splice(0, fps.length);
      this.splitForFollowUp(delivered);
      return;
    }
    if (this.pendingFollowUps.length > 0) {
      const task = this.store.current;
      if (task) {
        this.markPartial(task, "出现后续 user turn，但无法可靠匹配 pending follow-up，未猜测拆分");
      }
      this.pushTimeline(this.store.current, "partial", "后续 user 消息与 pending follow-up 摘要不一致");
      return;
    }
    this.pushTimeline(this.store.current, "input", `后续用户输入：${summarize(texts.join(" / "), LIMITS.promptChars, LIMITS.promptBytes)}`);
  }

  private splitForFollowUp(delivered: PendingInput[]): void {
    const previous = this.store.current;
    const runId = this.currentRunId;
    if (previous) {
      if (runId) this.closeSegment(previous, runId, "follow-up 实际交付");
      this.pushTimeline(previous, "followup-delivered", "当前任务被后续 follow-up 接续");
      this.finishTask(previous, "continued-by-follow-up");
    }
    const summaries = delivered.map((item) => item.summary).filter(Boolean);
    const next = this.createTask({
      source: "follow-up",
      summary: summaries[0],
      acceptedAt: delivered[0]?.acceptedAt,
      completeness: "complete",
    });
    next.sourceSummaries = summaries;
    this.trimFifo(next.sourceSummaries, LIMITS.sourceSummariesCapacity, () => {
      next.sourceSummariesDropped += 1;
      this.markPartial(next, CAPACITY_REASONS.sourceSummaries);
    });
    this.pushTimeline(next, "followup-delivered", `follow-up 批次交付（${delivered.length} 条）`);
    if (runId) this.openSegment(next, runId, "follow-up 实际交付，复用同一 Execution Run");
    this.setState(next, this.toolsById.size > 0 ? "tool-running" : "model-running");
  }

  private createTask(opts: {
    source: InputSource;
    summary?: string;
    acceptedAt?: number;
    completeness: Completeness;
    reason?: string;
  }): ObservedTask {
    const ts = this.now();
    const task: ObservedTask = {
      id: createId("task"),
      sessionId: this.sessionId,
      cwd: this.cwd,
      source: opts.source,
      promptSummary: opts.summary,
      acceptedAt: opts.acceptedAt ?? ts,
      startedAt: ts,
      state: "starting",
      completeness: opts.completeness,
      completenessReasons: opts.reason ? [opts.reason] : [],
      executionSegments: [],
      executionSegmentsDropped: 0,
      activeTools: new Map(),
      activeToolsDropped: 0,
      finishedTools: [],
      finishedToolsDropped: 0,
      sourceSummariesDropped: 0,
      pendingInputsDropped: 0,
      timelineDropped: 0,
      timeline: [],
    };
    this.buffers.set(task.id, new RingBuffer<TimelineEvent>(LIMITS.timelineCapacity));
    this.store.current = task;
    this.pushTimeline(task, "task-start", "任务开始");
    if (this.pendingDroppedUnassigned > 0) {
      task.pendingInputsDropped += this.pendingDroppedUnassigned;
      this.pendingDroppedUnassigned = 0;
      this.markPartial(task, CAPACITY_REASONS.pendingInputs);
    }
    this.onTaskCreated?.(task);
    return task;
  }

  private finishTask(task: ObservedTask, reason: TaskEndReason): void {
    if (task.endedAt) return;
    task.endedAt = this.now();
    task.endReason = reason;
    if (reason === "settled") this.setState(task, "settled");
    if (reason === "aborted") this.setState(task, "aborted");
    if (reason === "failed") this.setState(task, "failed");
    if (reason === "continued-by-follow-up") this.setState(task, "settled");
    this.pushTimeline(task, "task-end", endLabel(reason));
    this.syncDropped(task);
    this.onTaskArchived?.(task);
    const evicted = this.store.archive(task);
    if (evicted) this.releaseTask(evicted);
  }

  private openSegment(task: ObservedTask, runId: string, evidence: string): void {
    const existing = task.executionSegments.find((segment) => segment.runId === runId && !segment.endedAt);
    if (existing) return;
    const segment: ExecutionSegment = {
      id: createId("seg"),
      runId,
      startedAt: this.now(),
      boundaryEvidence: evidence,
    };
    task.executionSegments.push(segment);
    this.trimFifo(task.executionSegments, LIMITS.executionSegmentsCapacity, () => {
      task.executionSegmentsDropped += 1;
      this.markPartial(task, CAPACITY_REASONS.executionSegments);
    });
    this.pushTimeline(task, "segment-start", `Segment ${short(segment.id)} / Run ${short(runId)}`, runId);
  }

  private closeSegment(task: ObservedTask, runId: string, evidence: string): void {
    const segment = [...task.executionSegments].reverse().find((item) => item.runId === runId && !item.endedAt);
    if (!segment) return;
    segment.endedAt = this.now();
    segment.boundaryEvidence = `${segment.boundaryEvidence}；结束：${evidence}`;
    this.pushTimeline(task, "segment-end", `Segment ${short(segment.id)} 结束`, runId);
  }

  private pushTimeline(
    task: ObservedTask | undefined,
    kind: TimelineKind,
    summary: string,
    runId?: string,
    toolCallId?: string,
    detail?: string,
  ): void {
    if (!task) return;
    const buffer = this.buffers.get(task.id) ?? new RingBuffer<TimelineEvent>(LIMITS.timelineCapacity);
    this.buffers.set(task.id, buffer);
    buffer.push({
      ts: this.now(),
      kind,
      summary,
      detail,
      toolCallId,
      runId,
    });
    task.timeline = buffer.toArray();
    task.timelineDropped = buffer.dropped;
  }

  private setState(task: ObservedTask, state: TaskState): void {
    task.state = state;
  }

  private refreshState(): void {
    const task = this.store.current;
    if (!task || task.endedAt) return;
    if (task.state === "aborted" || task.state === "failed" || task.state === "compacting" || task.state === "retrying") {
      return;
    }
    const hasTools = [...this.toolsById.values()].some((item) => item.taskId === task.id) || task.activeTools.size > 0;
    this.setState(task, hasTools ? "tool-running" : this.idle ? "waiting-user" : "model-running");
  }

  private markPartial(task: ObservedTask, reason: string): void {
    task.completeness = "partial";
    if (task.completenessReasons.includes(reason)) return;
    if (task.completenessReasons.length >= LIMITS.completenessReasonsCapacity) return;
    task.completenessReasons.push(reason);
    this.pushTimeline(task, "partial", reason);
  }

  private toPending(text: string, source: InputSource, streamingBehavior?: "steer" | "followUp"): PendingInput {
    return {
      source: streamingBehavior === "followUp" ? "follow-up" : source,
      streamingBehavior,
      fingerprint: fingerprint(text),
      summary: summarize(text, LIMITS.promptChars, LIMITS.promptBytes) ?? "",
      acceptedAt: this.now(),
    };
  }

  private enqueuePending(queue: PendingInput[], pending: PendingInput): void {
    queue.push(pending);
    this.trimFifo(queue, LIMITS.pendingInputCapacity, () => {
      const task = this.store.current;
      if (task) {
        task.pendingInputsDropped += 1;
        this.markPartial(task, CAPACITY_REASONS.pendingInputs);
      } else {
        this.pendingDroppedUnassigned += 1;
      }
    });
  }

  private trimFifo<T>(items: T[], capacity: number, onDrop: () => void): void {
    while (items.length > capacity) {
      items.shift();
      onDrop();
    }
  }

  private takePending(queue: PendingInput[], fp: string): PendingInput | undefined {
    const index = queue.findIndex((item) => item.fingerprint === fp);
    if (index < 0) return undefined;
    return queue.splice(index, 1)[0];
  }

  private matchesQueue(queue: PendingInput[], fps: string[]): boolean {
    if (fps.length === 0 || queue.length < fps.length) return false;
    return fps.every((fp, index) => queue[index]?.fingerprint === fp);
  }

  private rememberDroppedTool(toolCallId: string, taskId: string): void {
    if (this.droppedToolById.has(toolCallId)) return;
    this.droppedToolById.set(toolCallId, taskId);
    this.droppedToolOrder.push(toolCallId);
    while (this.droppedToolOrder.length > LIMITS.droppedToolIdCapacity) {
      const old = this.droppedToolOrder.shift();
      if (old) this.droppedToolById.delete(old);
    }
  }

  private forgetDroppedTool(toolCallId: string): void {
    this.droppedToolById.delete(toolCallId);
    const index = this.droppedToolOrder.indexOf(toolCallId);
    if (index >= 0) this.droppedToolOrder.splice(index, 1);
  }

  private releaseTask(task: ObservedTask): void {
    this.buffers.delete(task.id);
    for (const [toolCallId, owned] of [...this.toolsById]) {
      if (owned.taskId === task.id) this.toolsById.delete(toolCallId);
    }
    for (const [toolCallId, taskId] of [...this.droppedToolById]) {
      if (taskId === task.id) this.forgetDroppedTool(toolCallId);
    }
  }

  private findTask(id: string): ObservedTask | undefined {
    if (this.store.current?.id === id) return this.store.current;
    return this.store.history.find((task) => task.id === id);
  }

  private syncDropped(task: ObservedTask): void {
    const buffer = this.buffers.get(task.id);
    if (buffer) task.timelineDropped = buffer.dropped;
  }
}

function newTurn(): TurnBuffer {
  return { userTexts: [] };
}

function short(id: string): string {
  const uuid = id.split("_")[1] ?? id;
  return uuid.slice(0, 8);
}

function endLabel(reason: TaskEndReason): string {
  switch (reason) {
    case "continued-by-follow-up":
      return "已被后续任务接续";
    case "aborted":
      return "任务中止";
    case "failed":
      return "任务失败";
    case "settled":
      return "任务结束";
    default:
      return "任务结束（未知原因）";
  }
}
