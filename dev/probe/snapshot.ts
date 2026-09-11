import { COMMAND_TEXT, containsCommandText, extractMessageText } from "./redact.ts";
import type { SessionSnapshot } from "./types.ts";

type SessionLike = {
  getSessionId?: () => string;
  getLeafId?: () => string | null;
  getEntries?: () => unknown[];
  buildContextEntries?: () => unknown[];
};

function roleOf(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "unknown";
  const rec = entry as { type?: string; message?: { role?: string } };
  if (rec.type === "message") return rec.message?.role ?? "message";
  return rec.type ?? "unknown";
}

export function snapshotSession(sessionManager: SessionLike | undefined): SessionSnapshot {
  const entries = sessionManager?.getEntries?.() ?? [];
  const contextEntries = sessionManager?.buildContextEntries?.() ?? [];
  const sessionId = sessionManager?.getSessionId?.() ?? "";
  const leafId = sessionManager?.getLeafId?.() ?? null;
  return {
    sessionIdPrefix: sessionId.slice(0, 8),
    leafIdPrefix: leafId ? leafId.slice(0, 8) : null,
    entryCount: entries.length,
    contextCount: contextEntries.length,
    entryTypes: entries.map(roleOf),
    contextRoles: contextEntries.map(roleOf),
    commandInEntries: entries.some((entry) => containsCommandText(entry) || extractMessageText((entry as { message?: unknown }).message).includes(COMMAND_TEXT)),
    commandInContext: contextEntries.some((entry) => containsCommandText(entry) || extractMessageText((entry as { message?: unknown }).message).includes(COMMAND_TEXT)),
  };
}
