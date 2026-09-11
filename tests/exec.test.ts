import assert from "node:assert/strict";
import { test } from "node:test";
import { execArgv } from "../src/exec.ts";

test("execArgv 使用 argv 而不是 shell 拼接", async () => {
  const result = await execArgv("printf", ["%s", "a; echo pwned"], { timeoutMs: 2_000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "a; echo pwned");
  assert.doesNotMatch(result.stdout, /^pwned$/m);
});

test("execArgv 超时会杀死子进程", async () => {
  const started = Date.now();
  const result = await execArgv("sleep", ["5"], { timeoutMs: 200 });
  assert.equal(result.killed, true);
  assert.ok(Date.now() - started < 2_000);
});

test("execArgv 达 maxStdoutBytes 时标记 stdoutTruncated", async () => {
  const result = await execArgv("printf", ["%s", "abcdefghijklmnopqrstuvwxyz"], { timeoutMs: 2_000, maxStdoutBytes: 8 });
  assert.equal(result.stdout.length, 8);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.killed, false);
});
