import { createHash } from "node:crypto";

export const COMMAND_NAME = "probe-status";
export const COMMAND_TEXT = `/${COMMAND_NAME}`;
export const MAX_TEXT_CHARS = 80;
export const MAX_TEXT_BYTES = 256;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/gi,
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/gi,
  /\bsk-proj-[A-Za-z0-9_-]{8,}\b/gi,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\b(api[_-]?key|access[_-]?token|secret|password|passwd|authorization)\s*[:=]\s*['"]?[^'"\s]+/gi,
];

const ENV_KEY_PATTERN =
  /\b(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*=\s*\S+/g;

export function fingerprint(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  out = out.replace(ENV_KEY_PATTERN, "[REDACTED_ENV]");
  return out;
}

export function truncateText(text: string, maxChars = MAX_TEXT_CHARS, maxBytes = MAX_TEXT_BYTES): string {
  const redacted = redactSecrets(text).replace(/\s+/g, " ").trim();
  let slice = redacted.slice(0, maxChars);
  while (Buffer.byteLength(slice, "utf8") > maxBytes) {
    slice = slice.slice(0, -1);
  }
  if (slice.length < redacted.length) {
    return `${slice}…(+${redacted.length - slice.length})`;
  }
  return slice;
}

export function textMeta(text: string | undefined): {
  len: number;
  fp?: string;
  preview?: string;
  hasCommand: boolean;
  hasMarker: boolean;
} {
  if (text == null) {
    return { len: 0, hasCommand: false, hasMarker: false };
  }
  return {
    len: text.length,
    fp: fingerprint(text),
    preview: truncateText(text),
    hasCommand: text.includes(COMMAND_TEXT),
    hasMarker: /PROBE_[A-Z0-9_]+/.test(text),
  };
}

export function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const rec = message as { content?: unknown; text?: unknown };
  if (typeof rec.text === "string") return rec.text;
  const content = rec.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && (item as { type?: string }).type === "text") {
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

export function containsCommandText(value: unknown): boolean {
  if (typeof value === "string") return value.includes(COMMAND_TEXT);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsCommandText);
  const rec = value as Record<string, unknown>;
  if (typeof rec.customType === "string" && rec.customType.includes("probe")) {
    return true;
  }
  return containsCommandText(extractMessageText(value)) ||
    (typeof rec.type === "string" && rec.type === "message" && containsCommandText(rec.message));
}

export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncateText(message, 160, 512);
}
