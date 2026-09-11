import type { ParseResult } from "./types.ts";

const VIEWS = new Set(["help", "timeline", "files", "analyze", "history"]);

export function parseStatusArgs(raw: string): ParseResult {
  const tokens = raw.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());
  if (tokens.length === 0) return { ok: true, view: "summary" };
  if (tokens.length === 1 && VIEWS.has(tokens[0])) {
    return { ok: true, view: tokens[0] as "help" | "timeline" | "files" | "analyze" | "history" };
  }
  if (tokens[0] === "1" || tokens[0] === "2" || tokens[0] === "3") {
    const historyIndex = Number(tokens[0]) as 1 | 2 | 3;
    if (tokens.length === 1) return { ok: true, view: "summary", historyIndex };
    if (tokens.length === 2 && (tokens[1] === "timeline" || tokens[1] === "files" || tokens[1] === "analyze")) {
      return { ok: true, view: tokens[1], historyIndex };
    }
    return {
      ok: false,
      error: `无法识别的参数。请使用 /status help 查看正式语法。`,
    };
  }
  return {
    ok: false,
    error: `无法识别的参数。请使用 /status help 查看正式语法。`,
  };
}

export const HELP_TEXT = [
  "任务观察器 /status",
  "",
  "观察在 Extension 加载后自动开启，没有开关。本命令只查询状态，不会成为",
  "steering、follow-up 或主 Agent 上下文。",
  "",
  "语法：",
  "  /status",
  "  /status help",
  "  /status timeline",
  "  /status files",
  "  /status analyze",
  "  /status history",
  "  /status <1|2|3>",
  "  /status <1|2|3> timeline",
  "  /status <1|2|3> files",
  "  /status <1|2|3> analyze",
  "",
  "说明：",
  "  - 每个 Session 保留 1 个当前任务和最近 3 条已结束任务。",
  "  - 编号 1 是最近结束的任务，3 是保留范围内最早的任务。",
  "  - 工作区变化只能表述为任务运行期间观察到，不能证明由当前 Agent 修改。",
  "  - 进程信息是 Pi 后代候选，带可信度，不能精确归属 bash 子进程。",
  "  - /status analyze 会使用当前模型发起一次独立调用，可能产生额外费用；",
  "    发出该命令即表示同意这次调用。",
  "  - 不提供 raw、process 或 watch 子命令。",
].join("\n");
