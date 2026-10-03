// Reads the newest transcript rows for /catchup, back to the owner's last typed message.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionTranscriptBoundedMessageTailPage } from "../config/sessions/session-accessor.sqlite-active-events.js";
import { isCatchupAnchorMessage, type CatchupTranscriptRow } from "./catchup.js";

const READ_PAGE_MESSAGES = 128;
const READ_MAX_MESSAGES = 2048;
const READ_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_BACKGROUND_ROWS = 20;

export type CatchupTranscriptRead = {
  rows: CatchupTranscriptRow[];
  /** Up to `backgroundRows` rows before the owner's message, oldest first, as background only. */
  backgroundRows: CatchupTranscriptRow[];
  /** True when the read stopped at a budget before reaching an owner message. */
  truncated: boolean;
};

/**
 * Pages the active transcript from the newest message backwards and stops at
 * the first owner-typed message (plus a few earlier rows for background), so
 * the index covers exactly "since my last message" without loading the whole session.
 */
export function readCatchupTranscriptRows(
  scope: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath?: string;
  },
  options: { backgroundRows?: number } = {},
): CatchupTranscriptRead {
  const backgroundLimit = Math.max(0, options.backgroundRows ?? DEFAULT_BACKGROUND_ROWS);
  const newestFirst: CatchupTranscriptRow[] = [];
  const backgroundNewestFirst: CatchupTranscriptRow[] = [];
  let foundOwner = false;
  const finish = (truncated: boolean): CatchupTranscriptRead => ({
    rows: newestFirst.toReversed(),
    backgroundRows: backgroundNewestFirst.toReversed(),
    truncated: !foundOwner && truncated,
  });
  let offset = 0;
  let bytes = 0;
  while (offset < READ_MAX_MESSAGES && bytes < READ_MAX_BYTES) {
    const page = readSessionTranscriptBoundedMessageTailPage(scope, {
      maxBytes: READ_MAX_BYTES - bytes,
      maxMessages: Math.min(READ_PAGE_MESSAGES, READ_MAX_MESSAGES - offset),
      offset,
      readOnly: true,
    });
    // Only the contiguous newest suffix of a byte-bounded page is in order.
    const events = page.events.slice(page.events.length - page.newestContiguousEventCount);
    for (let index = events.length - 1; index >= 0; index--) {
      const event = asOptionalRecord(events[index]?.event);
      const message = event?.message;
      if (!message) {
        continue;
      }
      const entryId = typeof event.id === "string" ? event.id : undefined;
      const row = { message, ...(entryId ? { entryId } : {}) };
      if (foundOwner) {
        backgroundNewestFirst.push(row);
        if (backgroundNewestFirst.length >= backgroundLimit) {
          return finish(false);
        }
        continue;
      }
      newestFirst.push(row);
      if (isCatchupAnchorMessage(message)) {
        foundOwner = true;
        if (backgroundLimit === 0) {
          return finish(false);
        }
      }
    }
    bytes += page.serializedBytes;
    offset += page.scannedMessages;
    if (
      page.scannedMessages === 0 ||
      offset >= page.totalMessages ||
      page.newestContiguousEventCount !== page.scannedMessages
    ) {
      return finish(offset < page.totalMessages);
    }
  }
  return finish(true);
}
