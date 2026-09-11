import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMAND_TEXT,
  containsCommandText,
  fingerprint,
  redactSecrets,
  textMeta,
  truncateText,
} from "../redact.ts";

test("redacts common credential patterns", () => {
  const sample = [
    "token sk-abcdefghijklmnopqrstuvwxyz",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaabbbbbcccccc.dddddeeeeefffff",
    "OPENAI_API_KEY=sk-live-not-real",
    "password=super-secret-value",
  ].join("\n");
  const redacted = redactSecrets(sample);
  assert.equal(redacted.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(redacted.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(redacted.includes("Bearer eyJ"), false);
  assert.equal(redacted.includes("OPENAI_API_KEY=sk-live-not-real"), false);
  assert.equal(redacted.includes("password=super-secret-value"), false);
  assert.match(redacted, /REDACTED/);
});

test("truncates long text and keeps command detection", () => {
  const text = `${COMMAND_TEXT} ${"x".repeat(400)} PROBE_NORMAL_1`;
  const truncated = truncateText(text, 40, 80);
  assert.ok(truncated.length < text.length);
  assert.ok(truncated.includes("…"));
  const meta = textMeta(text);
  assert.equal(meta.hasCommand, true);
  assert.equal(meta.hasMarker, true);
  assert.equal(fingerprint(text)?.length, 12);
});

test("does not treat unrelated objects as command text", () => {
  assert.equal(containsCommandText({ role: "user", content: "hello" }), false);
  assert.equal(containsCommandText({ role: "user", content: [{ type: "text", text: COMMAND_TEXT }] }), true);
});
