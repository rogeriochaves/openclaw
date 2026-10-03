// Aligns local CLI rows with imported Claude history so a reply or a queued
// prompt does not render twice.
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
  undecoratedText?: string;
  timestamp?: number;
  suppressed?: boolean;
};

const CLI_ASSISTANT_IDEMPOTENCY_PREFIX = "cli-assistant:";
const ABORTED_PARTIAL_IDEMPOTENCY_SUFFIX = ":assistant";
// Bounds the backward join when imported turns have no local user boundary.
const MAX_JOINED_SEGMENTS = 64;

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

// Returns the run id of a CLI runner aggregate or of the gateway's aborted
// partial for the same run. Both join the run's text, so both can repeat it.
function readCliAssistantAggregateRunId(entry: ComparableHistoryMessage): string | undefined {
  if (entry.role !== "assistant" || !entry.text || entry.externalIdentityKey) {
    return undefined;
  }
  const message = asOptionalRecord(entry.message);
  const meta = asOptionalRecord(message?.["__openclaw"]);
  const idempotencyKey =
    normalizeOptionalString(message?.idempotencyKey) ??
    normalizeOptionalString(meta?.idempotencyKey);
  if (!idempotencyKey || readTextOnlyContent(entry.message) === undefined) {
    return undefined;
  }
  if (idempotencyKey.startsWith(CLI_ASSISTANT_IDEMPOTENCY_PREFIX)) {
    return idempotencyKey.slice(CLI_ASSISTANT_IDEMPOTENCY_PREFIX.length) || undefined;
  }
  const abortRunId = normalizeOptionalString(asOptionalRecord(message?.openclawAbort)?.runId);
  return abortRunId && idempotencyKey === `${abortRunId}${ABORTED_PARTIAL_IDEMPOTENCY_SUFFIX}`
    ? abortRunId
    : undefined;
}

// A prompt sent while a run is busy keeps its send time but is written after
// that run's reply, and Claude records it when the queue delivers it. It
// cannot have reached Claude before the row stored ahead of it, so match it
// from there.
export function liftQueuedPromptTimestamps(localEntries: ComparableHistoryMessage[]): void {
  let previousTimestamp: number | undefined;
  for (const entry of localEntries) {
    if (
      entry.role === "user" &&
      entry.timestamp !== undefined &&
      previousTimestamp !== undefined &&
      previousTimestamp > entry.timestamp
    ) {
      entry.timestamp = previousTimestamp;
    }
    previousTimestamp = entry.timestamp ?? previousTimestamp;
  }
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
  const runIds = new Map<ComparableHistoryMessage, string>();
  // Only a prompt OpenClaw also recorded starts a new run. A live Claude
  // process can wake itself for background task notifications, and Claude
  // records oversized or tool-result rows as user rows; the runner keeps
  // joining text across all of them into the same aggregate.
  const localUserTexts = new Set<string>();
  for (const entry of localEntries) {
    if (entry.role === "user" && entry.text) {
      localUserTexts.add(entry.text);
      continue;
    }
    const runId = entry.text ? readCliAssistantAggregateRunId(entry) : undefined;
    if (entry.text && runId) {
      runIds.set(entry, runId);
      const candidates = aggregatesByText.get(entry.text) ?? [];
      candidates.push(entry);
      aggregatesByText.set(entry.text, candidates);
    }
  }
  if (aggregatesByText.size === 0) {
    return false;
  }
  const startsLocalRun = (imported: ComparableHistoryMessage) =>
    [imported.text, imported.undecoratedText].some(
      (text) => text !== undefined && localUserTexts.has(text),
    );
  let projected = false;
  let turnSegments: ComparableHistoryMessage[] = [];
  for (const message of importedMessages) {
    const imported = params.prepare(message);
    if (imported.role === "user") {
      if (startsLocalRun(imported)) {
        turnSegments = [];
      }
      continue;
    }
    if (imported.role !== "assistant" || !imported.text) {
      continue;
    }
    turnSegments.push(imported);
    if (turnSegments.length > MAX_JOINED_SEGMENTS) {
      turnSegments.shift();
    }
    const finalText = readTextOnlyContent(imported.message);
    if (finalText === undefined) {
      continue;
    }
    let joined = "";
    for (let start = turnSegments.length - 1; start >= 0; start -= 1) {
      const segment = turnSegments[start];
      joined = joined ? `${segment?.text ?? ""} ${joined}` : (segment?.text ?? "");
      const candidates = aggregatesByText.get(joined);
      // The aggregate lands when the run ends, which can be long after the
      // final segment when background work keeps the CLI process alive.
      const matchIndex =
        candidates?.findIndex(
          (candidate) =>
            candidate.timestamp === undefined ||
            segment?.timestamp === undefined ||
            candidate.timestamp >= segment.timestamp - params.timestampWindowMs,
        ) ?? -1;
      const aggregate = matchIndex >= 0 ? candidates?.splice(matchIndex, 1)[0] : undefined;
      if (!aggregate) {
        continue;
      }
      const runId = runIds.get(aggregate);
      for (const sibling of candidates ?? []) {
        if (runIds.get(sibling) === runId) {
          sibling.suppressed = true;
        }
      }
      if (candidates) {
        aggregatesByText.set(
          joined,
          candidates.filter((candidate) => !candidate.suppressed),
        );
      }
      const local = asOptionalRecord(aggregate.message) ?? {};
      aggregate.message = { ...local, content: [{ type: "text", text: finalText }] };
      aggregate.text = imported.text;
      // Match the final segment inside the dedupe window; display order then
      // follows the native row instead of the late run end.
      aggregate.timestamp = imported.timestamp ?? aggregate.timestamp;
      projected = true;
      turnSegments = [];
      break;
    }
  }
  return projected;
}
