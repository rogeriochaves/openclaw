// Read-only view of the native subagents (Claude Code `Agent`/`Task` tool) that a
// claude-cli backed session spawned. Claude Code owns these transcripts: it writes
// each one to `<session>/subagents/agent-<id>.jsonl` next to an `agent-<id>.meta.json`
// whose `toolUseId` names the parent's spawning tool call. This module only reads
// them, bounded, from the Claude sessions of the OpenClaw session.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isToolResultBlock } from "../chat/tool-content.js";
import {
  appendCoalescedClaudeCliToolMessage,
  decodeClaudeCliProjectEntry,
  parseClaudeCliHistoryEntry,
  redactClaudeCliHistoryMessage,
  resolveClaudeCliSessionFilePathAsync,
  type ClaudeCliProjectEntry,
} from "./cli-session-history.claude.js";

const META_FILE_PATTERN = /^agent-([A-Za-z0-9_-]{1,128})\.meta\.json$/;
const MAX_META_FILES = 512;
const MAX_META_BYTES = 64 * 1024;
// Claude Code also writes large non-message rows (skill and tool listings), often
// hundreds of KB each, so a short tail window would hide the first tool calls. Read
// from the start, paging forward, unless the transcript is unusually long.
const INITIAL_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_READ_BYTES = 512 * 1024;
const STATUS_TAIL_WINDOWS = [64 * 1024, 1024 * 1024, 4 * 1024 * 1024];
const MAX_LOCATION_CACHE_ENTRIES = 256;
// Never follow a symlink out of the Claude projects directory.
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

export type ClaudeCliNativeSubagentLocation = {
  transcriptPath: string;
  agentType?: string;
  description?: string;
  background: boolean;
};

export type ClaudeCliNativeSubagentRead = Omit<
  ClaudeCliNativeSubagentLocation,
  "transcriptPath"
> & {
  status: "running" | "done";
  updatedAt?: number;
  messages: Record<string, unknown>[];
  /** Byte offset of the next unread row. */
  cursor: number;
  /** The first read started inside the file and left older rows out. */
  omittedEarlier: boolean;
  /** The caller's cursor no longer matches the file, so this read started over. */
  reset: boolean;
  /** More complete rows are already on disk past `cursor`. */
  more: boolean;
};

// Metas are written once at spawn; caching hits keeps live refreshes to one stat and read.
const locationCache = new Map<string, ClaudeCliNativeSubagentLocation>();

function rememberLocation(key: string, location: ClaudeCliNativeSubagentLocation): void {
  if (locationCache.size >= MAX_LOCATION_CACHE_ENTRIES) {
    locationCache.delete(locationCache.keys().next().value!);
  }
  locationCache.set(key, location);
}

async function readBoundedJson(filePath: string): Promise<unknown> {
  const handle = await fs.promises.open(filePath, READ_FLAGS);
  try {
    const buffer = Buffer.alloc(MAX_META_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_META_BYTES) {
      return undefined;
    }
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

async function findInSubagentsDir(
  subagentsDir: string,
  toolCallId: string,
): Promise<ClaudeCliNativeSubagentLocation | undefined> {
  const cacheKey = JSON.stringify([subagentsDir, toolCallId]);
  const cached = locationCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  let names: string[];
  try {
    names = await fs.promises.readdir(subagentsDir);
  } catch {
    return undefined;
  }
  const agentIds = names.flatMap((name) => META_FILE_PATTERN.exec(name)?.[1] ?? []);
  for (const agentId of agentIds.slice(0, MAX_META_FILES)) {
    let meta: unknown;
    try {
      meta = await readBoundedJson(path.join(subagentsDir, `agent-${agentId}.meta.json`));
    } catch {
      continue;
    }
    if (!isRecord(meta) || meta.toolUseId !== toolCallId) {
      continue;
    }
    const agentType = normalizeOptionalString(meta.agentType);
    const description = normalizeOptionalString(meta.description);
    const location: ClaudeCliNativeSubagentLocation = {
      transcriptPath: path.join(subagentsDir, `agent-${agentId}.jsonl`),
      ...(agentType ? { agentType } : {}),
      ...(description ? { description } : {}),
      background: meta.requestShape === "background",
    };
    rememberLocation(cacheKey, location);
    return location;
  }
  return undefined;
}

function sessionSubagentsDir(sessionFile: string): string {
  return path.join(path.dirname(sessionFile), path.basename(sessionFile, ".jsonl"), "subagents");
}

/**
 * Finds the subagent spawned by `toolCallId` in one of the Claude sessions of an
 * OpenClaw session: its bound session and the sessions of turns running now.
 */
export async function resolveClaudeCliNativeSubagent(params: {
  cliSessionIds: readonly string[];
  toolCallId: string;
  homeDir?: string;
}): Promise<ClaudeCliNativeSubagentLocation | undefined> {
  for (const cliSessionId of new Set(params.cliSessionIds)) {
    const sessionFile = await resolveClaudeCliSessionFilePathAsync({
      cliSessionId,
      homeDir: params.homeDir,
    });
    const location = sessionFile
      ? await findInSubagentsDir(sessionSubagentsDir(sessionFile), params.toolCallId)
      : undefined;
    if (location) {
      return location;
    }
  }
  return undefined;
}

function decodeEntry(line: string): ClaudeCliProjectEntry | undefined {
  if (!line.trim()) {
    return undefined;
  }
  try {
    return decodeClaudeCliProjectEntry(line);
  } catch {
    // A cursor inside an oversized row lands mid-line; the rest of that row is skipped here.
    return undefined;
  }
}

function isFinishedAssistantEntry(entry: ClaudeCliProjectEntry): boolean {
  const stopReason = entry.message?.stop_reason;
  return (
    entry.type === "assistant" &&
    typeof stopReason === "string" &&
    stopReason !== "tool_use" &&
    stopReason !== "pause_turn"
  );
}

async function readRange(handle: fs.promises.FileHandle, start: number, end: number) {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
  return buffer.subarray(0, bytesRead);
}

// The subagent is done once its last conversational row is a final assistant reply.
async function readStatus(handle: fs.promises.FileHandle, size: number) {
  // A long final reply can be larger than the first window: widen it, bounded.
  for (const windowBytes of STATUS_TAIL_WINDOWS) {
    const start = Math.max(0, size - windowBytes);
    const tail = await readRange(handle, start, size);
    // Like the row reader, ignore the unterminated last row: it has not been returned yet.
    const lines = tail
      .toString("utf8")
      .split("\n")
      .slice(start > 0 ? 1 : 0, -1);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = decodeEntry(lines[index] ?? "");
      if (entry?.type === "user" || entry?.type === "assistant") {
        return isFinishedAssistantEntry(entry) ? "done" : "running";
      }
    }
    if (start === 0) {
      break;
    }
  }
  return "running";
}

function hasToolResult(message: Record<string, unknown>): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some((block) => isRecord(block) && isToolResultBlock(block))
  );
}

/**
 * Reads the subagent rows written since `cursor`. Only complete lines are consumed,
 * so a row Claude is still writing is picked up by the next read.
 */
export async function readClaudeCliNativeSubagent(params: {
  location: ClaudeCliNativeSubagentLocation;
  cursor?: number;
}): Promise<ClaudeCliNativeSubagentRead | undefined> {
  const { transcriptPath, ...facts } = params.location;
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(transcriptPath, READ_FLAGS);
  } catch {
    return undefined;
  }
  try {
    const stats = await handle.stat();
    const size = stats.size;
    const reset = params.cursor !== undefined && params.cursor > size;
    const resume = params.cursor !== undefined && !reset;
    const start = resume ? params.cursor! : Math.max(0, size - INITIAL_TAIL_BYTES);
    const end = Math.min(size, start + MAX_READ_BYTES);
    const chunk = await readRange(handle, start, end);
    let from = 0;
    if (!resume && start > 0) {
      // Drop the partial row the tail window started in.
      from = chunk.indexOf(0x0a) + 1;
    }
    const lastNewline = chunk.lastIndexOf(0x0a);
    // A row longer than one read window has no newline yet: skip past it.
    const consumedTo =
      lastNewline >= from ? lastNewline + 1 : end - start >= MAX_READ_BYTES ? end - start : from;
    const messages: Record<string, unknown>[] = [];
    const toolNames = new Map<string, string>();
    let lineOffset = start + from;
    for (const line of chunk.subarray(from, consumedTo).toString("utf8").split("\n")) {
      // Byte offsets stand in for line numbers so ids stay unique across reads.
      const sourceOffset = lineOffset;
      lineOffset += Buffer.byteLength(line, "utf8") + 1;
      const entry = decodeEntry(line);
      if (!entry) {
        continue;
      }
      // Every subagent row is a sidechain of the parent session; read it as its own transcript.
      const message = parseClaudeCliHistoryEntry(
        { ...entry, isSidechain: false },
        path.basename(transcriptPath, ".jsonl"),
        sourceOffset,
        toolNames,
        { reseedMode: "preserve" },
      );
      // The prompt already shows as the parent tool call input; keep only tool results.
      if (message && (message.role === "assistant" || hasToolResult(message))) {
        appendCoalescedClaudeCliToolMessage(messages, message);
      }
    }
    return {
      ...facts,
      status: await readStatus(handle, size),
      updatedAt: Math.floor(stats.mtimeMs),
      messages: messages.map(redactClaudeCliHistoryMessage),
      cursor: start + consumedTo,
      omittedEarlier: !resume && start > 0,
      reset,
      more: start + consumedTo < size,
    };
  } finally {
    await handle.close();
  }
}

export function clearClaudeCliNativeSubagentCacheForTest(): void {
  locationCache.clear();
}
