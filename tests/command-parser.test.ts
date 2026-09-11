import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStatusArgs, HELP_TEXT } from "../src/command-parser.ts";
import { formatHelp } from "../src/formatter.ts";

test("/status 空参数是综合摘要", () => {
  assert.deepEqual(parseStatusArgs(""), { ok: true, view: "summary" });
  assert.deepEqual(parseStatusArgs("   "), { ok: true, view: "summary" });
});

test("正式子命令大小写不敏感且忽略多余空白", () => {
  for (const view of ["help", "timeline", "files", "analyze", "history"] as const) {
    assert.deepEqual(parseStatusArgs(`  ${view.toUpperCase()}  `), { ok: true, view });
  }
});

test("历史编号可与 timeline/files/analyze 组合", () => {
  assert.deepEqual(parseStatusArgs("1"), { ok: true, view: "summary", historyIndex: 1 });
  assert.deepEqual(parseStatusArgs("2 timeline"), { ok: true, view: "timeline", historyIndex: 2 });
  assert.deepEqual(parseStatusArgs("3 FILES"), { ok: true, view: "files", historyIndex: 3 });
  assert.deepEqual(parseStatusArgs("1 analyze"), { ok: true, view: "analyze", historyIndex: 1 });
});

test("未知子命令、越界编号、顺序错误和多余参数均提示 help", () => {
  for (const args of ["raw", "process", "watch", "4", "0", "timeline extra", "1 help", "help timeline", "status"]) {
    const parsed = parseStatusArgs(args);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.error, /\/status help/);
  }
});

test("帮助文本覆盖正式语法且不提供 raw/process/watch", () => {
  const help = formatHelp();
  assert.equal(help, HELP_TEXT);
  for (const line of [
    "/status",
    "/status help",
    "/status timeline",
    "/status files",
    "/status analyze",
    "/status history",
    "/status <1|2|3>",
  ]) {
    assert.match(help, new RegExp(line.replace(/[<>|]/g, "\\$&")));
  }
  assert.match(help, /不提供 raw、process 或 watch/);
  assert.match(help, /不会成为/);
  assert.match(help, /独立调用/);
});
