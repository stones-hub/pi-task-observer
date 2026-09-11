import assert from "node:assert/strict";
import { test } from "node:test";
import { RingBuffer } from "../src/ring-buffer.ts";
import { HistoryStore } from "../src/history.ts";
import type { ObservedTask } from "../src/types.ts";

function task(id: string, endedAt: number): ObservedTask {
  return {
    id,
    sessionId: "s",
    cwd: "/tmp",
    source: "interactive",
    startedAt: endedAt - 10,
    endedAt,
    state: "settled",
    completeness: "complete",
    completenessReasons: [],
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
}

test("Ring Buffer 固定容量并记录淘汰数", () => {
  const buffer = new RingBuffer<number>(3);
  for (let i = 0; i < 5; i += 1) buffer.push(i);
  assert.deepEqual(buffer.toArray(), [2, 3, 4]);
  assert.equal(buffer.dropped, 2);
  assert.equal(buffer.length, 3);
});

test("历史最多 3 条，1 为最近结束，当前任务不占名额", () => {
  const store = new HistoryStore();
  store.current = task("live", 0);
  store.archive(task("a", 1));
  store.archive(task("b", 2));
  store.archive(task("c", 3));
  const evicted = store.archive(task("d", 4));
  assert.equal(evicted?.id, "a");
  assert.equal(store.history.length, 3);
  assert.equal(store.getByHistoryIndex(1)?.id, "d");
  assert.equal(store.getByHistoryIndex(2)?.id, "c");
  assert.equal(store.getByHistoryIndex(3)?.id, "b");
  assert.equal(store.history.some((item) => item.id === "a"), false);
  assert.equal(store.displayTarget()?.id, "live");
  store.current = undefined;
  assert.equal(store.displayTarget()?.id, "d");
});
