// Builds the /catchup message index and prompt: everything since the owner's last typed message.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { redactToolPayloadText } from "../logging/redact.js";
import { isOwnerTypedUserMessage } from "../sessions/human-input.js";
import {
  normalizeInputProvenance,
  stripInterSessionPromptPrefixForDisplay,
} from "../sessions/input-provenance.js";
import { extractStoredAssistantText } from "./tools/chat-history-text.js";

/** One stored transcript row; entryId is the transcript entry id when the reader has it. */
export type CatchupTranscriptRow = {
  message: unknown;
  entryId?: string;
};

export type CatchupIndexEntry = {
  /** Citation id the model uses, "m0" is the owner's last message. */
  ref: string;
  role: "user" | "assistant";
  /** Who wrote it, in plain words: "you", "agent", "cron", "message from agent:x:y". */
  label: string;
  ts?: number;
  text: string;
  excerpt: string;
  entryId?: string;
  /** Channel message id when the row came from a chat channel (quote target). */
  channelMessageId?: string;
  channel?: string;
  /** Conversation the row arrived in, so a quote is only sent back to the same chat. */
  conversationRef?: string;
};

export type CatchupIndex = {
  /** Owner's last typed message, or undefined when none was found in the window. */
  lastHuman?: CatchupIndexEntry;
  /** Rows after the owner's last message, oldest first. */
  entries: CatchupIndexEntry[];
  /** True when the reader stopped before finding the owner's message. */
  truncated: boolean;
};

const EXCERPT_CHARS = 100;
const LAST_HUMAN_PREVIEW_CHARS = 200;
const ENTRY_MAX_CHARS = 1500;
const LONG_ENTRY_MAX_CHARS = 8000;
const PROMPT_BODY_MAX_CHARS = 60_000;
const WINDOW_WITHOUT_HUMAN = 40;

function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function readUserText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      const record = asOptionalRecord(block);
      if (record?.type === "text" && typeof record.text === "string") {
        return record.text;
      }
      return record?.type === "image" ? "[image]" : "";
    })
    .filter(Boolean)
    .join("\n");
}

function readTimestamp(message: Record<string, unknown>): number | undefined {
  const value = message.timestamp;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function describeUserSource(message: Record<string, unknown>): string {
  const provenance = normalizeInputProvenance(message.provenance);
  const tool = provenance?.sourceTool?.toLowerCase();
  if (provenance?.kind === "inter_session") {
    if (tool === "subagent_announce" || tool === "subagent_settle") {
      return "subagent report";
    }
    return provenance.sourceSessionKey
      ? `message from ${provenance.sourceSessionKey}`
      : "message from another session";
  }
  if (provenance?.kind === "internal_system") {
    if (tool === "cron") {
      return "cron";
    }
    if (tool === "heartbeat") {
      return "heartbeat";
    }
    if (tool === "exec") {
      return "command finished";
    }
    if (tool?.includes("restart")) {
      return "restart notice";
    }
    return "system event";
  }
  return "message not typed by you";
}

function readChannelFacts(message: Record<string, unknown>): {
  channel?: string;
  channelMessageId?: string;
  conversationRef?: string;
} {
  const transport = asOptionalRecord(asOptionalRecord(message["__openclaw"])?.transport);
  const channel = normalizeOptionalString(transport?.channel);
  const channelMessageId = normalizeOptionalString(transport?.messageId);
  const conversationRef = normalizeOptionalString(transport?.conversationRef);
  return {
    ...(channel ? { channel } : {}),
    ...(channel && channelMessageId ? { channelMessageId } : {}),
    ...(channel && conversationRef ? { conversationRef } : {}),
  };
}

// /main appends the side chat it brought along; the owner's own words come first.
const SIDE_CHAT_CONTEXT_RE = /\n*<side_chat_context>[\s\S]*?<\/side_chat_context>/gu;

function stripSideChatContext(text: string): string {
  return text.replace(SIDE_CHAT_CONTEXT_RE, "");
}

function toIndexEntry(
  row: CatchupTranscriptRow,
  ref: string,
  ownerTyped: boolean,
): CatchupIndexEntry | undefined {
  const message = asOptionalRecord(row.message);
  const role = message?.role;
  if (!message || (role !== "user" && role !== "assistant")) {
    return undefined;
  }
  const raw =
    role === "assistant"
      ? (extractStoredAssistantText(message) ?? "")
      : stripSideChatContext(stripInterSessionPromptPrefixForDisplay(readUserText(message)));
  const text = redactToolPayloadText(raw).trim();
  if (!text) {
    return undefined;
  }
  const ts = readTimestamp(message);
  return {
    ref,
    role,
    label: role === "assistant" ? "agent" : ownerTyped ? "you" : describeUserSource(message),
    ...(ts ? { ts } : {}),
    text,
    excerpt: truncateUtf16Safe(collapse(text), EXCERPT_CHARS),
    ...(row.entryId ? { entryId: row.entryId } : {}),
    ...(role === "user" ? readChannelFacts(message) : {}),
  };
}

/**
 * Numbers every user/assistant row after the owner's last typed message.
 * Rows must be in transcript order. When no owner message is found the last
 * rows are indexed instead, so the answer still covers recent work.
 */
export function buildCatchupIndex(
  rows: readonly CatchupTranscriptRow[],
  options: { truncated?: boolean } = {},
): CatchupIndex {
  let humanIndex = -1;
  for (let index = rows.length - 1; index >= 0; index--) {
    if (isOwnerTypedUserMessage(rows[index]?.message)) {
      humanIndex = index;
      break;
    }
  }
  const lastHumanRow = humanIndex >= 0 ? rows[humanIndex] : undefined;
  const lastHuman = lastHumanRow ? toIndexEntry(lastHumanRow, "m0", true) : undefined;
  const after = humanIndex >= 0 ? rows.slice(humanIndex + 1) : rows.slice(-WINDOW_WITHOUT_HUMAN);
  const entries: CatchupIndexEntry[] = [];
  for (const row of after) {
    const entry = toIndexEntry(row, `m${entries.length + 1}`, false);
    if (entry) {
      entries.push(entry);
    }
  }
  return {
    ...(lastHuman ? { lastHuman } : {}),
    entries,
    truncated: humanIndex < 0 && options.truncated === true,
  };
}

/** Index of rows by citation id, including the owner's message as m0. */
export function catchupEntriesByRef(index: CatchupIndex): Map<string, CatchupIndexEntry> {
  const byRef = new Map<string, CatchupIndexEntry>();
  if (index.lastHuman) {
    byRef.set(index.lastHuman.ref, index.lastHuman);
  }
  for (const entry of index.entries) {
    byRef.set(entry.ref, entry);
  }
  return byRef;
}

export type CatchupTimeFormatter = (ts: number) => string;

export function defaultCatchupTimeFormatter(timeZone?: string): CatchupTimeFormatter {
  return (ts) => {
    try {
      return new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        ...(timeZone ? { timeZone } : {}),
      }).format(new Date(ts));
    } catch {
      return new Date(ts).toISOString().slice(11, 16);
    }
  };
}

function formatEntryHeader(entry: CatchupIndexEntry, formatTime: CatchupTimeFormatter): string {
  const time = entry.ts ? `${formatTime(entry.ts)} ` : "";
  return `[${entry.ref}] ${time}${entry.label} (${entry.text.length} chars)`;
}

function selectEntryBodies(entries: readonly CatchupIndexEntry[]): string[] {
  // The longest agent message is most likely the main report, so it keeps more text.
  let longest: CatchupIndexEntry | undefined;
  for (const entry of entries) {
    if (entry.role === "assistant" && entry.text.length > (longest?.text.length ?? 0)) {
      longest = entry;
    }
  }
  const bodies = entries.map((entry) =>
    truncateUtf16Safe(entry.text, entry === longest ? LONG_ENTRY_MAX_CHARS : ENTRY_MAX_CHARS),
  );
  let total = bodies.reduce((sum, body) => sum + body.length, 0);
  // Over budget: shrink the oldest rows to their excerpt first; newest rows matter most.
  for (let index = 0; index < bodies.length && total > PROMPT_BODY_MAX_CHARS; index++) {
    if (entries[index] === longest) {
      continue;
    }
    const excerpt = entries[index]!.excerpt;
    total -= bodies[index]!.length - excerpt.length;
    bodies[index] = excerpt;
  }
  return bodies;
}

/** The fixed /catchup question sent to the side model, with the numbered messages inline. */
export function buildCatchupQuestion(
  index: CatchupIndex,
  options: { formatTime?: CatchupTimeFormatter } = {},
): string {
  const formatTime = options.formatTime ?? defaultCatchupTimeFormatter();
  const lines: string[] = ["/catchup: I was away. Catch me up."];
  if (index.lastHuman) {
    const preview = truncateUtf16Safe(collapse(index.lastHuman.text), LAST_HUMAN_PREVIEW_CHARS);
    const ellipsis = collapse(index.lastHuman.text).length > preview.length ? "..." : "";
    const at = index.lastHuman.ts ? ` at ${formatTime(index.lastHuman.ts)}` : "";
    lines.push(
      `Since I sent this message${at}: "${preview}${ellipsis}"`,
      "",
      "My message, in full:",
      `${formatEntryHeader(index.lastHuman, formatTime)}`,
      truncateUtf16Safe(index.lastHuman.text, ENTRY_MAX_CHARS),
    );
  } else {
    lines.push(
      "I could not find a message I typed myself in the recent history, so this covers the latest messages.",
    );
  }
  lines.push("", "Everything that arrived after it, numbered, oldest first:", "<catchup_messages>");
  if (index.entries.length === 0) {
    lines.push("(nothing new)");
  }
  const bodies = selectEntryBodies(index.entries);
  index.entries.forEach((entry, position) => {
    lines.push(formatEntryHeader(entry, formatTime), bodies[position]!, "");
  });
  lines.push(
    "</catchup_messages>",
    "",
    'Messages labeled other than "you" were not typed by me, even in the user role: they come from other agents, crons, heartbeats, subagents or scripts.',
    "",
    "Reply with only one JSON object, no code fence, no other text:",
    '{"fullReport":"m7","asked":{"text":"...","refs":["m0"]},"status":{"state":"done|in_progress|stopped","text":"...","refs":["m7"]},"facts":[{"text":"...","refs":["m7"]}],"waiting":[],"blocked":[],"other":[]}',
    "Fields:",
    "- fullReport: ref of the agent's main long report on what I asked, or null if there is none.",
    "- asked: what I asked, one line.",
    "- status: where it stands now, done, in progress or stopped, one or two lines.",
    "- facts: key facts to pay attention to in the result. Point to the report, do not restate it.",
    "- waiting: actions and decisions only I can take.",
    "- blocked: what is blocked or failed.",
    "- other: what else happened since (other agents, crons, subagents, background work), one line each.",
    "Rules: cite the refs each item comes from. Leave a list empty when there is nothing. Very condensed. Plain words, short sentences, no jargon, no em dashes. Never invent refs.",
  );
  return lines.join("\n");
}
