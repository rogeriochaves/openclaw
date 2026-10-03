// Side chat /catchup: builds the fixed prompt from fresh transcript rows and
// projects the parsed model answer onto the protocol's structured payload.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionCompanionCatchup } from "../../packages/gateway-protocol/src/schema/sessions.js";
import {
  parseCatchupAnswer,
  renderCatchupText,
  type CatchupAnswer,
  type CatchupItem,
} from "../agents/catchup-answer.js";
import {
  buildCatchupIndex,
  buildCatchupQuestion,
  catchupEntriesByRef,
  defaultCatchupTimeFormatter,
  type CatchupIndex,
  type CatchupTimeFormatter,
  type CatchupTranscriptRow,
} from "../agents/catchup.js";
import { resolveUserTimezone } from "../agents/date-time.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const CATCHUP_REFS_PER_ITEM = 32;

export type PreparedSessionCompanionCatchup = {
  index: CatchupIndex;
  question: string;
  formatTime: CatchupTimeFormatter;
};

export function prepareSessionCompanionCatchup(params: {
  cfg: OpenClawConfig;
  rows: CatchupTranscriptRow[];
  truncated: boolean;
}): PreparedSessionCompanionCatchup {
  const formatTime = defaultCatchupTimeFormatter(
    resolveUserTimezone(params.cfg.agents?.defaults?.userTimezone),
  );
  const index = buildCatchupIndex(params.rows, { truncated: params.truncated });
  return { index, question: buildCatchupQuestion(index, { formatTime }), formatTime };
}

function toProtocolItem(item: CatchupItem): CatchupItem {
  return { text: item.text, refs: item.refs.slice(0, CATCHUP_REFS_PER_ITEM) };
}

/** Projects a parsed answer onto the protocol shape, resolving each cited ref once. */
function toProtocolCatchup(answer: CatchupAnswer, index: CatchupIndex): SessionCompanionCatchup {
  const asked = answer.asked ? toProtocolItem(answer.asked) : undefined;
  const status = answer.status
    ? Object.assign(
        toProtocolItem(answer.status),
        answer.status.state ? { state: answer.status.state } : {},
      )
    : undefined;
  const lists = {
    facts: answer.facts.map(toProtocolItem),
    waiting: answer.waiting.map(toProtocolItem),
    blocked: answer.blocked.map(toProtocolItem),
    other: answer.other.map(toProtocolItem),
  };
  const cited = new Set<string>(answer.fullReport ? [answer.fullReport] : []);
  for (const item of [asked, status, ...Object.values(lists).flat()]) {
    item?.refs.forEach((ref) => cited.add(ref));
  }
  const refs: SessionCompanionCatchup["refs"] = [];
  for (const entry of catchupEntriesByRef(index).values()) {
    if (!cited.has(entry.ref)) {
      continue;
    }
    refs.push({
      ref: entry.ref,
      ...(entry.entryId ? { entryId: entry.entryId } : {}),
      ...(entry.ts ? { ts: Math.floor(entry.ts) } : {}),
      label: entry.label,
      excerpt: entry.excerpt,
    });
  }
  return {
    ownerMessageFound: index.lastHuman !== undefined,
    ...(index.lastHuman?.ts ? { sinceTs: Math.floor(index.lastHuman.ts) } : {}),
    ...(answer.fullReport ? { fullReport: answer.fullReport } : {}),
    ...(asked ? { asked } : {}),
    ...(status ? { status } : {}),
    ...lists,
    refs,
  };
}

/**
 * Parses the model answer. The rendered text is always returned so follow-ups
 * can replay it; the structured payload is omitted when the JSON was invalid.
 */
export function finishSessionCompanionCatchup(
  prepared: PreparedSessionCompanionCatchup,
  raw: string,
  maxChars: number,
): { answer: string; catchup?: SessionCompanionCatchup } {
  const parsed = parseCatchupAnswer(raw, prepared.index);
  const answer = truncateUtf16Safe(
    renderCatchupText(parsed, raw, prepared.index, { formatTime: prepared.formatTime }),
    maxChars,
  );
  return parsed ? { answer, catchup: toProtocolCatchup(parsed, prepared.index) } : { answer };
}
