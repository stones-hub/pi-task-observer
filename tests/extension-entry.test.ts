import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piTaskObserver from "../src/index.ts";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

const workspace = mkdtempSync(join(tmpdir(), "pto-entry-"));
after(() => rmSync(workspace, { recursive: true, force: true }));

function loadExtension() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, CommandHandler>();
  const fakePi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, options: { handler: CommandHandler }) {
      commands.set(name, options.handler);
    },
  };
  piTaskObserver(fakePi as unknown as ExtensionAPI);
  const ctx = {
    cwd: workspace,
    mode: "print",
    hasUI: false,
    isIdle: () => true,
    sessionManager: { getSessionId: () => "sess-entry" },
  };
  const emit = (name: string, event: Record<string, unknown> = {}) => {
    const handler = handlers.get(name);
    assert.ok(handler, `入口应注册 ${name}`);
    return handler({ type: name, ...event }, ctx);
  };
  const status = async (args: string) => {
    const notes: string[] = [];
    const handler = commands.get("status");
    assert.ok(handler, "入口应注册 /status");
    await handler(args, { ...ctx, ui: { notify: (text: string) => notes.push(text) } });
    return notes.join("\n");
  };
  return { emit, status };
}

function customTrigger() {
  return {
    messageType: "custom",
    message: {
      role: "custom",
      customType: "other-extension",
      content: [{ type: "text", text: "custom 内容不应冒充用户输入" }],
      display: true,
      timestamp: Date.now(),
    },
    systemPrompt: "system",
    systemPromptOptions: {},
  };
}

test("入口：custom message triggerTurn 的 before_agent_start 无 prompt 不报错，任务 partial 并可归档", async () => {
  const { emit, status } = loadExtension();
  emit("session_start", { reason: "startup" });
  emit("input", { text: "排队的普通输入", source: "interactive" });

  assert.doesNotThrow(() => emit("before_agent_start", customTrigger()));
  emit("agent_start");
  emit("turn_start", { turnIndex: 0 });
  emit("message_end", { message: customTrigger().message });
  emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
  emit("turn_end", { turnIndex: 0 });

  const running = await status("");
  assert.doesNotMatch(running, /状态查询失败/);
  assert.match(running, /观测完整性：不完整/);
  assert.match(running, /未携带普通 prompt/);
  assert.doesNotMatch(running, /custom 内容不应冒充用户输入/);

  emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  emit("agent_settled");
  assert.match(await status("history"), /^1\. /m);
  const archived = await status("1");
  assert.match(archived, /观测完整性：不完整/);
  assert.doesNotMatch(archived, /custom 内容不应冒充用户输入/);

  // 普通输入经入口仍按 pending 匹配为完整任务，未被 custom 启动消费。
  emit("before_agent_start", { messageType: "user", prompt: "排队的普通输入", systemPrompt: "system" });
  emit("agent_start");
  const normal = await status("");
  assert.match(normal, /观测完整性：完整/);
  assert.match(normal, /排队的普通输入/);
});

test("入口：custom 启动后首条实际交付的 follow-up 拆为新任务，不当作原始输入吞掉", async () => {
  const { emit, status } = loadExtension();
  emit("session_start", { reason: "startup" });
  emit("before_agent_start", customTrigger());
  emit("agent_start");
  emit("turn_start", { turnIndex: 0 });
  emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
  emit("turn_end", { turnIndex: 0 });

  emit("input", { text: "custom 后的 follow-up", source: "interactive", streamingBehavior: "followUp" });
  assert.doesNotMatch(await status("history"), /^1\. /m);
  emit("turn_start", { turnIndex: 1 });
  emit("message_end", {
    message: { role: "user", content: [{ type: "text", text: "custom 后的 follow-up" }], timestamp: Date.now() },
  });
  emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
  emit("turn_end", { turnIndex: 1 });

  assert.match(await status("history"), /^1\. /m);
  const archived = await status("1");
  assert.match(archived, /未携带普通 prompt/);
  assert.doesNotMatch(archived, /普通输入：custom 后的 follow-up/);
  const current = await status("");
  assert.match(current, /观测完整性：完整/);
  assert.match(current, /custom 后的 follow-up/);
});
