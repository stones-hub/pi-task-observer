import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export function willShowCustomUi(mode: string, hasUI: boolean): boolean {
  return mode === "tui" && hasUI;
}

export function layoutStatusLines(text: string, width: number): string[] {
  const columns = Math.max(1, width);
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const wrapped = wrapTextWithAnsi(raw.length > 0 ? raw : " ", columns);
    for (const part of wrapped) {
      if (visibleWidth(part) <= columns) lines.push(part);
      else lines.push(truncateToWidth(part, columns, "…"));
    }
  }
  return lines;
}

export async function showText(
  ctx: ExtensionCommandContext,
  text: string,
  onBeforeCustom?: () => void,
): Promise<void> {
  if (willShowCustomUi(ctx.mode, ctx.hasUI)) {
    onBeforeCustom?.();
    await ctx.ui.custom<undefined>((_tui, theme, _kb, done) => {
      return {
        render(width: number) {
          const columns = Math.max(1, width);
          return [
            truncateToWidth(theme.fg("accent", " pi-task-observer "), columns, "…"),
            ...layoutStatusLines(text, columns),
            truncateToWidth(theme.fg("dim", "Enter / Esc 关闭"), columns, "…"),
          ];
        },
        invalidate() {},
        handleInput(data: string) {
          if (isDismissKey(data)) done(undefined);
        },
      };
    });
    return;
  }
  ctx.ui.notify(text.length > 1800 ? `${text.slice(0, 1800)}…` : text, "info");
}

function isDismissKey(data: string): boolean {
  return data === "\r" || data === "\n" || data === "\x1b" || data === "\x1b[27u" || data === "\x1b[13u";
}
