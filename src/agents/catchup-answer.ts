// Parses the /catchup model answer and renders it as plain text for channels and the TUI.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  catchupEntriesByRef,
  defaultCatchupTimeFormatter,
  type CatchupIndex,
  type CatchupIndexEntry,
  type CatchupTimeFormatter,
} from "./catchup.js";

export type CatchupItem = { text: string; refs: string[] };

export type CatchupStatusState = "done" | "in_progress" | "stopped";

export type CatchupAnswer = {
  fullReport?: string;
  asked?: CatchupItem;
  status?: CatchupItem & { state?: CatchupStatusState };
  facts: CatchupItem[];
  waiting: CatchupItem[];
  blocked: CatchupItem[];
  other: CatchupItem[];
};

const ITEM_MAX_CHARS = 400;
const LIST_MAX_ITEMS = 8;

/** Plain-language rule: no em or en dashes in catch-up text. */
export function stripCatchupDashes(text: string): string {
  return text
    .replace(/\s*[\u2014\u2013]\s*/gu, ", ")
    .replace(/,\s*,/gu, ",")
    .trim();
}

function readItem(value: unknown, knownRefs: ReadonlySet<string>): CatchupItem | undefined {
  const record = asOptionalRecord(value);
  const rawText = typeof value === "string" ? value : record?.text;
  if (typeof rawText !== "string") {
    return undefined;
  }
  const text = truncateUtf16Safe(stripCatchupDashes(rawText.replace(/\s+/gu, " ")), ITEM_MAX_CHARS);
  if (!text) {
    return undefined;
  }
  const refs = Array.isArray(record?.refs)
    ? [
        ...new Set(
          record.refs
            .filter((ref): ref is string => typeof ref === "string")
            .map((ref) => ref.trim().replace(/^\[|\]$/gu, ""))
            .filter((ref) => knownRefs.has(ref)),
        ),
      ]
    : [];
  return { text, refs };
}

function readList(value: unknown, knownRefs: ReadonlySet<string>): CatchupItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => readItem(item, knownRefs))
    .filter((item): item is CatchupItem => item !== undefined)
    .slice(0, LIST_MAX_ITEMS);
}

function extractJsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Returns undefined when the model did not return the expected JSON; callers fall back to text. */
export function parseCatchupAnswer(raw: string, index: CatchupIndex): CatchupAnswer | undefined {
  const parsed = asOptionalRecord(extractJsonObject(raw));
  if (!parsed) {
    return undefined;
  }
  const knownRefs = new Set(catchupEntriesByRef(index).keys());
  const asked = readItem(parsed.asked, knownRefs);
  const statusItem = readItem(parsed.status, knownRefs);
  const rawState = asOptionalRecord(parsed.status)?.state;
  const state =
    rawState === "done" || rawState === "in_progress" || rawState === "stopped"
      ? rawState
      : undefined;
  const fullReport =
    typeof parsed.fullReport === "string" && knownRefs.has(parsed.fullReport.trim())
      ? parsed.fullReport.trim()
      : undefined;
  const answer: CatchupAnswer = {
    ...(fullReport ? { fullReport } : {}),
    ...(asked ? { asked } : {}),
    ...(statusItem ? { status: { ...statusItem, ...(state ? { state } : {}) } } : {}),
    facts: readList(parsed.facts, knownRefs),
    waiting: readList(parsed.waiting, knownRefs),
    blocked: readList(parsed.blocked, knownRefs),
    other: readList(parsed.other, knownRefs),
  };
  const empty =
    !answer.asked &&
    !answer.status &&
    !answer.fullReport &&
    answer.facts.length + answer.waiting.length + answer.blocked.length + answer.other.length === 0;
  return empty ? undefined : answer;
}

export const CATCHUP_SECTION_TITLES = {
  asked: "What you asked",
  status: "Where it stands",
  facts: "Key facts",
  waiting: "Waiting on you",
  blocked: "Blocked or failed",
  other: "Also happened",
} as const;

const STATUS_WORDS: Record<CatchupStatusState, string> = {
  done: "Done",
  in_progress: "In progress",
  stopped: "Stopped",
};

export function catchupRefNumber(ref: string): string {
  return ref.replace(/^m/u, "");
}

function renderRefs(refs: readonly string[]): string {
  return refs.length === 0 ? "" : ` ${refs.map((ref) => `[${catchupRefNumber(ref)}]`).join("")}`;
}

function renderEntryLine(entry: CatchupIndexEntry, formatTime: CatchupTimeFormatter): string {
  const time = entry.ts ? `${formatTime(entry.ts)} ` : "";
  return `[${catchupRefNumber(entry.ref)}] ${time}${entry.label}: "${entry.excerpt}"`;
}

/**
 * Text rendering for surfaces without a native catch-up view. References are
 * numbered and listed at the end with time and a short excerpt.
 */
export function renderCatchupText(
  answer: CatchupAnswer | undefined,
  rawFallback: string,
  index: CatchupIndex,
  options: { formatTime?: CatchupTimeFormatter } = {},
): string {
  const formatTime = options.formatTime ?? defaultCatchupTimeFormatter();
  const byRef = catchupEntriesByRef(index);
  const header = index.lastHuman
    ? `Catch-up since your message${index.lastHuman.ts ? ` at ${formatTime(index.lastHuman.ts)}` : ""}`
    : "Catch-up on recent messages";
  if (!answer) {
    return [header, "", stripCatchupDashes(rawFallback)].join("\n");
  }
  const lines: string[] = [header];
  const cited = new Set<string>();
  const cite = (refs: readonly string[]) => refs.forEach((ref) => cited.add(ref));
  if (answer.fullReport) {
    const report = byRef.get(answer.fullReport);
    cite([answer.fullReport]);
    lines.push(
      "",
      `Full report: [${catchupRefNumber(answer.fullReport)}]${report?.ts ? ` ${formatTime(report.ts)}` : ""}`,
    );
  }
  const pushSection = (title: string, items: readonly CatchupItem[], prefix?: string) => {
    if (items.length === 0) {
      return;
    }
    lines.push("", `**${title}**`);
    items.forEach((item, position) => {
      cite(item.refs);
      const text = position === 0 && prefix ? `${prefix}. ${item.text}` : item.text;
      lines.push(`- ${text}${renderRefs(item.refs)}`);
    });
  };
  pushSection(CATCHUP_SECTION_TITLES.asked, answer.asked ? [answer.asked] : []);
  pushSection(
    CATCHUP_SECTION_TITLES.status,
    answer.status ? [answer.status] : [],
    answer.status?.state ? STATUS_WORDS[answer.status.state] : undefined,
  );
  pushSection(CATCHUP_SECTION_TITLES.facts, answer.facts);
  pushSection(CATCHUP_SECTION_TITLES.waiting, answer.waiting);
  pushSection(CATCHUP_SECTION_TITLES.blocked, answer.blocked);
  pushSection(CATCHUP_SECTION_TITLES.other, answer.other);
  const refLines = [...byRef.values()]
    .filter((entry) => cited.has(entry.ref))
    .map((entry) => renderEntryLine(entry, formatTime));
  if (refLines.length > 0) {
    lines.push("", "**Refs**", ...refLines);
  }
  return lines.join("\n");
}
