import { LIMITS } from "./constants.ts";
import { HELP_TEXT } from "./command-parser.ts";
import { shortId } from "./ids.ts";
import { shouldObserveProcesses } from "./process.ts";
import type { FileDiffEntry, ProcessSnapshot, TaskSnapshot, TaskState, WorkspaceSnapshot } from "./types.ts";

const STATE_ZH: Record<TaskState, string> = {
  starting: "正在启动",
  "model-running": "模型处理中",
  "tool-running": "工具执行中",
  "waiting-user": "等待用户",
  retrying: "正在重试",
  compacting: "正在压缩上下文",
  settled: "已结束",
  failed: "失败",
  aborted: "已中止",
  unknown: "未知",
};

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return rem ? `${min} 分 ${rem} 秒` : `${min} 分`;
  const hour = Math.floor(min / 60);
  return `${hour} 小时 ${min % 60} 分`;
}

export function formatHelp(): string {
  return HELP_TEXT;
}

export function formatSummary(
  task: TaskSnapshot | undefined,
  extras?: { files?: FileDiffEntry[]; workspace?: WorkspaceSnapshot; processes?: ProcessSnapshot },
): string {
  if (!task) return "当前没有可观察的任务。";
  const now = Date.now();
  const elapsed = formatDuration((task.endedAt ?? now) - task.startedAt);
  const lines = [
    "【观察事实】",
    `状态：${STATE_ZH[task.state]}`,
    `任务 ID：${shortId(task.id)}    Session：${task.sessionId.slice(0, 8)}`,
    `来源：${sourceZh(task.source)}    开始：${formatClock(task.startedAt)}    已运行：${elapsed}`,
    `观测完整性：${task.completeness === "complete" ? "完整" : "不完整"}`,
  ];
  if (task.completenessReasons.length > 0) {
    lines.push(`原因：${task.completenessReasons.join("；")}`);
  }
  lines.push(...formatDropHints(task));
  if (task.promptSummary) lines.push(`摘要：${task.promptSummary}`);
  if (task.sourceSummaries && task.sourceSummaries.length > 1) {
    lines.push(`批次来源：${task.sourceSummaries.join(" | ")}`);
  }
  if (task.executionSegments.length > 0) {
    lines.push("执行区段：");
    for (const segment of task.executionSegments) {
      const run = `Run ${shortId(segment.runId)}`;
      const span = segment.endedAt ? formatDuration(segment.endedAt - segment.startedAt) : "进行中";
      lines.push(`  - ${run} / ${shortId(segment.id)}（${span}）证据：${segment.boundaryEvidence}`);
    }
  }
  const tools = task.activeTools.slice(0, LIMITS.maxActiveToolsShown);
  if (tools.length > 0) {
    lines.push("活跃工具：");
    for (const tool of tools) {
      lines.push(`  - ${tool.toolName}  ${shortId(tool.toolCallId)}  ${formatDuration(now - tool.startedAt)}`);
      if (tool.argsSummary) lines.push(`    ${tool.argsSummary}`);
    }
    if (task.activeTools.length > tools.length) {
      lines.push(`  另有 ${task.activeTools.length - tools.length} 个活跃工具未展开`);
    }
  } else if (task.state === "model-running") {
    lines.push("当前活动：模型处理中");
  }
  const files = extras?.files ?? [];
  const changed = files.filter((file) => file.kind !== "baseline-unchanged");
  if (extras?.workspace) {
    const age = Math.max(0, now - extras.workspace.ts);
    const ageBits = [`${formatDuration(age)}前`];
    if (extras.workspace.fromCache) ageBits.push("缓存", "非实时");
    lines.push(`工作区快照：${formatClock(extras.workspace.ts)}（${ageBits.join("，")}）`);
    lines.push(...formatWorkspaceFileCounts(extras.workspace));
  }
  if (extras?.workspace && !extras.workspace.complete && extras.workspace.reason) {
    lines.push(`工作区：${extras.workspace.reason}`);
  } else if (changed.length > 0) {
    const shown = changed.slice(0, LIMITS.maxWorkspaceFilesShown);
    lines.push(`工作区变化（任务运行期间观察到，不能证明由当前 Agent 修改）：${changed.length} 个`);
    for (const file of shown) {
      lines.push(`  - ${fileKindZh(file.kind)}  ${file.path}`);
    }
  }
  if (extras?.processes) {
    lines.push(...formatProcessBlock(extras.processes));
  }
  const recent = keyEvents(task).slice(-LIMITS.defaultTimelineShow);
  if (recent.length > 0) {
    lines.push("最近活动：");
    for (const event of recent) {
      lines.push(`  - ${formatClock(event.ts)}  ${event.summary}`);
    }
    const hidden = Math.max(0, task.timeline.length - recent.length) + task.timelineDropped;
    if (hidden > 0) lines.push(`  另有 ${hidden} 条未展开或已淘汰`);
  }
  if (task.endReason === "continued-by-follow-up") {
    lines.push("结束原因：已被后续 follow-up 任务接续，不是独立的 agent_settled。");
  }
  lines.push("数据限制：时间线、文本和指纹均有上限；未知信息不会被编造。");
  return lines.join("\n");
}

export function formatTimeline(task: TaskSnapshot | undefined): string {
  if (!task) return "当前没有可观察的任务。";
  const events = task.timeline.slice(-LIMITS.detailedTimelineShow);
  const lines = [
    "【观察事实 / 时间线】",
    `任务 ${shortId(task.id)}    状态：${STATE_ZH[task.state]}`,
  ];
  if (task.timelineDropped > 0) {
    lines.push(`已淘汰最早 ${task.timelineDropped} 条事件（容量 ${LIMITS.timelineCapacity}）。`);
  }
  lines.push(...formatDropHints(task));
  if (task.timeline.length > events.length) {
    lines.push(`未展开 ${task.timeline.length - events.length} 条较早事件。`);
  }
  for (const event of events) {
    const extra = event.toolCallId ? `  tool=${shortId(event.toolCallId)}` : "";
    lines.push(`${formatClock(event.ts)}  ${event.summary}${extra}`);
    if (event.detail) lines.push(`    ${event.detail}`);
  }
  return lines.join("\n");
}

export function formatFiles(
  task: TaskSnapshot | undefined,
  diffs: FileDiffEntry[],
  current?: WorkspaceSnapshot,
): string {
  if (!task) return "当前没有可观察的任务。";
  const lines = ["【工作区事实】", "措辞仅表示任务运行期间观察到的变化，不能证明由当前 Agent 修改。"];
  if (!task.baseline && task.baselinePending) {
    lines.push("基线仍在采集。以下不能使用“自任务开始以来”的确定表述。");
  } else if (!task.baseline) {
    lines.push(`基线不可用：${current?.reason ?? "未知"}`);
  } else {
    const window = `观察窗口：基线 ${formatClock(task.baseline.ts)} → 当前 ${formatClock(current?.ts ?? Date.now())}`;
    lines.push(task.baseline.complete ? window : `${window}（基线不完整：${task.baseline.reason ?? "未知"}）`);
    lines.push(`仓库：${task.baseline.repoRoot ?? "未知"}  分支：${task.baseline.branch ?? "未知"}  HEAD：${task.baseline.head?.slice(0, 8) ?? "未知"}`);
  }
  if (current && !current.complete && current.reason) lines.push(`当前快照：${current.reason}`);
  lines.push(...formatWorkspaceFileCounts(current));
  const groups: Array<[string, FileDiffEntry["kind"][]]> = [
    ["基线已有且指纹未变", ["baseline-unchanged"]],
    ["基线已有且内容进一步变化", ["baseline-further-changed"]],
    ["运行期间新出现或状态改变", ["appeared", "status-changed"]],
    ["当前不再报告为变化（可能已恢复干净或已提交，不能证明删除）", ["no-longer-changed"]],
    ["当前快照证明的删除", ["deleted"]],
    ["运行期间重命名", ["renamed"]],
  ];
  for (const [title, kinds] of groups) {
    const items = diffs.filter((item) => kinds.includes(item.kind));
    lines.push(`${title}：${items.length}`);
    for (const item of items.slice(0, LIMITS.maxWorkspaceFilesShown)) {
      const rec = item.after ?? item.before;
      const extra = item.kind === "deleted"
        ? `  (${deletionLabel(rec)})`
        : item.kind === "renamed" && rec?.renamedFrom
          ? `  (${rec.renamedFrom} → ${item.path}${gitFlags(rec)})`
          : rec?.status
            ? `  (${rec.status}${gitFlags(rec)})`
            : "";
      lines.push(`  - ${item.path}${extra}`);
    }
  }
  return lines.join("\n");
}

export function formatHistory(items: TaskSnapshot[]): string {
  if (items.length === 0) return "当前 Session 没有已结束的历史任务。";
  const lines = ["【历史任务】最近 3 条，1 为最近结束。"];
  items.forEach((task, index) => {
    lines.push(
      `${index + 1}. ${STATE_ZH[task.state]}  ${shortId(task.id)}  ${formatClock(task.startedAt)}  ${task.promptSummary ?? "（无摘要）"}`,
    );
  });
  return lines.join("\n");
}

export function formatAnalyze(text: string, meta?: { usage?: string; error?: string }): string {
  const lines = ["【AI 推断】以下内容不是观测事实，仅供参考。"];
  if (meta?.error) {
    lines.push(`分析失败：${meta.error}`);
    return lines.join("\n");
  }
  lines.push(text);
  if (meta?.usage) lines.push(`额外调用：${meta.usage}`);
  return lines.join("\n");
}

export function formatProcessBlock(snapshot: ProcessSnapshot): string[] {
  if (!snapshot.complete) return [`候选进程：${snapshot.reason ?? "未知"}`];
  const reliable = snapshot.candidates.filter((item) => item.confidence === "high" || item.confidence === "medium");
  const shown = reliable.slice(0, LIMITS.maxProcessCandidatesShown);
  if (shown.length === 0) {
    return ["候选进程：未发现存活的可靠候选（工具可能仍在运行，或候选已退出）。"];
  }
  const lines = ["候选进程（事实：PID/父子关系；归属带可信度）："];
  for (const item of shown) {
    lines.push(
      `  - PID ${item.pid}  PPID ${item.ppid}  存活=${item.alive ? "是" : "否"}  后代=${item.descendantOfPi ? "是" : "否"}  可信度=${confidenceZh(item.confidence)}`,
    );
    lines.push(`    ${item.command}`);
    if (item.evidence.length > 0) lines.push(`    证据：${item.evidence.join("；")}`);
  }
  return lines;
}

export function includeProcesses(task: TaskSnapshot): boolean {
  return shouldObserveProcesses(task.activeTools);
}

function keyEvents(task: TaskSnapshot): TaskSnapshot["timeline"] {
  return task.timeline.filter((event) =>
    [
      "task-start",
      "task-end",
      "steering",
      "followup-queued",
      "followup-delivered",
      "tool-start",
      "tool-end",
      "retry",
      "compaction",
      "abort",
      "settled",
      "partial",
    ].includes(event.kind)
  );
}

function sourceZh(source: TaskSnapshot["source"]): string {
  switch (source) {
    case "interactive":
      return "interactive";
    case "rpc":
      return "rpc";
    case "extension":
      return "extension";
    case "follow-up":
      return "follow-up";
    default:
      return "unknown";
  }
}

function gitFlags(file: FileDiffEntry["after"] | FileDiffEntry["before"]): string {
  if (!file) return "";
  const flags: string[] = [];
  if (file.staged) flags.push("staged");
  if (file.unstaged) flags.push("unstaged");
  if (file.untracked) flags.push("untracked");
  return flags.length > 0 ? ` ${flags.join("/")}` : "";
}

function deletionLabel(file: FileDiffEntry["after"] | FileDiffEntry["before"]): string {
  if (!file) return "删除";
  if (file.staged && file.unstaged) return "staged+unstaged 删除";
  if (file.staged) return "staged 删除";
  if (file.unstaged) return "unstaged 删除";
  return "删除";
}

function fileKindZh(kind: FileDiffEntry["kind"]): string {
  switch (kind) {
    case "baseline-unchanged":
      return "基线未变";
    case "baseline-further-changed":
      return "进一步变化";
    case "appeared":
      return "新出现";
    case "deleted":
      return "删除";
    case "no-longer-changed":
      return "当前不再报告为变化";
    case "renamed":
      return "重命名";
    case "status-changed":
      return "状态变化";
    default:
      return "当前";
  }
}

function confidenceZh(value: string): string {
  switch (value) {
    case "high":
      return "高";
    case "medium":
      return "中";
    case "low":
      return "低";
    default:
      return "未知";
  }
}

function formatDropHints(task: TaskSnapshot): string[] {
  const lines: string[] = [];
  if (task.finishedToolsDropped > 0) {
    lines.push(`已结束工具：已淘汰最早 ${task.finishedToolsDropped} 条（容量 ${LIMITS.finishedToolsCapacity}）。`);
  }
  if (task.activeToolsDropped > 0) {
    lines.push(`活跃工具：已省略 ${task.activeToolsDropped} 个未保存记录（容量 ${LIMITS.activeToolsCapacity}）。`);
  }
  if (task.executionSegmentsDropped > 0) {
    lines.push(`执行区段：已淘汰最早 ${task.executionSegmentsDropped} 条（容量 ${LIMITS.executionSegmentsCapacity}）。`);
  }
  if (task.sourceSummariesDropped > 0) {
    lines.push(`批次来源：已淘汰最早 ${task.sourceSummariesDropped} 条（容量 ${LIMITS.sourceSummariesCapacity}）。`);
  }
  if (task.pendingInputsDropped > 0) {
    lines.push(`输入队列：已淘汰 ${task.pendingInputsDropped} 条（容量 ${LIMITS.pendingInputCapacity}）。`);
  }
  return lines;
}

function formatWorkspaceFileCounts(snapshot?: WorkspaceSnapshot): string[] {
  if (!snapshot) return [];
  const lines: string[] = [];
  const total = snapshot.totalFiles ?? snapshot.files.length;
  const dropped = snapshot.filesDropped ?? 0;
  if (dropped > 0 || snapshot.statusOutputTruncated || (snapshot.totalFiles != null && snapshot.totalFiles !== snapshot.files.length)) {
    lines.push(`文件记录：保留 ${snapshot.files.length} / 共 ${total}，省略 ${dropped}`);
  }
  if (snapshot.statusOutputTruncated) {
    lines.push("git status 输出被截断，文件列表可能不完整");
  }
  return lines;
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}
