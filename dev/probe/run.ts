import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { analyzeRecords, formatReport, parseJsonl } from "./analyze.ts";
import { COMMAND_TEXT, sanitizeError, truncateText } from "./redact.ts";
import type { ProbeLogRecord } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = join(here, "extension.ts");

let seq = 10_000;
let currentScenario = "setup";
let logPath = "";

function log(source: ProbeLogRecord["source"], kind: string, data?: Record<string, unknown>): void {
  seq += 1;
  const record: ProbeLogRecord = {
    ts: Date.now(),
    seq,
    source,
    kind,
    scenario: currentScenario,
    data,
  };
  appendFileSync(logPath, `${JSON.stringify(record)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(label: string, predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  if (predicate()) return;
  while (Date.now() - started < timeoutMs) {
    await sleep(40);
    if (predicate()) return;
  }
  throw new Error(`timeout waiting for ${label}`);
}

function pickModel(models: readonly { provider: string; id: string }[]): { provider: string; id: string } | undefined {
  const preferred = [
    ["ai-model-vip", "gpt-5.6"],
    ["openai", "gpt-4.1-mini"],
    ["openai", "gpt-4o-mini"],
  ];
  for (const [provider, id] of preferred) {
    const found = models.find((model) => model.provider === provider && model.id === id);
    if (found) return found;
  }
  return models[0];
}

async function runScenario(name: string, fn: () => Promise<void>): Promise<void> {
  currentScenario = name;
  log("runner", "scenario_start", { name });
  try {
    await fn();
    log("runner", "scenario_end", { name, ok: true });
  } catch (error) {
    log("runner", "scenario_end", { name, ok: false, error: sanitizeError(error) });
  } finally {
    currentScenario = "between";
  }
}

async function main(): Promise<number> {
  const outDir = process.env.PI_TASK_OBSERVER_PROBE_DIR ??
    join("/tmp/pi-task-observer-probe", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(outDir, { recursive: true });
  logPath = join(outDir, "events.jsonl");
  process.env.PI_TASK_OBSERVER_PROBE_LOG = logPath;
  writeFileSync(logPath, "");

  const workspace = mkdtempSync(join(tmpdir(), "pi-task-observer-probe-ws-"));
  writeFileSync(join(workspace, "README.txt"), "probe workspace\n");

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    enableInstallTelemetry: false,
    quietStartup: true,
    followUpMode: "one-at-a-time",
    steeringMode: "one-at-a-time",
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir: getAgentDir(),
    settingsManager,
    additionalExtensionPaths: [extensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "You are a probe helper. Follow the user exactly. Prefer bash when asked. Never print secrets. Keep replies to one short line when no tool is required.",
  });
  await resourceLoader.reload();

  const modelRuntime = await ModelRuntime.create();
  const available = await modelRuntime.getAvailable();
  const chosen = pickModel(available);
  if (!chosen) {
    writeFileSync(join(outDir, "blocked.txt"), "no authenticated model available\n");
    console.error("Gate 1 blocked: no authenticated model.");
    return 2;
  }
  const model = modelRuntime.getModel(chosen.provider, chosen.id) ??
    available.find((item) => item.provider === chosen.provider && item.id === chosen.id);
  if (!model) {
    writeFileSync(join(outDir, "blocked.txt"), "selected model object missing\n");
    return 2;
  }

  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir: getAgentDir(),
    modelRuntime,
    model,
    thinkingLevel: "off",
    tools: ["bash"],
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(workspace),
  });

  const state = {
    streaming: false,
    toolStarts: [] as Array<{ ts: number; id?: string; name?: string }>,
    toolEnds: [] as Array<{ ts: number; id?: string; isError?: boolean }>,
    messageUpdates: 0,
    lastError: "",
  };

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_start") state.streaming = true;
    if (event.type === "agent_end" || event.type === "agent_settled") {
      if (event.type === "agent_settled") state.streaming = false;
    }
    if (event.type === "message_update") {
      state.messageUpdates += 1;
      if (state.messageUpdates === 1 || state.messageUpdates % 20 === 0) {
        log("runner", "message_update_count", { count: state.messageUpdates });
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      state.toolStarts.push({ ts: Date.now(), id: event.toolCallId, name: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      state.toolEnds.push({ ts: Date.now(), id: event.toolCallId, isError: event.isError });
    }
    if (event.type === "auto_retry_start" || event.type === "auto_retry_end" ||
      event.type === "queue_update" || event.type === "compaction_start" || event.type === "compaction_end") {
      const data: Record<string, unknown> = { type: event.type };
      if (event.type === "queue_update") {
        data.steeringCount = event.steering.length;
        data.followUpCount = event.followUp.length;
      }
      if (event.type === "auto_retry_start") {
        data.attempt = event.attempt;
        data.maxAttempts = event.maxAttempts;
        data.error = truncateText(event.errorMessage);
      }
      if (event.type === "compaction_start" || event.type === "compaction_end") {
        data.reason = event.reason;
        if (event.type === "compaction_end") {
          data.aborted = event.aborted;
          data.willRetry = event.willRetry;
        }
      }
      log("runner", event.type, data);
      return;
    }
    if (event.type === "agent_end") {
      log("runner", "session_agent_end", {
        willRetry: event.willRetry,
        messageCount: event.messages.length,
      });
    }
  });

  const resetToolState = (): void => {
    state.toolStarts = [];
    state.toolEnds = [];
    state.messageUpdates = 0;
  };

  try {
    log("runner", "session_created", {
      provider: chosen.provider,
      model: chosen.id,
      workspace: "tmp",
      piVersion: "0.85.1",
    });

    await runScenario("idle-command", async () => {
      await session.prompt(`${COMMAND_TEXT} idle`);
    });

    await runScenario("normal-lifecycle", async () => {
      await session.prompt("Reply with the single word PONG and do not use tools. Marker: PROBE_NORMAL_1");
      await session.waitForIdle();
    });

    await runScenario("streaming-command", async () => {
      resetToolState();
      const pending = session.prompt("Write numbers 1 to 25, each on its own line. Do not use tools. Marker: PROBE_STREAM_1");
      await waitUntil("streaming tokens", () => state.messageUpdates >= 2 || session.isStreaming, 45_000);
      await session.prompt(`${COMMAND_TEXT} during-stream`);
      await pending;
      await session.waitForIdle();
    });

    await runScenario("long-bash-command", async () => {
      resetToolState();
      const pending = session.prompt("Call bash exactly once with command: sleep 8. Do not call other tools. After it finishes, reply DONE. Marker: PROBE_BASH_1");
      await waitUntil("bash start", () => state.toolStarts.length > 0, 60_000);
      await session.prompt(`${COMMAND_TEXT} during-bash`);
      await pending;
      await session.waitForIdle();
    });

    await runScenario("steering", async () => {
      resetToolState();
      session.agent.steeringMode = "one-at-a-time";
      const pending = session.prompt("Call bash exactly once with command: sleep 6. After it finishes, reply WAITING. Marker: PROBE_STEER_BASE");
      await waitUntil("bash start for steer", () => state.toolStarts.length > 0 || session.isStreaming, 60_000);
      await session.prompt("Do not call more tools. Reply with the single word STEERED. Marker: PROBE_STEER_1", {
        streamingBehavior: "steer",
      });
      await pending;
      await session.waitForIdle();
    });

    await runScenario("followup-one", async () => {
      resetToolState();
      session.agent.followUpMode = "one-at-a-time";
      const pending = session.prompt("Call bash exactly once with command: sleep 6. After it finishes, reply BASE. Marker: PROBE_FU_BASE");
      await waitUntil("bash start for follow-up", () => state.toolStarts.length > 0 || session.isStreaming, 60_000);
      await session.prompt("Do not call tools. Reply with the single word FOLLOWED. Marker: PROBE_FU_1", {
        streamingBehavior: "followUp",
      });
      await pending;
      await session.waitForIdle();
    });

    await runScenario("followup-two-one-at-a-time", async () => {
      resetToolState();
      session.agent.followUpMode = "one-at-a-time";
      const pending = session.prompt("Call bash exactly once with command: sleep 6. After it finishes, reply BASE2. Marker: PROBE_FU2_BASE");
      await waitUntil("bash start for two follow-ups", () => state.toolStarts.length > 0 || session.isStreaming, 60_000);
      await session.prompt("Do not call tools. Reply FU_A. Marker: PROBE_FU_A", { streamingBehavior: "followUp" });
      await session.prompt("Do not call tools. Reply FU_B. Marker: PROBE_FU_B", { streamingBehavior: "followUp" });
      await pending;
      await session.waitForIdle();
    });

    await runScenario("followup-two-all", async () => {
      resetToolState();
      session.agent.followUpMode = "all";
      const pending = session.prompt("Call bash exactly once with command: sleep 6. After it finishes, reply BASE3. Marker: PROBE_FUALL_BASE");
      await waitUntil("bash start for follow-up all", () => state.toolStarts.length > 0 || session.isStreaming, 60_000);
      await session.prompt("Do not call tools. Reply ALL_A. Marker: PROBE_ALL_A", { streamingBehavior: "followUp" });
      await session.prompt("Do not call tools. Reply ALL_B. Marker: PROBE_ALL_B", { streamingBehavior: "followUp" });
      await pending;
      await session.waitForIdle();
      session.agent.followUpMode = "one-at-a-time";
    });

    await runScenario("parallel-tools", async () => {
      resetToolState();
      await session.prompt("In one assistant turn, emit two bash tool calls together: sleep 3 and sleep 4. Do not call other tools. After both finish, reply PARALLEL. Marker: PROBE_PARALLEL_1");
      await session.waitForIdle();
    });

    await runScenario("abort", async () => {
      resetToolState();
      const pending = session.prompt("Call bash exactly once with command: sleep 30. Marker: PROBE_ABORT_1");
      await waitUntil("bash start for abort", () => state.toolStarts.length > 0 || session.isStreaming, 60_000);
      log("runner", "runner_abort", {});
      await session.abort();
      try {
        await pending;
      } catch (error) {
        log("runner", "abort_pending_error", { error: sanitizeError(error) });
      }
      await session.waitForIdle();
    });

    await runScenario("compaction-manual", async () => {
      try {
        const result = await session.compact("Summarize in one short sentence. Marker: PROBE_COMPACT_1");
        log("runner", "runner_compact_result", {
          compacted: Boolean(result),
          reason: (result as { reason?: string } | undefined)?.reason,
        });
      } catch (error) {
        log("runner", "runner_compact_error", { error: sanitizeError(error) });
      }
      await session.waitForIdle();
    });

    await runScenario("idle-command-after", async () => {
      await session.prompt(`${COMMAND_TEXT} after`);
    });
  } finally {
    unsubscribe();
    session.dispose();
    rmSync(workspace, { recursive: true, force: true });
  }

  const records = parseJsonl(readFileSync(logPath, "utf8"));
  const report = analyzeRecords(records, {
    piVersion: "0.85.1",
    model: { provider: chosen.provider, id: chosen.id },
  });
  const reportText = formatReport(report);
  writeFileSync(join(outDir, "report.md"), reportText);
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`evidence_dir=${outDir}\n`);
  process.stdout.write(reportText);
  if (report.incompatible.length > 0) return 1;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(sanitizeError(error));
    process.exit(1);
  });
