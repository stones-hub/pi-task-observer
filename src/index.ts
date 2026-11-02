import { BorderedLoader, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { TaskAggregator } from "./aggregator.ts";
import { Analyzer } from "./analyzer.ts";
import { COMMAND_NAME, LIMITS } from "./constants.ts";
import { debugLog, resetDebugLog } from "./debug.ts";
import { showText, willShowCustomUi } from "./display.ts";
import { parseStatusArgs } from "./command-parser.ts";
import {
  formatAnalyze,
  formatFiles,
  formatHelp,
  formatHistory,
  formatSummary,
  formatTimeline,
} from "./formatter.ts";
import { GitObserver } from "./git.ts";
import { ProcessObserver } from "./process.ts";
import { extractMessageText, stableStringify, summarize, truncateText } from "./redactor.ts";
import { loadExtras } from "./status-query.ts";
import type { TaskSnapshot } from "./types.ts";

export default function piTaskObserver(pi: ExtensionAPI): void {
  const git = new GitObserver();
  const processes = new ProcessObserver();
  const aggregator = new TaskAggregator({
    onTaskCreated(task) {
      task.baselinePending = true;
      git.capture(task.cwd)
        .then((snapshot) => {
          task.baseline = snapshot;
          task.baselinePending = false;
        })
        .catch((error) => {
          task.baselinePending = false;
          task.baseline = {
            ts: Date.now(),
            complete: false,
            reason: error instanceof Error ? error.message : String(error),
            files: [],
            startedAt: Date.now(),
            endedAt: Date.now(),
          };
        });
    },
    onTaskArchived(task) {
      task.finalWorkspacePending = true;
      git.capture(task.cwd)
        .then((snapshot) => {
          task.finalWorkspace = snapshot;
          task.finalWorkspacePending = false;
        })
        .catch((error) => {
          task.finalWorkspacePending = false;
          task.finalWorkspace = {
            ts: Date.now(),
            complete: false,
            reason: error instanceof Error ? error.message : String(error),
            files: [],
            startedAt: Date.now(),
            endedAt: Date.now(),
          };
        });
    },
  });

  pi.on("session_start", (event, ctx) => {
    resetDebugLog();
    aggregator.resetSession(
      ctx.sessionManager.getSessionId() ?? "unknown",
      ctx.cwd,
      event.reason,
      !ctx.isIdle(),
    );
    debugLog("session_start", { reason: event.reason, idle: ctx.isIdle() });
  });

  pi.on("session_shutdown", (event) => {
    debugLog("session_shutdown", { reason: event.reason });
    aggregator.resetSession("shutdown", "", event.reason, false);
  });

  pi.on("input", (event) => {
    aggregator.onInput(event.text, event.source, event.streamingBehavior);
  });

  pi.on("before_agent_start", (event) => {
    // 新版 Pi 的 custom message 触发（messageType: "custom"）不带 prompt，原样交聚合器判断。
    aggregator.onBeforeAgentStart((event as { prompt?: unknown }).prompt);
  });

  pi.on("agent_start", () => {
    aggregator.onAgentStart();
  });

  pi.on("agent_end", (event) => {
    const reasons = (event.messages ?? [])
      .map((message) => (message as { stopReason?: string }).stopReason)
      .filter((reason): reason is string => Boolean(reason));
    const willRetry = Boolean((event as { willRetry?: boolean }).willRetry);
    aggregator.onAgentEnd(reasons, willRetry);
  });

  pi.on("agent_settled", (_event, ctx) => {
    aggregator.onAgentSettled(ctx.isIdle());
  });

  pi.on("turn_start", (event) => {
    aggregator.onTurnStart(event.turnIndex);
  });

  pi.on("turn_end", (event) => {
    aggregator.onTurnEnd(event.turnIndex);
  });

  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; stopReason?: string };
    if (message.role === "user") aggregator.onUserMessage(extractMessageText(message));
    if (message.role === "assistant") aggregator.onAssistantMessage(message.stopReason);
  });

  pi.on("tool_execution_start", (event) => {
    aggregator.onToolStart(
      event.toolCallId,
      event.toolName,
      summarize(stableStringify(event.args), LIMITS.toolArgChars, LIMITS.toolArgBytes) ?? "",
    );
  });

  pi.on("tool_execution_update", (event) => {
    aggregator.onToolUpdate(
      event.toolCallId,
      event.toolName,
      summarize(stableStringify(event.partialResult), LIMITS.toolResultChars, LIMITS.toolResultBytes),
    );
  });

  pi.on("tool_execution_end", (event) => {
    const resultText = summarize(stableStringify(event.result), LIMITS.toolResultChars, LIMITS.toolResultBytes);
    aggregator.onToolEnd(event.toolCallId, event.toolName, event.isError, resultText);
  });

  pi.on("session_before_compact", (event) => {
    aggregator.onCompaction("start", event.reason, event.willRetry);
  });

  pi.on("session_compact", (event) => {
    aggregator.onCompaction("success", event.reason, event.willRetry);
  });

  pi.on("session_compact_failed", (event) => {
    aggregator.onCompaction("failed", event.reason, event.willRetry);
  });

  pi.on("ui_prompt_start", (event) => {
    aggregator.onUiPrompt(true, event.kind, event.title);
  });

  pi.on("ui_prompt_end", (event) => {
    aggregator.onUiPrompt(false, event.kind, event.title);
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "查看当前任务观察状态（不介入主 Agent）",
    getArgumentCompletions(prefix) {
      const items = ["help", "timeline", "files", "analyze", "history", "1", "2", "3"]
        .filter((item) => item.startsWith(prefix.toLowerCase()))
        .map((item) => ({ value: item, label: item }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      try {
        await handleStatus(args, ctx, aggregator, git, processes);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await showObservedText(ctx, aggregator, `状态查询失败：${truncateText(message, LIMITS.timelineDetailChars, LIMITS.timelineDetailBytes)}`);
      }
    },
  });
}

async function showObservedText(
  ctx: ExtensionCommandContext,
  aggregator: TaskAggregator,
  text: string,
): Promise<void> {
  await showText(ctx, text, () => aggregator.expectOwnCustomUi());
}

async function handleStatus(
  args: string,
  ctx: ExtensionCommandContext,
  aggregator: TaskAggregator,
  git: GitObserver,
  processes: ProcessObserver,
): Promise<void> {
  const parsed = parseStatusArgs(args);
  if (!parsed.ok) {
    await showObservedText(ctx, aggregator, `${parsed.error}\n\n${formatHelp()}`);
    return;
  }
  if (parsed.view === "help") {
    await showObservedText(ctx, aggregator, formatHelp());
    return;
  }
  if (parsed.view === "history") {
    await showObservedText(ctx, aggregator, formatHistory(aggregator.snapshotHistory()));
    return;
  }
  if (parsed.historyIndex && !aggregator.store.getByHistoryIndex(parsed.historyIndex)) {
    await showObservedText(ctx, aggregator, `没有编号为 ${parsed.historyIndex} 的历史任务。请使用 /status help 查看正式语法。`);
    return;
  }
  const snapshot = aggregator.snapshotTarget(parsed.historyIndex);
  if (!snapshot) {
    await showObservedText(ctx, aggregator, "当前没有可观察的任务。");
    return;
  }
  if (parsed.view === "analyze") {
    await runAnalyze(ctx, aggregator, snapshot, git, processes);
    return;
  }
  const extras = await loadExtras(
    snapshot,
    parsed.view !== "timeline",
    git,
    processes,
    parsed.view === "files" ? 1000 : LIMITS.gitQueryWaitMs,
  );
  if (parsed.view === "timeline") {
    await showObservedText(ctx, aggregator, formatTimeline(snapshot));
    return;
  }
  if (parsed.view === "files") {
    await showObservedText(ctx, aggregator, formatFiles(snapshot, extras.files, extras.workspace));
    return;
  }
  await showObservedText(ctx, aggregator, formatSummary(snapshot, extras));
}

async function runAnalyze(
  ctx: ExtensionCommandContext,
  aggregator: TaskAggregator,
  snapshot: TaskSnapshot,
  git: GitObserver,
  processes: ProcessObserver,
): Promise<void> {
  const extras = await loadExtras(snapshot, true, git, processes, 1000);
  const analyzer = new Analyzer({
    hasModel: () => Boolean(ctx.model),
    hasAuth: () => Boolean(ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model)),
    complete: async ({ messages, signal, sessionId }) => {
      if (!ctx.model) throw new Error("no model");
      const system = messages.find((message) => message.role === "system")?.content ?? "";
      const user = messages.find((message) => message.role === "user")?.content ?? "";
      const response = await ctx.modelRegistry.complete(
        ctx.model,
        {
          systemPrompt: system,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: user }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          signal,
          sessionId,
          cacheRetention: "none",
        },
      );
      const text = response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const usage = response.usage
        ? `input=${response.usage.input} output=${response.usage.output}`
        : undefined;
      return { text, usageText: usage };
    },
  });

  let result: { text: string; usage?: string; error?: string };
  if (willShowCustomUi(ctx.mode, ctx.hasUI)) {
    aggregator.expectOwnCustomUi();
    const uiResult = await ctx.ui.custom<{ text: string; usage?: string; error?: string } | null>((tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, "正在进行独立 AI 分析… Esc 只取消分析，不中断主 Agent");
      loader.onAbort = () => done(null);
      analyzer.analyze(snapshot, extras, loader.signal).then(done).catch((error) => {
        done({
          text: "",
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return loader;
    });
    result = uiResult ?? { text: "", error: "分析已取消。" };
  } else {
    ctx.ui.notify("正在进行独立 AI 分析…", "info");
    result = await analyzer.analyze(snapshot, extras);
  }
  await showObservedText(ctx, aggregator, formatAnalyze(result.text, { usage: result.usage, error: result.error }));
}
