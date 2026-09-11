import type { TaskSnapshot } from "../src/types.ts";

export function fixtureSnapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: "task_11111111-1111-1111-1111-111111111111",
    sessionId: "session-abc",
    cwd: "/tmp/workspace",
    source: "interactive",
    promptSummary: "实现观察器",
    startedAt: 1_000,
    state: "model-running",
    completeness: "complete",
    completenessReasons: [],
    executionSegments: [
      {
        id: "seg_22222222-2222-2222-2222-222222222222",
        runId: "run_33333333-3333-3333-3333-333333333333",
        startedAt: 1_000,
        boundaryEvidence: "agent_start",
      },
    ],
    executionSegmentsDropped: 0,
    activeTools: [],
    activeToolsDropped: 0,
    finishedTools: [],
    finishedToolsDropped: 0,
    sourceSummariesDropped: 0,
    pendingInputsDropped: 0,
    timelineDropped: 0,
    timeline: [
      { ts: 1_000, kind: "task-start", summary: "任务开始" },
      { ts: 1_100, kind: "tool-start", summary: "bash 开始", toolCallId: "tool-1" },
    ],
    ...overrides,
  };
}
