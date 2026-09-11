import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeRecords } from "../analyze.ts";
import { COMMAND_TEXT } from "../redact.ts";
import type { ProbeLogRecord } from "../types.ts";

function rec(partial: Partial<ProbeLogRecord> & Pick<ProbeLogRecord, "kind">): ProbeLogRecord {
  return {
    ts: partial.ts ?? 1,
    seq: partial.seq ?? 1,
    source: partial.source ?? "extension",
    kind: partial.kind,
    scenario: partial.scenario,
    data: partial.data,
  };
}

test("command isolation fails if the command appears as input", () => {
  const report = analyzeRecords([
    rec({ kind: "command_start", data: { isIdle: true, commandInEntries: false, commandInContext: false } }),
    rec({ kind: "input", data: { hasCommand: true, streamingBehavior: null } }),
    rec({ kind: "command_end", data: { commandInEntries: false, commandInContext: false } }),
  ]);
  const check = report.checks.find((item) => item.id === "command-bypass-input");
  assert.equal(check?.status, "fail");
  assert.equal(check?.designCompatible, false);
  assert.equal(check?.blockingForGate2, true);
  assert.equal(report.recommendGate2, false);
});

test("command isolation passes when command is bypassed", () => {
  const report = analyzeRecords([
    rec({ kind: "command_start", ts: 10, data: { isIdle: true, commandInEntries: false, commandInContext: false } }),
    rec({ kind: "command_end", ts: 11, data: { commandInEntries: false, commandInContext: false } }),
    rec({ kind: "input", ts: 20, data: { hasCommand: false, streamingBehavior: null } }),
    rec({ kind: "context", ts: 21, data: { commandInContext: false } }),
  ]);
  assert.equal(report.checks.find((item) => item.id === "command-bypass-input")?.status, "pass");
  assert.equal(report.checks.find((item) => item.id === "command-not-in-llm-context")?.status, "pass");
});

test("follow-up consumed in the same run is incompatible with the design", () => {
  const report = analyzeRecords([
    rec({ kind: "agent_start", scenario: "followup-one", ts: 1 }),
    rec({
      kind: "input",
      scenario: "followup-one",
      ts: 2,
      data: { streamingBehavior: "followUp", preview: "PROBE_FU_1" },
    }),
    rec({ kind: "agent_end", scenario: "followup-one", ts: 3 }),
    rec({ kind: "agent_settled", scenario: "followup-one", ts: 4 }),
  ]);
  const check = report.checks.find((item) => item.id === "followup-one");
  assert.equal(check?.status, "fail");
  assert.equal(check?.designCompatible, false);
  assert.ok(check?.notes?.includes("inside the original"));
});

test("follow-up that starts a later run without settling first is compatible", () => {
  const report = analyzeRecords([
    rec({ kind: "agent_start", scenario: "followup-one", ts: 1 }),
    rec({ kind: "input", scenario: "followup-one", ts: 2, data: { streamingBehavior: "followUp" } }),
    rec({ kind: "agent_end", scenario: "followup-one", ts: 3 }),
    rec({ kind: "before_agent_start", scenario: "followup-one", ts: 4, data: { hasMarker: true } }),
    rec({ kind: "agent_start", scenario: "followup-one", ts: 5 }),
    rec({ kind: "agent_end", scenario: "followup-one", ts: 6 }),
    rec({ kind: "agent_settled", scenario: "followup-one", ts: 7 }),
  ]);
  const check = report.checks.find((item) => item.id === "followup-one");
  assert.equal(check?.status, "pass");
  assert.equal(check?.designCompatible, true);
});

test("normal lifecycle requires idle input without streamingBehavior", () => {
  const report = analyzeRecords([
    rec({ kind: "input", scenario: "normal-lifecycle", ts: 1, data: { streamingBehavior: null } }),
    rec({ kind: "before_agent_start", scenario: "normal-lifecycle", ts: 2 }),
    rec({ kind: "agent_start", scenario: "normal-lifecycle", ts: 3 }),
    rec({ kind: "agent_end", scenario: "normal-lifecycle", ts: 4 }),
    rec({ kind: "agent_settled", scenario: "normal-lifecycle", ts: 5 }),
  ]);
  assert.equal(report.checks.find((item) => item.id === "normal-lifecycle")?.status, "pass");
});

test("command text helper still identifies the probe command", () => {
  assert.equal(COMMAND_TEXT, "/probe-status");
});

test("untagged extension events inherit the runner scenario window", () => {
  const report = analyzeRecords([
    rec({ kind: "scenario_start", source: "runner", ts: 1, data: { name: "normal-lifecycle" } }),
    rec({ kind: "input", ts: 2, data: { streamingBehavior: null } }),
    rec({ kind: "before_agent_start", ts: 3 }),
    rec({ kind: "agent_start", ts: 4 }),
    rec({ kind: "agent_end", ts: 5 }),
    rec({ kind: "agent_settled", ts: 6 }),
    rec({ kind: "scenario_end", source: "runner", ts: 7, data: { name: "normal-lifecycle", ok: true } }),
  ]);
  assert.equal(report.checks.find((item) => item.id === "normal-lifecycle")?.status, "pass");
});
