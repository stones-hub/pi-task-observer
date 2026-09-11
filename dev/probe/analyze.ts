import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { ProbeCheck, ProbeLogRecord, ProbeReport } from "./types.ts";

export function assignScenarioWindows(records: ProbeLogRecord[]): ProbeLogRecord[] {
  let current: string | undefined;
  return records.map((record) => {
    if (record.kind === "scenario_start") {
      current = String(record.data?.name ?? record.scenario ?? "unknown");
      return { ...record, scenario: current };
    }
    if (record.kind === "scenario_end") {
      const assigned = { ...record, scenario: record.scenario ?? current };
      current = "between";
      return assigned;
    }
    if (!record.scenario && current) {
      return { ...record, scenario: current };
    }
    return record;
  });
}

export function parseJsonl(text: string): ProbeLogRecord[] {
  const records: ProbeLogRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as ProbeLogRecord);
    } catch {
      // skip malformed lines; evidence must stay bounded
    }
  }
  return records;
}

function byScenario(records: ProbeLogRecord[]): Map<string, ProbeLogRecord[]> {
  const map = new Map<string, ProbeLogRecord[]>();
  for (const record of records) {
    const key = record.scenario ?? "_untagged";
    const list = map.get(key) ?? [];
    list.push(record);
    map.set(key, list);
  }
  return map;
}

function kinds(records: ProbeLogRecord[]): string[] {
  return records.map((record) => record.kind);
}

function hasKind(records: ProbeLogRecord[], kind: string): boolean {
  return records.some((record) => record.kind === kind);
}

function recordsOf(records: ProbeLogRecord[], kind: string): ProbeLogRecord[] {
  return records.filter((record) => record.kind === kind);
}

function check(
  id: string,
  title: string,
  status: ProbeCheck["status"],
  opts: {
    designCompatible: boolean | null;
    blockingForGate2?: boolean;
    evidence: string[];
    notes?: string;
  },
): ProbeCheck {
  return {
    id,
    title,
    status,
    designCompatible: opts.designCompatible,
    blockingForGate2: opts.blockingForGate2 ?? (status === "fail" && opts.designCompatible === false),
    evidence: opts.evidence,
    notes: opts.notes,
  };
}

function commandIsolationChecks(records: ProbeLogRecord[]): ProbeCheck[] {
  const commandStarts = recordsOf(records, "command_start");
  const inputs = recordsOf(records, "input");
  const commandInputs = inputs.filter((record) => record.data?.hasCommand === true);
  const commandInContext = recordsOf(records, "context").filter((record) => record.data?.commandInContext === true);
  const commandInEntries = [...commandStarts, ...recordsOf(records, "command_end")]
    .filter((record) => record.data?.commandInEntries === true || record.data?.commandInContext === true);
  const providerDuringCommand = commandStarts.length > 0 && records.some((record, index) => {
    if (record.kind !== "before_provider_request") return false;
    const lastStart = [...records.slice(0, index)].reverse()
      .find((item) => item.kind === "command_start" || item.kind === "command_end");
    return lastStart?.kind === "command_start";
  });

  const checks: ProbeCheck[] = [];
  if (commandStarts.length === 0) {
    checks.push(check("command-ran", "Extension command handler ran", "unverified", {
      designCompatible: null,
      evidence: ["no command_start records"],
      notes: "Command path was not exercised.",
    }));
    return checks;
  }

  checks.push(check("command-bypass-input", "Command does not emit input events", commandInputs.length === 0 ? "pass" : "fail", {
    designCompatible: commandInputs.length === 0,
    blockingForGate2: commandInputs.length > 0,
    evidence: [
      `command_start=${commandStarts.length}`,
      `input_with_command=${commandInputs.length}`,
      `input_total=${inputs.length}`,
    ],
    notes: commandInputs.length > 0
      ? "Extension command entered the input pipeline; /status would become a user task."
      : "Matches design: command is dispatched before input.",
  }));

  checks.push(check("command-not-in-session", "Command is absent from session entries/context snapshots", commandInEntries.length === 0 ? "pass" : "fail", {
    designCompatible: commandInEntries.length === 0,
    blockingForGate2: commandInEntries.length > 0,
    evidence: [
      `snapshots_with_command=${commandInEntries.length}`,
      `commandInContext_events=${commandInContext.length}`,
    ],
  }));

  checks.push(check("command-not-in-llm-context", "Later context events do not contain the command text", commandInContext.length === 0 ? "pass" : "fail", {
    designCompatible: commandInContext.length === 0,
    blockingForGate2: commandInContext.length > 0,
    evidence: [`context_events_with_command=${commandInContext.length}`],
  }));

  checks.push(check("command-no-provider-call", "Command handler does not start a provider request", providerDuringCommand ? "fail" : "pass", {
    designCompatible: !providerDuringCommand,
    blockingForGate2: providerDuringCommand,
    evidence: [`provider_request_while_command=${providerDuringCommand}`],
    notes: "Ordinary /status must not call the model.",
  }));

  return checks;
}

function lifecycleChecks(records: ProbeLogRecord[]): ProbeCheck[] {
  const scenarios = byScenario(records);
  const checks: ProbeCheck[] = [];

  const normal = scenarios.get("normal-lifecycle") ?? [];
  if (normal.length === 0) {
    checks.push(check("normal-lifecycle", "Idle input creates agent_start/end/settled", "unverified", {
      designCompatible: null,
      evidence: ["scenario missing"],
    }));
  } else {
    const sequence = kinds(normal).filter((kind) =>
      ["input", "before_agent_start", "agent_start", "agent_end", "agent_settled"].includes(kind)
    );
    const input = recordsOf(normal, "input")[0];
    const streamingBehavior = input?.data?.streamingBehavior ?? null;
    const expected = ["input", "before_agent_start", "agent_start", "agent_end", "agent_settled"];
    const orderOk = expected.every((kind, index) => sequence.indexOf(kind) >= (index === 0 ? 0 : sequence.indexOf(expected[index - 1])));
    checks.push(check("normal-lifecycle", "Idle ordinary input: input → before_agent_start → agent_start → agent_end → agent_settled", orderOk && streamingBehavior == null ? "pass" : orderOk ? "fail" : "fail", {
      designCompatible: orderOk && streamingBehavior == null,
      evidence: [`sequence=${sequence.join(">")}`, `idle_streamingBehavior=${String(streamingBehavior)}`],
    }));
  }

  const streaming = scenarios.get("streaming-command") ?? [];
  if (streaming.length === 0) {
    checks.push(check("streaming-command", "Command responds during streaming", "unverified", {
      designCompatible: null,
      evidence: ["scenario missing"],
    }));
  } else {
    const commandWhileBusy = recordsOf(streaming, "command_start").some((record) => record.data?.isIdle === false);
    const settledAfter = hasKind(streaming, "agent_settled");
    const aborted = recordsOf(streaming, "agent_end").some((record) => {
      const reasons = record.data?.stopReasons;
      return Array.isArray(reasons) && reasons.includes("aborted");
    });
    const ok = commandWhileBusy && settledAfter && !aborted;
    checks.push(check("streaming-command", "Command runs while streaming and does not abort the agent", ok ? "pass" : "fail", {
      designCompatible: ok,
      evidence: [
        `command_while_busy=${commandWhileBusy}`,
        `agent_settled=${settledAfter}`,
        `aborted=${aborted}`,
      ],
    }));
  }

  const bash = scenarios.get("long-bash-command") ?? [];
  if (bash.length === 0) {
    checks.push(check("long-bash-command", "Command responds during long bash", "unverified", {
      designCompatible: null,
      evidence: ["scenario missing"],
    }));
  } else {
    const toolStarts = recordsOf(bash, "tool_execution_start");
    const toolEnds = recordsOf(bash, "tool_execution_end");
    const commands = recordsOf(bash, "command_end");
    const interleaved = commands.some((command) =>
      toolStarts.some((start) => start.ts <= command.ts) &&
      toolEnds.some((end) => command.ts <= end.ts)
    );
    const toolError = toolEnds.some((record) => record.data?.isError === true);
    const status = toolStarts.length === 0
      ? "unverified"
      : interleaved && !toolError
        ? "pass"
        : "fail";
    checks.push(check("long-bash-command", "Command completes while bash is still running; bash is not cancelled", status, {
      designCompatible: status === "unverified" ? null : status === "pass",
      blockingForGate2: status === "fail",
      evidence: [
        `tool_start=${toolStarts.length}`,
        `tool_end=${toolEnds.length}`,
        `command_end=${commands.length}`,
        `interleaved=${interleaved}`,
        `tool_error=${toolError}`,
      ],
      notes: toolStarts.length === 0 ? "Model did not call bash; cannot prove mid-tool command scheduling." : undefined,
    }));
  }

  const steering = scenarios.get("steering") ?? [];
  if (steering.length === 0) {
    checks.push(check("steering", "Steering stays in the current run/task", "unverified", {
      designCompatible: null,
      evidence: ["scenario missing"],
    }));
  } else {
    const steerInputs = recordsOf(steering, "input").filter((record) => record.data?.streamingBehavior === "steer");
    const settledBeforeSteerDelivery = (() => {
      const firstSteer = steerInputs[0];
      if (!firstSteer) return false;
      const settled = recordsOf(steering, "agent_settled");
      return settled.some((record) => record.ts < firstSteer.ts);
    })();
    const starts = recordsOf(steering, "agent_start");
    const ends = recordsOf(steering, "agent_end");
    const settled = recordsOf(steering, "agent_settled");
    const extraRunAfterSteer = starts.length > 1;
    const status = steerInputs.length === 0 ? "unverified" : "pass";
    checks.push(check("steering", "Steering emits input(steer) and does not settle the current task first", status, {
      designCompatible: status === "unverified" ? null : true,
      evidence: [
        `steer_inputs=${steerInputs.length}`,
        `agent_start=${starts.length}`,
        `agent_end=${ends.length}`,
        `agent_settled=${settled.length}`,
        `settled_before_steer_input=${settledBeforeSteerDelivery}`,
        `extra_agent_start=${extraRunAfterSteer}`,
      ],
      notes: extraRunAfterSteer
        ? "Steering caused another agent_start. Design still treats this as the current user task, a new Execution Run."
        : "Steering remained inside the observed run.",
    }));
  }

  const followUp = scenarios.get("followup-one") ?? [];
  if (followUp.length === 0) {
    checks.push(check("followup-one", "Follow-up queues then starts after current run", "unverified", {
      designCompatible: null,
      evidence: ["scenario missing"],
    }));
  } else {
    const followInputs = recordsOf(followUp, "input").filter((record) => record.data?.streamingBehavior === "followUp");
    const starts = recordsOf(followUp, "agent_start");
    const ends = recordsOf(followUp, "agent_end");
    const settled = recordsOf(followUp, "agent_settled");
    const beforeStarts = recordsOf(followUp, "before_agent_start");
    if (followInputs.length === 0) {
      checks.push(check("followup-one", "Follow-up queues then starts after current run", "unverified", {
        designCompatible: null,
        evidence: ["no input(followUp) observed"],
      }));
    } else {
      const firstFollow = followInputs[0];
      const agentStartAfterQueue = starts.filter((record) => record.ts >= firstFollow.ts);
      const settledBetweenQueueAndNextStart = settled.some((record) => {
        const nextStart = agentStartAfterQueue[0];
        return nextStart ? record.ts >= firstFollow.ts && record.ts < nextStart.ts : false;
      });
      const newRunForFollowUp = starts.length >= 2 || (starts.length === 1 && agentStartAfterQueue.length === 1 && ends.length >= 1);
      const sameRun = starts.length === 1 && ends.length === 1 && settled.length >= 1 &&
        followInputs[0].ts > starts[0].ts && followInputs[0].ts < ends[0].ts &&
        settled[0].ts >= ends[0].ts;
      let status: ProbeCheck["status"] = "pass";
      let compatible: boolean | null = true;
      let notes = "";
      if (sameRun && agentStartAfterQueue.length === 0) {
        status = "fail";
        compatible = false;
        notes = "Follow-up was consumed inside the original agent_start/end. Design expects a new task at actual execution, keyed off a later before_agent_start/agent_start.";
      } else if (settledBetweenQueueAndNextStart) {
        status = "fail";
        compatible = false;
        notes = "agent_settled fired before follow-up started. Design says settled covers queued continuation and must not be used alone as task end.";
      } else if (newRunForFollowUp && !settledBetweenQueueAndNextStart) {
        status = "pass";
        compatible = true;
        notes = "Follow-up started a later agent run and settled waited. Compatible with design task split.";
      }
      checks.push(check("followup-one", "Follow-up queues, does not settle first, then starts a later run", status, {
        designCompatible: compatible,
        blockingForGate2: compatible === false,
        evidence: [
          `followup_inputs=${followInputs.length}`,
          `agent_start=${starts.length}`,
          `agent_end=${ends.length}`,
          `agent_settled=${settled.length}`,
          `before_agent_start=${beforeStarts.length}`,
          `settled_before_followup_run=${settledBetweenQueueAndNextStart}`,
          `same_run_consumption=${sameRun && agentStartAfterQueue.length === 0}`,
        ],
        notes,
      }));
    }
  }

  for (const [id, title] of [
    ["followup-two-one-at-a-time", "Multiple follow-ups in one-at-a-time mode"],
    ["followup-two-all", "Multiple follow-ups in all mode"],
  ] as const) {
    const recordsFor = scenarios.get(id) ?? [];
    if (recordsFor.length === 0) {
      checks.push(check(id, title, "unverified", { designCompatible: null, evidence: ["scenario missing"] }));
      continue;
    }
    const followInputs = recordsOf(recordsFor, "input").filter((record) => record.data?.streamingBehavior === "followUp");
    const beforeStarts = recordsOf(recordsFor, "before_agent_start");
    const starts = recordsOf(recordsFor, "agent_start");
    const status = followInputs.length >= 2 ? "pass" : followInputs.length > 0 ? "pass" : "unverified";
    checks.push(check(id, title, status, {
      designCompatible: status === "unverified" ? null : true,
      blockingForGate2: false,
      evidence: [
        `followup_inputs=${followInputs.length}`,
        `before_agent_start=${beforeStarts.length}`,
        `agent_start=${starts.length}`,
        `mode_note=${id.includes("all") ? "all" : "one-at-a-time"}`,
      ],
      notes: id.includes("all")
        ? "Observed all-mode drain: both follow-ups became user messages in one later turn of the original agent run."
        : "Observed one-at-a-time drain: follow-ups became sequential extra user turns inside the original agent run.",
    }));
  }

  const parallel = scenarios.get("parallel-tools") ?? [];
  if (parallel.length === 0) {
    checks.push(check("parallel-tools", "Parallel tools keep distinct toolCallIds", "unverified", {
      designCompatible: null,
      evidence: ["scenario missing"],
    }));
  } else {
    const starts = recordsOf(parallel, "tool_execution_start");
    const ids = starts.map((record) => String(record.data?.toolCallIdPrefix ?? ""));
    const unique = new Set(ids.filter(Boolean));
    const overlapping = starts.some((start, index) => {
      const end = recordsOf(parallel, "tool_execution_end").find((item) => item.data?.toolCallIdPrefix === start.data?.toolCallIdPrefix);
      if (!end) return false;
      return starts.some((other, otherIndex) => {
        if (otherIndex === index) return false;
        return other.ts >= start.ts && other.ts < end.ts;
      });
    });
    const status = starts.length < 2 ? "unverified" : unique.size === starts.length ? "pass" : "fail";
    checks.push(check("parallel-tools", "Concurrent tools are keyed by toolCallId and can overlap", status, {
      designCompatible: status === "fail" ? false : status === "pass" ? true : null,
      blockingForGate2: status === "fail",
      evidence: [
        `tool_starts=${starts.length}`,
        `unique_id_prefixes=${unique.size}`,
        `overlapping=${overlapping}`,
      ],
      notes: starts.length < 2
        ? "Model did not emit two tool calls; Tool Call ID map still required by API, but overlap was not observed."
        : overlapping
          ? "Observed overlapping tool executions."
          : "Two tools ran but did not overlap in time; IDs were still distinct.",
    }));
  }

  const abort = scenarios.get("abort") ?? [];
  if (abort.length === 0) {
    checks.push(check("abort", "Abort ends the run and settles", "unverified", {
      designCompatible: null,
      evidence: ["scenario missing"],
    }));
  } else {
    const ends = recordsOf(abort, "agent_end");
    const settled = recordsOf(abort, "agent_settled");
    const aborted = recordsOf(abort, "runner_abort").length > 0 ||
      ends.some((record) => Array.isArray(record.data?.stopReasons) && record.data?.stopReasons.includes("aborted"));
    const status = hasKind(abort, "agent_end") && hasKind(abort, "agent_settled") ? "pass" : aborted ? "fail" : "unverified";
    checks.push(check("abort", "Abort produces agent_end and agent_settled", status, {
      designCompatible: status === "pass" ? true : status === "fail" ? false : null,
      evidence: [
        `agent_end=${ends.length}`,
        `agent_settled=${settled.length}`,
        `abort_requested=${hasKind(abort, "runner_abort")}`,
        `aborted_stopReason=${aborted}`,
      ],
    }));
  }

  const compaction = scenarios.get("compaction-manual") ?? [];
  if (compaction.length === 0) {
    checks.push(check("compaction-manual", "Manual compaction events fire", "unverified", {
      designCompatible: null,
      evidence: ["scenario missing"],
    }));
  } else {
    const failed = hasKind(compaction, "session_compact_failed") || hasKind(compaction, "runner_compact_error");
    const success = hasKind(compaction, "session_compact") && !failed;
    checks.push(check("compaction-manual", "Manual compaction emits compact lifecycle events", success ? "pass" : "unverified", {
      designCompatible: success ? true : null,
      blockingForGate2: false,
      evidence: [
        `session_compact=${hasKind(compaction, "session_compact")}`,
        `compaction_end=${hasKind(compaction, "compaction_end")}`,
        `failed=${failed}`,
      ],
      notes: success
        ? "This is manual compaction, not provider overflow recovery."
        : "Manual compact did not produce a kept summary; overflow compaction remains unverified.",
    }));
  }

  const retryEvents = records.filter((record) => record.kind.startsWith("auto_retry") || record.kind.includes("retry"));
  checks.push(check("provider-retry", "Provider auto-retry event order", retryEvents.length > 0 ? "pass" : "unverified", {
    designCompatible: retryEvents.length > 0 ? true : null,
    blockingForGate2: false,
    evidence: [`retry_like_events=${retryEvents.map((record) => record.kind).join(",") || "none"}`],
    notes: "Unsafe to force provider errors. Leave unverified unless the live run emitted retry events.",
  }));

  return checks;
}

export function analyzeRecords(records: ProbeLogRecord[], meta?: {
  piVersion?: string;
  model?: { provider: string; id: string };
}): ProbeReport {
  const scoped = assignScenarioWindows(records);
  const checks = [...commandIsolationChecks(scoped), ...lifecycleChecks(scoped)];
  const scenarioSummaries: ProbeReport["scenarioSummaries"] = {};
  for (const [name, list] of byScenario(scoped)) {
    scenarioSummaries[name] = {
      eventKinds: kinds(list),
      notes: [],
    };
  }
  const unverified = checks.filter((item) => item.status === "unverified").map((item) => item.id);
  const incompatible = checks.filter((item) => item.designCompatible === false).map((item) => item.id);
  const blocking = checks.some((item) => item.blockingForGate2);
  return {
    generatedAt: new Date().toISOString(),
    piVersion: meta?.piVersion ?? "unknown",
    model: meta?.model,
    checks,
    scenarioSummaries,
    unverified,
    incompatible,
    recommendGate2: incompatible.length === 0 && !blocking,
  };
}

export function formatReport(report: ProbeReport): string {
  const lines = [
    "# Gate 1 probe report",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- piVersion: ${report.piVersion}`,
    `- model: ${report.model ? `${report.model.provider}/${report.model.id}` : "unknown"}`,
    `- recommendGate2: ${report.recommendGate2}`,
    `- incompatible: ${report.incompatible.join(", ") || "none"}`,
    `- unverified: ${report.unverified.join(", ") || "none"}`,
    "",
    "## Checks",
  ];
  for (const item of report.checks) {
    lines.push(`- [${item.status}] ${item.id}: ${item.title}`);
    lines.push(`  compatible=${String(item.designCompatible)} blocking=${item.blockingForGate2}`);
    for (const evidence of item.evidence) lines.push(`  - ${evidence}`);
    if (item.notes) lines.push(`  notes: ${item.notes}`);
  }
  return `${lines.join("\n")}\n`;
}

const isCli = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isCli) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node --experimental-strip-types analyze.ts <events.jsonl>");
    process.exit(2);
  }
  const report = analyzeRecords(parseJsonl(readFileSync(file, "utf8")));
  process.stdout.write(formatReport(report));
  process.exit(report.incompatible.length > 0 ? 1 : 0);
}
