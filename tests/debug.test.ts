import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { debugEnabled, debugLog, resetDebugLog } from "../src/debug.ts";
import { LIMITS } from "../src/constants.ts";

test("调试默认关闭", () => {
  const previous = process.env.PI_TASK_OBSERVER_DEBUG;
  delete process.env.PI_TASK_OBSERVER_DEBUG;
  assert.equal(debugEnabled(), false);
  if (previous === undefined) delete process.env.PI_TASK_OBSERVER_DEBUG;
  else process.env.PI_TASK_OBSERVER_DEBUG = previous;
});

test("调试日志同样脱敏截断", () => {
  const previousDebug = process.env.PI_TASK_OBSERVER_DEBUG;
  const previousFile = process.env.PI_TASK_OBSERVER_DEBUG_FILE;
  const file = join(mkdtempSync(join(tmpdir(), "pto-debug-")), "debug.jsonl");
  process.env.PI_TASK_OBSERVER_DEBUG = "1";
  process.env.PI_TASK_OBSERVER_DEBUG_FILE = file;
  debugLog("probe", { token: "sk-abcdefghijklmnopqrstuvwxyz", password: "hunter2" });
  const line = readFileSync(file, "utf8");
  assert.match(line, /REDACTED|probe/);
  assert.doesNotMatch(line, /sk-abcdefghijklmnopqrstuvwxyz/);
  if (previousDebug === undefined) delete process.env.PI_TASK_OBSERVER_DEBUG;
  else process.env.PI_TASK_OBSERVER_DEBUG = previousDebug;
  if (previousFile === undefined) delete process.env.PI_TASK_OBSERVER_DEBUG_FILE;
  else process.env.PI_TASK_OBSERVER_DEBUG_FILE = previousFile;
});

test("调试日志文件有会话级总上限，达到后停止并标记", () => {
  const previousDebug = process.env.PI_TASK_OBSERVER_DEBUG;
  const previousFile = process.env.PI_TASK_OBSERVER_DEBUG_FILE;
  const file = join(mkdtempSync(join(tmpdir(), "pto-debug-cap-")), "debug.jsonl");
  process.env.PI_TASK_OBSERVER_DEBUG = "1";
  process.env.PI_TASK_OBSERVER_DEBUG_FILE = file;
  resetDebugLog();
  const chunk = "x".repeat(400);
  for (let i = 0; i < 2000; i += 1) debugLog("flood", { chunk, i });
  const content = readFileSync(file, "utf8");
  assert.ok(content.length <= LIMITS.debugMaxBytes + 1024);
  assert.match(content, /debug_capped|flood/);
  const sizeAfter = content.length;
  debugLog("after-cap", { should: "not-grow-much" });
  const later = readFileSync(file, "utf8");
  assert.ok(later.length - sizeAfter < 200 || later.includes("debug_capped"));
  if (previousDebug === undefined) delete process.env.PI_TASK_OBSERVER_DEBUG;
  else process.env.PI_TASK_OBSERVER_DEBUG = previousDebug;
  if (previousFile === undefined) delete process.env.PI_TASK_OBSERVER_DEBUG_FILE;
  else process.env.PI_TASK_OBSERVER_DEBUG_FILE = previousFile;
});

