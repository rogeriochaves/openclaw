// Reads the newest transcript rows for /catchup, back to the owner's last typed message.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionTranscriptBoundedMessageTailPage } from "../config/sessions/session-accessor.sqlite-active-events.js";
import { isOwnerTypedUserMessage } from "../sessions/human-input.js";
import type { CatchupTranscriptRow } from "./catchup.js";

const READ_PAGE_MESSAGES = 128;
const READ_MAX_MESSAGES = 2048;
const READ_MAX_BYTES = 8 * 1024 * 1024;

export type CatchupTranscriptRead = {
  rows: CatchupTranscriptRow[];
  /** True when the read stopped at a budget before reaching an owner message. */
  truncated: boolean;
};

/**
 * Pages the active transcript from the newest message backwards and stops at
 * the first owner-typed message, so the index covers exactly "since my last
 * message" without loading the whole session.
 */
export function readCatchupTranscriptRows(scope: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
}): CatchupTranscriptRead {
  const newestFirst: CatchupTranscriptRow[] = [];
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
      newestFirst.push({ message, ...(entryId ? { entryId } : {}) });
      if (isOwnerTypedUserMessage(message)) {
        return { rows: newestFirst.toReversed(), truncated: false };
      }
    }
    bytes += page.serializedBytes;
    offset += page.scannedMessages;
    if (
      page.scannedMessages === 0 ||
      offset >= page.totalMessages ||
      page.newestContiguousEventCount !== page.scannedMessages
    ) {
      return { rows: newestFirst.toReversed(), truncated: offset < page.totalMessages };
    }
  }
  return { rows: newestFirst.toReversed(), truncated: true };
}
