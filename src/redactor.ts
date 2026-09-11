import { createHash } from "node:crypto";
import { LIMITS } from "./constants.ts";

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

export function boundText(text: string): string {
  const window = LIMITS.fingerprintWindowChars;
  if (text.length <= window * 2) return text;
  const lenStr = String(text.length);
  const budget = Math.max(2, window * 2 - lenStr.length - 2);
  const head = Math.floor(budget / 2);
  const tail = budget - head;
  return `${text.slice(0, head)}\n${lenStr}\n${text.slice(-tail)}`;
}

export function fingerprint(text: string): string {
  return createHash("sha256").update(boundText(text), "utf8").digest("hex").slice(0, 16);
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  out = out.replace(ENV_KEY_PATTERN, "[REDACTED_ENV]");
  out = redactIncompletePem(out);
  out = redactUnclosedJwt(out);
  out = redactEdgeKeyFragments(out);
  return out;
}

export function truncateText(text: string, maxChars: number, maxBytes: number): string {
  const overlap = LIMITS.redactOverlapChars;
  const windows = takeRedactWindows(text, maxChars, maxBytes, overlap);
  const headRedacted = collapseWs(redactSecrets(windows.head));
  const tailRedacted = windows.tail ? collapseWs(redactSecrets(windows.tail)) : "";
  const redacted = tailRedacted ? `${headRedacted}\n${tailRedacted}` : headRedacted;
  if (!redacted) return "";
  return clipRedactedDisplay(redacted, maxChars, maxBytes, windows.omitted);
}

export function summarize(text: string | undefined, maxChars: number, maxBytes: number): string | undefined {
  if (!text) return undefined;
  const value = truncateText(text, maxChars, maxBytes);
  return value || undefined;
}

export function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  try {
    const rec = message as { content?: unknown; text?: unknown };
    if (typeof rec.text === "string") return boundText(rec.text);
    const content = rec.content;
    if (typeof content === "string") return boundText(content);
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    const maxParts = LIMITS.stringifyMaxArray;
    for (let i = 0; i < content.length && parts.length < maxParts; i += 1) {
      const item = content[i];
      if (item && typeof item === "object" && (item as { type?: string }).type === "text") {
        let text: unknown;
        try {
          text = (item as { text?: unknown }).text;
        } catch {
          continue;
        }
        if (typeof text === "string") parts.push(text);
      }
    }
    return boundText(parts.join("\n"));
  } catch {
    return "";
  }
}

export function stableStringify(value: unknown, depth = 0): string {
  return stringifyBounded(value, {
    depth,
    remaining: LIMITS.stringifyMaxChars,
  });
}

interface StringifyState {
  depth: number;
  remaining: number;
}

function stringifyBounded(value: unknown, state: StringifyState): string {
  if (state.remaining <= 0) return "[…]";
  if (state.depth > LIMITS.stringifyMaxDepth) return "[…]";
  try {
    if (value == null) return "";
    if (typeof value === "string") {
      const clipped = clipRawString(value, Math.min(state.remaining, LIMITS.stringifyMaxChars));
      state.remaining -= clipped.length;
      return clipped;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      const text = String(value);
      state.remaining -= text.length;
      return text;
    }
    if (Array.isArray(value)) {
      const n = Math.min(value.length, LIMITS.stringifyMaxArray);
      const parts: string[] = [];
      for (let i = 0; i < n && state.remaining > 0; i += 1) {
        let item: unknown;
        try {
          item = value[i];
        } catch {
          parts.push("[throw]");
          continue;
        }
        parts.push(stringifyBounded(item, { depth: state.depth + 1, remaining: state.remaining }));
      }
      if (value.length > n) parts.push("…");
      const out = parts.join(", ");
      state.remaining -= out.length;
      return out;
    }
    if (typeof value === "object") {
      const parts: string[] = [];
      let count = 0;
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (count >= LIMITS.stringifyMaxObjectKeys) {
          parts.push("…");
          break;
        }
        if (state.remaining <= 0) {
          parts.push("…");
          break;
        }
        count += 1;
        let item: unknown;
        try {
          item = (value as Record<string, unknown>)[key];
        } catch {
          parts.push(`${key}=[throw]`);
          continue;
        }
        parts.push(`${key}=${stringifyBounded(item, { depth: state.depth + 1, remaining: state.remaining })}`);
      }
      const out = parts.join(" ");
      state.remaining -= out.length;
      return out;
    }
    return "";
  } catch {
    return "[error]";
  }
}

function takeRedactWindows(
  text: string,
  maxChars: number,
  maxBytes: number,
  overlap: number,
): { head: string; tail: string; omitted: number; displayHead: number; displayTail: number } {
  const fitsChars = text.length <= maxChars;
  const fitsBytes = fitsChars && Buffer.byteLength(text, "utf8") <= maxBytes;
  if (fitsBytes) {
    return { head: text, tail: "", omitted: 0, displayHead: text.length, displayTail: 0 };
  }
  let displayTail = Math.min(24, Math.floor(maxChars / 4));
  if (displayTail < 8) displayTail = 0;
  const ellipsisAllowance = displayTail > 0 ? 20 : 1;
  let displayHead = Math.max(8, maxChars - displayTail - ellipsisAllowance);
  const headCut = Math.min(text.length, displayHead + overlap);
  const tailCut = displayTail > 0 ? Math.min(text.length, displayTail + overlap) : 0;
  const headEnd = peekTokenEnd(text, headCut, BOUNDARY_PEEK);
  const tailStart = tailCut > 0 ? peekTokenStart(text, text.length - tailCut, BOUNDARY_PEEK) : text.length;
  const head = text.slice(0, headEnd);
  const tail = tailCut > 0 ? text.slice(tailStart) : "";
  const omitted = Math.max(0, text.length - displayHead - displayTail);
  return { head, tail, omitted, displayHead, displayTail };
}

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/gi;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/gi;
const UNCLOSED_JWT = /eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}/g;
const TRAILING_KEY = /(?:sk-ant-|sk-proj-|sk-|ghp_|github_pat_|xox[baprs]-|AIza|AKIA|Bearer\s+)[A-Za-z0-9._~+/=-]*$/gi;
const BOUNDARY_PEEK = 2048;

function redactIncompletePem(text: string): string {
  const begins = [...text.matchAll(new RegExp(PEM_BEGIN.source, "gi"))];
  const ends = [...text.matchAll(new RegExp(PEM_END.source, "gi"))];
  const usedEnds = new Set<number>();
  const ranges: Array<[number, number]> = [];
  for (const begin of begins) {
    const start = begin.index ?? 0;
    const afterBegin = start + begin[0].length;
    const end = ends.find((item) => (item.index ?? -1) >= afterBegin && !usedEnds.has(item.index ?? -1));
    if (end && end.index != null) {
      usedEnds.add(end.index);
    } else {
      ranges.push([start, text.length]);
    }
  }
  for (const end of ends) {
    const index = end.index;
    if (index == null || usedEnds.has(index)) continue;
    ranges.push([0, index + end[0].length]);
  }
  return applyRedactRanges(text, ranges);
}

function redactUnclosedJwt(text: string): string {
  return text.replace(new RegExp(UNCLOSED_JWT.source, "g"), "[REDACTED]");
}

function redactEdgeKeyFragments(text: string): string {
  let out = text.replace(new RegExp(TRAILING_KEY.source, "gi"), "[REDACTED]");
  out = out.replace(/^(?:[A-Za-z0-9_-]+\.){1,2}[A-Za-z0-9_-]{8,}/, (fragment) => (
    fragment.includes(".") && fragment.length >= 20 ? "[REDACTED]" : fragment
  ));
  return out;
}

function applyRedactRanges(text: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    if (start >= end) continue;
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let out = "";
  let cursor = 0;
  for (const [start, end] of merged) {
    out += text.slice(cursor, start);
    out += "[REDACTED]";
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}

function peekTokenEnd(text: string, from: number, maxExtra: number): number {
  const limit = Math.min(text.length, from + maxExtra);
  let index = from;
  while (index < limit && isSecretTokenChar(text.charCodeAt(index))) index += 1;
  return index;
}

function peekTokenStart(text: string, from: number, maxExtra: number): number {
  const limit = Math.max(0, from - maxExtra);
  let index = from;
  while (index > limit && isSecretTokenChar(text.charCodeAt(index - 1))) index -= 1;
  return index;
}

function isSecretTokenChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || code === 45
    || code === 95
    || code === 43
    || code === 47
    || code === 61
    || code === 46
  );
}

function clipRawString(text: string, maxChars = LIMITS.stringifyMaxChars): string {
  const overlap = LIMITS.redactOverlapChars;
  if (text.length <= maxChars) return text;
  const tail = Math.min(32, Math.floor(maxChars / 4));
  const head = Math.max(8, maxChars - tail);
  const headPart = text.slice(0, Math.min(text.length, head + overlap));
  const tailPart = text.slice(Math.max(0, text.length - (tail + overlap)));
  return `${headPart}…${tailPart}`;
}

function collapseWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clipRedactedDisplay(redacted: string, maxChars: number, maxBytes: number, omitted: number): string {
  const fitsChars = redacted.length <= maxChars;
  const fitsBytes = fitsChars && Buffer.byteLength(redacted, "utf8") <= maxBytes;
  if (fitsBytes) {
    if (omitted <= 0) return redacted;
    return `${redacted}…(省略 ${omitted} 字符)`;
  }
  let slice = redacted.length > maxChars ? redacted.slice(0, maxChars) : redacted;
  while (slice.length > 0 && Buffer.byteLength(slice, "utf8") > maxBytes) slice = slice.slice(0, -1);
  const keepEnd = Math.min(24, Math.floor(slice.length / 4));
  const hidden = Math.max(omitted, redacted.length - slice.length);
  if (keepEnd > 8) {
    const head = slice.slice(0, slice.length - keepEnd);
    const tail = redacted.slice(-keepEnd);
    return `${head}…(省略 ${hidden} 字符)…${tail}`;
  }
  return `${slice}…(省略 ${hidden} 字符)`;
}
