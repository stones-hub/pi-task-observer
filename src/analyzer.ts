import { randomUUID } from "node:crypto";
import { LIMITS } from "./constants.ts";
import { redactSecrets, truncateText } from "./redactor.ts";
import type { FileDiffEntry, ProcessSnapshot, TaskSnapshot } from "./types.ts";

export interface CompleteFn {
  (input: {
    model: unknown;
    messages: Array<{ role: "system" | "user"; content: string }>;
    signal: AbortSignal;
    sessionId: string;
  }): Promise<{ text: string; usageText?: string }>;
}

export interface AnalyzerOptions {
  complete: CompleteFn;
  now?: () => number;
  timeoutMs?: number;
  hasModel?: () => boolean;
  hasAuth?: () => boolean;
}

export class Analyzer {
  private readonly complete: CompleteFn;
  private readonly timeoutMs: number;
  private readonly hasModel: () => boolean;
  private readonly hasAuth: () => boolean;

  constructor(options: AnalyzerOptions) {
    this.complete = options.complete;
    this.timeoutMs = options.timeoutMs ?? LIMITS.analyzeTimeoutMs;
    this.hasModel = options.hasModel ?? (() => true);
    this.hasAuth = options.hasAuth ?? (() => true);
  }

  async analyze(
    snapshot: TaskSnapshot,
    extras: { files?: FileDiffEntry[]; processes?: ProcessSnapshot },
    signal?: AbortSignal,
  ): Promise<{ text: string; usage?: string; error?: string }> {
    if (!this.hasModel()) return { text: "", error: "当前未配置模型，无法分析。" };
    if (!this.hasAuth()) return { text: "", error: "当前模型未配置认证，无法分析。" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = (): void => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (controller.signal.aborted) {
        return { text: "", error: signal?.aborted ? "分析已取消。" : `分析超时（${this.timeoutMs / 1000} 秒），未重试。` };
      }
      const prompt = buildAnalyzePrompt(snapshot, extras);
      const result = await this.complete({
        model: undefined,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        signal: controller.signal,
        sessionId: randomUUID(),
      });
      return {
        text: truncateText(result.text, LIMITS.aiResultChars, LIMITS.aiResultBytes),
        usage: result.usageText,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        return { text: "", error: signal?.aborted ? "分析已取消。" : `分析超时（${this.timeoutMs / 1000} 秒），未重试。` };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { text: "", error: truncateText(message, LIMITS.timelineDetailChars, LIMITS.timelineDetailBytes) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

const SYSTEM_PROMPT = [
  "你是任务进度分析器。只用中文回答。",
  "必须区分观察事实和推断，不得把推断写成事实，不得编造未提供的 PID、文件归属或完成百分比。",
  "输出必须包含以下中文小节标题：推断阶段；观察依据；可能已经完成；当前可能正在进行；可能剩余；风险、阻塞和未知；置信度。",
].join("");

export function buildAnalyzePrompt(
  snapshot: TaskSnapshot,
  extras: { files?: FileDiffEntry[]; processes?: ProcessSnapshot },
): string {
  const lines = [
    `任务状态=${snapshot.state}`,
    `来源=${snapshot.source}`,
    `完整性=${snapshot.completeness}`,
    `摘要=${snapshot.promptSummary ?? "未知"}`,
    `开始=${snapshot.startedAt}`,
    `区段=${snapshot.executionSegments.map((segment) => segment.runId).join(",")}`,
    "时间线：",
    ...snapshot.timeline.slice(-16).map((event) => `- ${event.summary}`),
    "活跃工具：",
    ...snapshot.activeTools.slice(0, 8).map((tool) => `- ${tool.toolName} ${tool.argsSummary}`),
  ];
  if (extras.files) {
    lines.push("工作区文件（不含完整 diff）：");
    for (const file of extras.files.slice(0, 20)) {
      lines.push(`- ${file.kind} ${file.path}`);
    }
  }
  if (extras.processes?.candidates.length) {
    lines.push("候选进程：");
    for (const item of extras.processes.candidates.slice(0, 5)) {
      lines.push(`- pid=${item.pid} conf=${item.confidence} ${item.command}`);
    }
  }
  let text = redactSecrets(lines.join("\n"));
  if (Buffer.byteLength(text, "utf8") > LIMITS.aiInputBytes) {
    text = Buffer.from(text, "utf8").subarray(0, LIMITS.aiInputBytes).toString("utf8");
  }
  return text;
}
