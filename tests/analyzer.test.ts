import assert from "node:assert/strict";
import { test } from "node:test";
import { Analyzer, buildAnalyzePrompt } from "../src/analyzer.ts";
import { LIMITS } from "../src/constants.ts";
import { fixtureSnapshot } from "./helpers.ts";

test("默认 AI 超时为 300 秒", () => {
  assert.equal(LIMITS.analyzeTimeoutMs, 300_000);
});

test("分析输入有界、脱敏，且不含完整 diff/环境变量", () => {
  const snapshot = fixtureSnapshot({
    promptSummary: `sk-abcdefghijklmnopqrstuvwxyz ${"n".repeat(2000)}`,
    timeline: Array.from({ length: 40 }, (_, index) => ({
      ts: index,
      kind: "tool-end" as const,
      summary: `OPENAI_API_KEY=sk-live-${index} result ${"z".repeat(200)}`,
    })),
  });
  const prompt = buildAnalyzePrompt(snapshot, {
    files: [{ path: "a.ts", kind: "appeared" }],
    processes: {
      ts: 1,
      complete: true,
      platform: "darwin",
      rootPid: 1,
      candidates: [{ pid: 9, ppid: 1, command: "sleep 8", alive: true, descendantOfPi: true, confidence: "high", evidence: [] }],
    },
  });
  assert.ok(Buffer.byteLength(prompt, "utf8") <= LIMITS.aiInputBytes);
  assert.doesNotMatch(prompt, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(prompt, /OPENAI_API_KEY=sk-live/);
  assert.doesNotMatch(prompt, /diff --git/);
});

test("独立 sessionId，不复用任务 Session", async () => {
  const seen: string[] = [];
  const analyzer = new Analyzer({
    complete: async ({ sessionId, messages }) => {
      seen.push(sessionId);
      assert.ok(messages.some((message) => message.role === "system"));
      return { text: "推断阶段：测试", usageText: "input=1 output=1" };
    },
  });
  const snapshot = fixtureSnapshot({ sessionId: "main-session" });
  const result = await analyzer.analyze(snapshot, {});
  assert.equal(result.error, undefined);
  assert.notEqual(seen[0], "main-session");
  assert.match(result.text, /推断阶段/);
  assert.equal(result.usage, "input=1 output=1");
});

test("取消、超时、无模型、无认证、provider 错误均隔离失败", async () => {
  const noModel = await new Analyzer({ complete: async () => ({ text: "no" }), hasModel: () => false }).analyze(fixtureSnapshot(), {});
  assert.match(noModel.error ?? "", /未配置模型/);

  const noAuth = await new Analyzer({ complete: async () => ({ text: "no" }), hasAuth: () => false }).analyze(fixtureSnapshot(), {});
  assert.match(noAuth.error ?? "", /未配置认证/);

  const provider = await new Analyzer({
    complete: async () => {
      throw new Error("provider 500");
    },
  }).analyze(fixtureSnapshot(), {});
  assert.match(provider.error ?? "", /provider 500/);

  const canceled = new AbortController();
  canceled.abort();
  const cancelResult = await new Analyzer({
    timeoutMs: 1_000,
    complete: async ({ signal }) => await new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  }).analyze(fixtureSnapshot(), {}, canceled.signal);
  assert.match(cancelResult.error ?? "", /取消/);

  const timeout = await new Analyzer({
    timeoutMs: 50,
    complete: async ({ signal }) => await new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  }).analyze(fixtureSnapshot(), {});
  assert.match(timeout.error ?? "", /超时/);
  assert.match(timeout.error ?? "", /0\.05|50/);
});

test("分析只使用独立 signal，不耦合未传入的主 Agent abort", async () => {
  const agent = new AbortController();
  let usedSignal: AbortSignal | undefined;
  const analyzer = new Analyzer({
    timeoutMs: 1_000,
    complete: async ({ signal }) => {
      usedSignal = signal;
      agent.abort();
      assert.equal(signal.aborted, false);
      return { text: "推断阶段：隔离" };
    },
  });
  const result = await analyzer.analyze(fixtureSnapshot(), {});
  assert.equal(result.error, undefined);
  assert.equal(usedSignal?.aborted, false);
});
