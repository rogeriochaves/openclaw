// Shared helpers of the claude-cli background work readers.
import { redactToolDetail } from "../logging/redact.js";

const MAX_TEXT_CHARS = 240;

/** One redacted line, clipped for a status row. */
export function safeBackgroundText(text: string, max = MAX_TEXT_CHARS): string {
  const flat = redactToolDetail(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Drops the oldest entries of an insertion-ordered cache past `max`. */
export function boundCache<K, V>(cache: Map<K, V>, max = 512): void {
  while (cache.size > max) {
    cache.delete(cache.keys().next().value!);
  }
}
