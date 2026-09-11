import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("Pi 0.85.1 Extension API 不暴露 auto_retry，agent_end 类型不含 willRetry", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const types = readFileSync(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts"), "utf8");
  assert.doesNotMatch(types, /on\(event: "auto_retry_start"/);
  assert.doesNotMatch(types, /on\(event: "auto_retry_end"/);
  const agentEnd = types.match(/export interface AgentEndEvent \{[\s\S]*?\n\}/);
  assert.ok(agentEnd);
  assert.match(agentEnd[0], /messages: AgentMessage\[\]/);
  assert.doesNotMatch(agentEnd[0], /willRetry/);
  const session = readFileSync(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts"), "utf8");
  assert.match(session, /type: "auto_retry_start"/);
  assert.match(session, /willRetry: boolean/);
});
