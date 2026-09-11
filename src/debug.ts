import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { LIMITS } from "./constants.ts";
import { truncateText } from "./redactor.ts";

let capped = false;

export function debugEnabled(): boolean {
  return process.env.PI_TASK_OBSERVER_DEBUG === "1";
}

export function resetDebugLog(): void {
  capped = false;
}

export function debugLog(kind: string, data: Record<string, unknown>): void {
  if (!debugEnabled()) return;
  const line = JSON.stringify({
    ts: Date.now(),
    kind,
    data,
  });
  const bounded = truncateText(line, LIMITS.debugLineChars, LIMITS.debugLineBytes);
  const payload = `${bounded}\n`;
  const file = process.env.PI_TASK_OBSERVER_DEBUG_FILE;
  if (file) {
    writeCapped(file, payload, kind);
    return;
  }
  if (capped) return;
  console.error(`[pi-task-observer] ${bounded}`);
}

function writeCapped(file: string, payload: string, kind: string): void {
  if (capped) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const current = fileSize(file);
    if (current >= LIMITS.debugMaxBytes) {
      capped = true;
      return;
    }
    const marker = `${truncateText(JSON.stringify({
      ts: Date.now(),
      kind: "debug_capped",
      data: { reason: "会话/文件达到调试日志总上限，已停止写入", limitBytes: LIMITS.debugMaxBytes },
    }), LIMITS.debugLineChars, LIMITS.debugLineBytes)}\n`;
    if (current + Buffer.byteLength(payload, "utf8") > LIMITS.debugMaxBytes) {
      if (kind !== "debug_capped" && current + Buffer.byteLength(marker, "utf8") <= LIMITS.debugMaxBytes + 512) {
        appendFileSync(file, marker);
      }
      capped = true;
      return;
    }
    appendFileSync(file, payload);
    if (fileSize(file) >= LIMITS.debugMaxBytes) capped = true;
  } catch {
    // ignore debug IO failures
  }
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
