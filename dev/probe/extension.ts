import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COMMAND_NAME, COMMAND_TEXT, extractMessageText, sanitizeError, textMeta, truncateText } from "./redact.ts";
import { snapshotSession } from "./snapshot.ts";
import type { ProbeLogRecord } from "./types.ts";

const MAX_LOG_BYTES = 1_500_000;
const DEFAULT_LOG = "/tmp/pi-task-observer-probe/manual.jsonl";

let seq = 0;
let logPath = process.env.PI_TASK_OBSERVER_PROBE_LOG ?? DEFAULT_LOG;
let logDisabled = false;
let currentScenario = process.env.PI_TASK_OBSERVER_PROBE_SCENARIO;
let messageUpdateCount = 0;
let toolUpdateCount = 0;

function writeRecord(source: ProbeLogRecord["source"], kind: string, data?: Record<string, unknown>): void {
  if (logDisabled) return;
  seq += 1;
  const record: ProbeLogRecord = {
    ts: Date.now(),
    seq,
    source,
    kind,
    scenario: currentScenario,
    data,
  };
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    let size = 0;
    try {
      size = statSync(logPath).size;
    } catch {
      size = 0;
    }
    if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
      logDisabled = true;
      appendFileSync(logPath, `${JSON.stringify({
        ts: Date.now(),
        seq: seq + 1,
        source: "extension",
        kind: "log_capped",
        data: { reason: "size_limit" },
      })}\n`);
      return;
    }
    appendFileSync(logPath, line);
  } catch {
    logDisabled = true;
  }
}

function ctxMeta(ctx: ExtensionContext): Record<string, unknown> {
  return {
    isIdle: ctx.isIdle(),
    hasPendingMessages: ctx.hasPendingMessages(),
    signalPresent: Boolean(ctx.signal),
    mode: ctx.mode,
    ...snapshotSession(ctx.sessionManager),
  };
}

function messageMeta(message: unknown): Record<string, unknown> {
  const rec = message && typeof message === "object" ? message as {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
  } : {};
  const text = extractMessageText(message);
  return {
    role: rec.role,
    stopReason: rec.stopReason,
    hasError: Boolean(rec.errorMessage),
    ...textMeta(text),
  };
}

function toolMeta(event: {
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
}): Record<string, unknown> {
  const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {};
  const command = typeof args.command === "string" ? textMeta(args.command) : undefined;
  return {
    toolCallIdPrefix: event.toolCallId?.slice(0, 8),
    toolName: event.toolName,
    command,
    argKeys: Object.keys(args).slice(0, 8),
    isError: event.isError,
  };
}

export default function probeExtension(pi: ExtensionAPI): void {
  writeRecord("extension", "extension_loaded", { command: COMMAND_TEXT });

  pi.registerCommand(COMMAND_NAME, {
    description: "Gate 1 probe status command (not the v0.1 product)",
    handler: async (args, ctx) => {
      const started = Date.now();
      const snapshot = snapshotSession(ctx.sessionManager);
      const usage = ctx.getContextUsage();
      writeRecord("command", "command_start", {
        args: truncateText(args || "", 40, 80),
        ...ctxMeta(ctx),
      });
      const handlerMs = Date.now() - started;
      writeRecord("command", "command_end", {
        args: truncateText(args || "", 40, 80),
        handlerMs,
        contextUsageTokens: usage?.tokens ?? null,
        ...snapshot,
        isIdle: ctx.isIdle(),
        hasPendingMessages: ctx.hasPendingMessages(),
        signalPresent: Boolean(ctx.signal),
      });
      ctx.ui.notify(`probe-status ok idle=${ctx.isIdle()} pending=${ctx.hasPendingMessages()}`, "info");
    },
  });

  pi.on("session_start", (event, ctx) => {
    writeRecord("extension", "session_start", { reason: event.reason, ...ctxMeta(ctx) });
  });
  pi.on("session_shutdown", (event) => {
    writeRecord("extension", "session_shutdown", { reason: event.reason });
  });
  pi.on("input", (event, ctx) => {
    writeRecord("extension", "input", {
      source: event.source,
      streamingBehavior: event.streamingBehavior ?? null,
      ...textMeta(event.text),
      ...ctxMeta(ctx),
    });
  });
  pi.on("before_agent_start", (event, ctx) => {
    writeRecord("extension", "before_agent_start", {
      ...textMeta(event.prompt),
      systemPromptLen: event.systemPrompt.length,
      ...ctxMeta(ctx),
    });
  });
  pi.on("agent_start", (_event, ctx) => {
    writeRecord("extension", "agent_start", ctxMeta(ctx));
  });
  pi.on("agent_end", (event, ctx) => {
    const messages = Array.isArray(event.messages) ? event.messages : [];
    writeRecord("extension", "agent_end", {
      messageCount: messages.length,
      roles: messages.map((message) => (message as { role?: string }).role).slice(0, 12),
      stopReasons: messages
        .map((message) => (message as { stopReason?: string }).stopReason)
        .filter(Boolean)
        .slice(0, 8),
      ...ctxMeta(ctx),
    });
  });
  pi.on("agent_settled", (_event, ctx) => {
    writeRecord("extension", "agent_settled", ctxMeta(ctx));
  });
  pi.on("turn_start", (event, ctx) => {
    writeRecord("extension", "turn_start", { turnIndex: event.turnIndex, ...ctxMeta(ctx) });
  });
  pi.on("turn_end", (event, ctx) => {
    writeRecord("extension", "turn_end", {
      turnIndex: event.turnIndex,
      toolResultCount: event.toolResults?.length ?? 0,
      ...ctxMeta(ctx),
    });
  });
  pi.on("message_start", (event) => {
    messageUpdateCount = 0;
    writeRecord("extension", "message_start", messageMeta(event.message));
  });
  pi.on("message_update", () => {
    messageUpdateCount += 1;
  });
  pi.on("message_end", (event) => {
    writeRecord("extension", "message_end", {
      updateCount: messageUpdateCount,
      ...messageMeta(event.message),
    });
    messageUpdateCount = 0;
  });
  pi.on("tool_execution_start", (event, ctx) => {
    toolUpdateCount = 0;
    writeRecord("extension", "tool_execution_start", { ...toolMeta(event), ...ctxMeta(ctx) });
  });
  pi.on("tool_execution_update", () => {
    toolUpdateCount += 1;
  });
  pi.on("tool_execution_end", (event, ctx) => {
    writeRecord("extension", "tool_execution_end", {
      updateCount: toolUpdateCount,
      ...toolMeta(event),
      ...ctxMeta(ctx),
    });
    toolUpdateCount = 0;
  });
  pi.on("tool_call", (event) => {
    writeRecord("extension", "tool_call", toolMeta(event));
  });
  pi.on("tool_result", (event) => {
    writeRecord("extension", "tool_result", {
      toolCallIdPrefix: event.toolCallId?.slice(0, 8),
      toolName: event.toolName,
      isError: event.isError,
      contentChars: Array.isArray(event.content)
        ? event.content.reduce((sum, item) => {
          return sum + (item && (item as { type?: string }).type === "text"
            ? String((item as { text?: string }).text ?? "").length
            : 0);
        }, 0)
        : 0,
    });
  });
  pi.on("context", (event) => {
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const texts = messages.map((message) => extractMessageText(message));
    writeRecord("extension", "context", {
      messageCount: messages.length,
      roles: messages.map((message) => (message as { role?: string }).role).slice(0, 20),
      commandInContext: texts.some((text) => text.includes(COMMAND_TEXT)),
      totalChars: texts.reduce((sum, text) => sum + text.length, 0),
    });
  });
  pi.on("before_provider_request", () => {
    writeRecord("extension", "before_provider_request", {});
  });
  pi.on("after_provider_response", (event) => {
    writeRecord("extension", "after_provider_response", { status: event.status });
  });
  pi.on("session_before_compact", (event) => {
    writeRecord("extension", "session_before_compact", {
      reason: event.reason,
      willRetry: event.willRetry,
    });
  });
  pi.on("session_compact", (event) => {
    writeRecord("extension", "session_compact", {
      reason: event.reason,
      willRetry: event.willRetry,
      fromExtension: event.fromExtension,
    });
  });
  pi.on("session_compact_failed", (event) => {
    writeRecord("extension", "session_compact_failed", {
      reason: event.reason,
      willRetry: event.willRetry,
      aborted: event.aborted,
      error: event.errorMessage ? truncateText(event.errorMessage) : undefined,
    });
  });
  pi.on("user_bash", (event) => {
    writeRecord("extension", "user_bash", {
      excludeFromContext: event.excludeFromContext,
      ...textMeta(event.command),
    });
  });

  pi.on("session_shutdown", () => {
    writeRecord("extension", "probe_shutdown", { error: sanitizeError("ok") });
  });
}
