// In-memory side-chat threads: recent /btw and /catchup exchanges per session,
// used to continue the side chat or to bring it into the main conversation.
// Process-local by design: a Gateway restart ends every side thread.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createKeptCatchupStore } from "../../agents/catchup-kept.js";

export type SideThreadKind = "btw" | "catchup";

export type SideThreadExchange = {
  kind: SideThreadKind;
  question: string;
  answer: string;
  ts: number;
};

const SIDE_THREAD_TTL_MS = 60 * 60 * 1000;
const SIDE_THREAD_MAX_EXCHANGES = 8;
const SIDE_THREAD_MAX_CHARS = 24 * 1024;
const SIDE_THREAD_MAX_SESSIONS = 256;
// A quoted chunk shorter than this is too generic to identify a side answer.
const QUOTE_MATCH_MIN_CHARS = 24;
const QUOTE_MATCH_PROBE_CHARS = 160;

// Banners that start every side answer delivered to text-only channels.
const SIDE_ANSWER_BANNER_RE =
  /^(?:BTW\s+Question:|Catch-up since your message|Catch-up on recent messages)/u;

const threads = new Map<string, SideThreadExchange[]>();
// Last rendered /catchup per session, returned again while nothing new arrives.
const keptCatchups = createKeptCatchupStore<string>();

/** The kept catch-up text when it covered exactly `coverageKey`. */
export function readKeptCatchup(sessionKey: string, coverageKey: string): string | undefined {
  return keptCatchups.get(sessionKey, coverageKey);
}

export function keepCatchup(sessionKey: string, coverageKey: string, text: string): void {
  keptCatchups.set(sessionKey, coverageKey, text);
}

function exchangeChars(exchange: SideThreadExchange): number {
  return exchange.question.length + exchange.answer.length;
}

function liveExchanges(sessionKey: string, now: number): SideThreadExchange[] {
  const exchanges = threads.get(sessionKey);
  if (!exchanges) {
    return [];
  }
  // The thread lives while the side chat is active: TTL counts from the newest exchange.
  const newest = exchanges.at(-1);
  if (!newest || now - newest.ts > SIDE_THREAD_TTL_MS) {
    threads.delete(sessionKey);
    return [];
  }
  return exchanges;
}

function pruneExpired(now: number): void {
  for (const key of threads.keys()) {
    liveExchanges(key, now);
  }
}

/** Records a successful side answer for later follow-ups. */
export function recordSideThreadExchange(
  sessionKey: string,
  exchange: Omit<SideThreadExchange, "ts"> & { ts?: number },
): void {
  const question = exchange.question.trim();
  const answer = exchange.answer.trim();
  if (!sessionKey || !answer) {
    return;
  }
  const now = exchange.ts ?? Date.now();
  pruneExpired(now);
  const exchanges = [...liveExchanges(sessionKey, now), { ...exchange, question, answer, ts: now }];
  while (exchanges.length > SIDE_THREAD_MAX_EXCHANGES) {
    exchanges.shift();
  }
  let chars = exchanges.reduce((sum, entry) => sum + exchangeChars(entry), 0);
  // Keep at least the newest exchange even when it alone is over budget.
  while (exchanges.length > 1 && chars > SIDE_THREAD_MAX_CHARS) {
    chars -= exchangeChars(exchanges.shift()!);
  }
  // Re-insert so Map order tracks recency for the session cap below.
  threads.delete(sessionKey);
  threads.set(sessionKey, exchanges);
  while (threads.size > SIDE_THREAD_MAX_SESSIONS) {
    const oldest = threads.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    threads.delete(oldest);
  }
}

/** Live exchanges for a session, oldest first; empty when there is no side thread. */
export function readSideThread(sessionKey: string, now = Date.now()): SideThreadExchange[] {
  return [...liveExchanges(sessionKey, now)];
}

export function clearSideThread(sessionKey: string): void {
  threads.delete(sessionKey);
}

/** Test-only reset of every side thread and kept catch-up. */
export function resetSideThreadsForTest(): void {
  threads.clear();
  keptCatchups.clear();
}

// Channels re-render markdown and may add prefixes, so compare loosely.
function normalizeForQuoteMatch(text: string): string {
  return text
    .replace(/[*_~`>#]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/** True when a quoted channel message starts with a side-answer banner. */
export function hasSideAnswerBanner(quotedText: string): boolean {
  return SIDE_ANSWER_BANNER_RE.test(quotedText.trimStart().replace(/^[*_]+/u, ""));
}

/**
 * True when the quoted text is one of the stored side answers for any live
 * thread. Channels may split long answers into several messages, so a quoted
 * chunk matches when it is contained in a stored answer, or when it contains
 * the start of one (banner or prefix added by the channel).
 */
export function isQuotedSideAnswer(quotedText: string, now = Date.now()): boolean {
  const quote = normalizeForQuoteMatch(quotedText);
  if (quote.length < QUOTE_MATCH_MIN_CHARS) {
    return false;
  }
  const probe = quote.slice(0, QUOTE_MATCH_PROBE_CHARS);
  for (const key of threads.keys()) {
    for (const exchange of liveExchanges(key, now)) {
      const answer = normalizeForQuoteMatch(exchange.answer);
      if (answer.includes(probe) || quote.includes(answer.slice(0, QUOTE_MATCH_PROBE_CHARS))) {
        return true;
      }
    }
  }
  return false;
}

/** Quoted text for an inbound reply, preferring the exact quoted fragment. */
export function readQuotedText(ctx: {
  ReplyToBody?: string;
  ReplyToQuoteText?: string;
}): string | undefined {
  return normalizeOptionalString(ctx.ReplyToQuoteText) ?? normalizeOptionalString(ctx.ReplyToBody);
}

function formatExchanges(exchanges: readonly SideThreadExchange[]): string[] {
  return exchanges.flatMap((exchange) => [
    `Owner: ${exchange.question}`,
    `Side assistant: ${exchange.answer}`,
    "",
  ]);
}

/** Side question text that carries the earlier side-chat turns before the new question. */
export function buildSideThreadQuestion(
  exchanges: readonly SideThreadExchange[],
  question: string,
): string {
  if (exchanges.length === 0) {
    return question;
  }
  return [
    "Earlier in this side chat, between the owner and you (the side assistant), oldest first:",
    "<side_chat_history>",
    ...formatExchanges(exchanges),
    "</side_chat_history>",
    "",
    "The owner's new side question, continuing that side chat:",
    question,
  ].join("\n");
}

/** Main-conversation body: the owner's text followed by the side exchanges as context. */
export function buildMainTextWithSideContext(
  text: string,
  exchanges: readonly SideThreadExchange[],
): string {
  if (exchanges.length === 0) {
    return text;
  }
  return [
    text,
    "",
    "<side_chat_context>",
    "Earlier side chat between the owner and a side assistant, outside this conversation, oldest first. The owner brought it here as context for the message above.",
    "",
    ...formatExchanges(exchanges),
    "</side_chat_context>",
  ].join("\n");
}
