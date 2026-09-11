import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { layoutStatusLines, showText, willShowCustomUi } from "../src/display.ts";

test("中文窄终端每行 visibleWidth 不超过 width", () => {
  const text = [
    "状态：工具执行中",
    "摘要：实现一个很长的中文说明，用于验证窄终端换行而不是按 string.length 截断。",
    "路径：docs/requirements.md",
  ].join("\n");
  const width = 12;
  const lines = layoutStatusLines(text, width);
  assert.ok(lines.length > 3);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `${JSON.stringify(line)} width=${visibleWidth(line)}`);
  }
});

test("ANSI 颜色不计入可见宽度", () => {
  const colored = "\u001b[32m状态：已结束\u001b[0m";
  const lines = layoutStatusLines(colored, 8);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 8);
  }
});

test("willShowCustomUi 仅在 TUI 且 hasUI 时为真", () => {
  assert.equal(willShowCustomUi("tui", true), true);
  assert.equal(willShowCustomUi("tui", false), false);
  assert.equal(willShowCustomUi("rpc", true), false);
  assert.equal(willShowCustomUi("command", true), false);
});

test("notify 路径不调用 onBeforeCustom；TUI 路径在 custom 前同步记账", async () => {
  let notifyExpect = 0;
  await showText(
    {
      mode: "rpc",
      hasUI: true,
      ui: {
        notify() {},
        custom: async () => {
          throw new Error("rpc 不应 custom");
        },
      },
    } as never,
    "hello",
    () => {
      notifyExpect += 1;
    },
  );
  assert.equal(notifyExpect, 0);

  const order: string[] = [];
  await showText(
    {
      mode: "tui",
      hasUI: true,
      ui: {
        notify() {},
        async custom() {
          order.push("custom");
        },
      },
    } as never,
    "hello",
    () => {
      order.push("expect");
    },
  );
  assert.deepEqual(order, ["expect", "custom"]);
});
