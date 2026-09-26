// Collapses the CLI runner's joined assistant reply onto its final segment
// so imported Claude history does not render the same answer twice.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";

type ComparableHistoryMessage = {
  message: unknown;
  externalIdentityKey?: string;
  role?: string;
  text?: string;
  timestamp?: number;
};

const CLI_ASSISTANT_IDEMPOTENCY_PREFIX = "cli-assistant:";

// Returns the joined text of a text-only message, or undefined when it also
// carries tool calls, media, or other non-text blocks.
function readTextOnlyContent(message: unknown): string | undefined {
  const content = asOptionalRecord(message)?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const texts: string[] = [];
  for (const block of content) {
    const record = asOptionalRecord(block);
    const text = record?.type === "text" ? readStringValue(record.text) : undefined;
    if (text === undefined) {
      return undefined;
    }
    texts.push(text);
  }
  return texts.join("\n");
}

function isCliAssistantAggregate(entry: ComparableHistoryMessage): boolean {
  if (entry.role !== "assistant" || !entry.text || entry.externalIdentityKey) {
    return false;
  }
  const message = asOptionalRecord(entry.message);
  const meta = asOptionalRecord(message?.["__openclaw"]);
  const idempotencyKey =
    normalizeOptionalString(message?.idempotencyKey) ??
    normalizeOptionalString(meta?.idempotencyKey);
  return (
    idempotencyKey?.startsWith(CLI_ASSISTANT_IDEMPOTENCY_PREFIX) === true &&
    readTextOnlyContent(entry.message) !== undefined
  );
}

// The CLI runner persists one assistant row per turn whose text joins every
// text block of that turn, while the imported Claude history keeps each block
// as its own row between tool calls. Neither equals the other when a turn has
// progress text before the answer, so both rendered and the answer showed
// twice. When a local aggregate equals the joined imported text segments of
// one turn, keep the local row as the display owner of the final segment only;
// the earlier segments stay as imported progress rows next to their tool calls,
// and the final imported segment then dedupes against the projected row.
export function projectCliAssistantAggregatesOntoFinalSegment(params: {
  localEntries: ComparableHistoryMessage[];
  importedMessages: unknown[];
  prepare: (message: unknown) => ComparableHistoryMessage;
  timestampWindowMs: number;
}): boolean {
  const { localEntries, importedMessages } = params;
  const aggregatesByText = new Map<string, ComparableHistoryMessage[]>();
  for (const entry of localEntries) {
    if (entry.text && isCliAssistantAggregate(entry)) {
      const candidates = aggregatesByText.get(entry.text) ?? [];
      candidates.push(entry);
      aggregatesByText.set(entry.text, candidates);
    }
  }
  if (aggregatesByText.size === 0) {
    return false;
  }
  let projected = false;
  let turnSegments: ComparableHistoryMessage[] = [];
  for (const message of importedMessages) {
    const imported = params.prepare(message);
    if (imported.role === "user") {
      turnSegments = [];
      continue;
    }
    if (imported.role !== "assistant" || !imported.text) {
      continue;
    }
    turnSegments.push(imported);
    const finalText = readTextOnlyContent(imported.message);
    if (turnSegments.length < 2 || finalText === undefined) {
      continue;
    }
    let joined = imported.text;
    for (let start = turnSegments.length - 2; start >= 0; start -= 1) {
      joined = `${turnSegments[start]?.text ?? ""} ${joined}`;
      const candidates = aggregatesByText.get(joined);
      const matchIndex =
        candidates?.findIndex(
          (candidate) =>
            candidate.timestamp === undefined ||
            imported.timestamp === undefined ||
            Math.abs(candidate.timestamp - imported.timestamp) <= params.timestampWindowMs,
        ) ?? -1;
      const aggregate = matchIndex >= 0 ? candidates?.splice(matchIndex, 1)[0] : undefined;
      if (!aggregate) {
        continue;
      }
      const local = asOptionalRecord(aggregate.message) ?? {};
      aggregate.message = { ...local, content: [{ type: "text", text: finalText }] };
      aggregate.text = imported.text;
      projected = true;
      turnSegments = [];
      break;
    }
  }
  return projected;
}
