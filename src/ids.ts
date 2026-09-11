import { randomUUID } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function shortId(id: string): string {
  const parts = id.split("_");
  const uuid = parts[1] ?? id;
  return uuid.slice(0, 8);
}
