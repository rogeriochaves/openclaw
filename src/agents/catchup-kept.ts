// Keeps the last /catchup answer per session so a repeat with nothing new in
// the session returns it without another model run.
// Process-local by design: a Gateway restart drops kept catch-ups and the next
// /catchup runs fresh.
import type { CatchupIndex, CatchupIndexEntry } from "./catchup.js";

const KEPT_CATCHUP_MAX_SESSIONS = 256;

function entryKey(entry: CatchupIndexEntry | undefined): string {
  if (!entry) {
    return "-";
  }
  return entry.entryId ?? `${entry.role}:${entry.ts ?? ""}:${entry.text.length}:${entry.excerpt}`;
}

/**
 * Identifies what a catch-up covered: the session, the owner's message it
 * started from, and the newest message in its index. Side-chat follow-ups never
 * enter the transcript, so they do not change it; a turn in the main chat does.
 */
export function catchupCoverageKey(sessionId: string, index: CatchupIndex): string {
  return [
    sessionId,
    entryKey(index.lastHuman),
    entryKey(index.entries.at(-1)),
    String(index.entries.length),
  ].join("\u0000");
}

export type KeptCatchupStore<T> = {
  /** Returns the kept value when it covered exactly this coverage key. */
  get: (scopeKey: string, coverageKey: string) => T | undefined;
  set: (scopeKey: string, coverageKey: string, value: T) => void;
  delete: (scopeKey: string) => void;
  clear: () => void;
};

export function createKeptCatchupStore<T>(
  maxSessions = KEPT_CATCHUP_MAX_SESSIONS,
): KeptCatchupStore<T> {
  const kept = new Map<string, { coverageKey: string; value: T }>();
  return {
    get(scopeKey, coverageKey) {
      const entry = kept.get(scopeKey);
      return entry?.coverageKey === coverageKey ? entry.value : undefined;
    },
    set(scopeKey, coverageKey, value) {
      // Re-insert so Map order tracks recency for the session cap below.
      kept.delete(scopeKey);
      kept.set(scopeKey, { coverageKey, value });
      while (kept.size > maxSessions) {
        const oldest = kept.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        kept.delete(oldest);
      }
    },
    delete(scopeKey) {
      kept.delete(scopeKey);
    },
    clear() {
      kept.clear();
    },
  };
}
