import { LIMITS } from "./constants.ts";
import type { ObservedTask, TaskSnapshot } from "./types.ts";

export function snapshotTask(task: ObservedTask): TaskSnapshot {
  return {
    id: task.id,
    sessionId: task.sessionId,
    cwd: task.cwd,
    source: task.source,
    promptSummary: task.promptSummary,
    sourceSummaries: task.sourceSummaries ? [...task.sourceSummaries] : undefined,
    acceptedAt: task.acceptedAt,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    endReason: task.endReason,
    state: task.state,
    completeness: task.completeness,
    completenessReasons: [...task.completenessReasons],
    executionSegments: task.executionSegments.map((segment) => ({ ...segment })),
    executionSegmentsDropped: task.executionSegmentsDropped,
    activeTools: [...task.activeTools.values()].map((tool) => ({ ...tool })),
    activeToolsDropped: task.activeToolsDropped,
    finishedTools: task.finishedTools.map((tool) => ({ ...tool })),
    finishedToolsDropped: task.finishedToolsDropped,
    sourceSummariesDropped: task.sourceSummariesDropped,
    pendingInputsDropped: task.pendingInputsDropped,
    timelineDropped: task.timelineDropped,
    timeline: task.timeline.map((event) => ({ ...event })),
    baseline: task.baseline ? { ...task.baseline, files: task.baseline.files.map((file) => ({ ...file })) } : undefined,
    baselinePending: task.baselinePending,
    finalWorkspace: task.finalWorkspace
      ? { ...task.finalWorkspace, files: task.finalWorkspace.files.map((file) => ({ ...file })) }
      : undefined,
    finalWorkspacePending: task.finalWorkspacePending,
    processSnapshot: task.processSnapshot
      ? { ...task.processSnapshot, candidates: task.processSnapshot.candidates.map((item) => ({ ...item })) }
      : undefined,
  };
}

export class HistoryStore {
  current?: ObservedTask;
  history: ObservedTask[] = [];

  archive(task: ObservedTask): ObservedTask | undefined {
    if (this.current?.id === task.id) this.current = undefined;
    this.history.unshift(task);
    let evicted: ObservedTask | undefined;
    while (this.history.length > LIMITS.historyLimit) {
      evicted = this.history.pop();
    }
    return evicted;
  }

  getByHistoryIndex(index: 1 | 2 | 3): ObservedTask | undefined {
    return this.history[index - 1];
  }

  displayTarget(historyIndex?: 1 | 2 | 3): ObservedTask | undefined {
    if (historyIndex) return this.getByHistoryIndex(historyIndex);
    return this.current ?? this.history[0];
  }
}
