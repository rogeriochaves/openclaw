// Background subagents of a claude-cli session (Claude Code `Agent` tool with
// run_in_background): their `<session>/subagents` transcripts, plus the
// `<task-notification>` rows Claude Code writes to the main transcript when one ends.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ProcInfo } from "./cli-background-work-proc.js";
import { boundCache, safeBackgroundText as safeText } from "./cli-background-work-text.js";
import type {
  ClaudeCliBackgroundItem,
  ClaudeCliBackgroundItemStatus,
} from "./cli-background-work.js";
import {
  decodeClaudeCliProjectEntry,
  resolveClaudeCliTimestampMs,
  type ClaudeCliProjectEntry,
} from "./cli-session-history.claude.js";

// Finished subagents stay listed for a while so the owner sees how they ended.
const RECENT_FINISHED_MS = 15 * 60_000;
// Older unfinished transcripts belong to work that is long gone.
const MAX_RUNNING_AGE_MS = 24 * 60 * 60_000;
const MAX_META_FILES = 512;
const MAX_META_BYTES = 64 * 1024;
const SUBAGENT_TAIL_WINDOWS = [64 * 1024, 512 * 1024];
const NOTIFICATION_TAIL_BYTES = 1024 * 1024;
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

type SubagentMeta = {
  agentId: string;
  agentType?: string;
  description?: string;
  toolUseId?: string;
  background: boolean;
  createdAt: number;
};

type TailFacts = {
  finished: boolean;
  activity?: string;
  activityAt?: number;
};

type Notification = { status: ClaudeCliBackgroundItemStatus; at: number };

const metaCache = new Map<string, SubagentMeta | null>();
const tailCache = new Map<string, { key: string; facts: TailFacts }>();
const notificationCache = new Map<string, { key: string; byTaskId: Map<string, Notification> }>();

function readRangeSync(filePath: string, start: number, end: number): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, READ_FLAGS);
    const buffer = Buffer.alloc(Math.max(0, end - start));
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function readMeta(subagentsDir: string, agentId: string): SubagentMeta | undefined {
  const metaPath = path.join(subagentsDir, `agent-${agentId}.meta.json`);
  const cached = metaCache.get(metaPath);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  let meta: SubagentMeta | null = null;
  try {
    const stats = fs.lstatSync(metaPath);
    const raw =
      stats.isFile() && stats.size <= MAX_META_BYTES
        ? readRangeSync(metaPath, 0, stats.size)
        : undefined;
    const parsed: unknown = raw ? JSON.parse(raw.toString("utf8")) : undefined;
    if (isRecord(parsed)) {
      const agentType = normalizeOptionalString(parsed.agentType);
      const description = normalizeOptionalString(parsed.description);
      const toolUseId = normalizeOptionalString(parsed.toolUseId);
      meta = {
        agentId,
        ...(agentType ? { agentType } : {}),
        ...(description ? { description } : {}),
        ...(toolUseId ? { toolUseId } : {}),
        background: parsed.requestShape === "background",
        createdAt: Math.floor(stats.mtimeMs),
      };
    }
  } catch {
    meta = null;
  }
  metaCache.set(metaPath, meta);
  boundCache(metaCache);
  return meta ?? undefined;
}

function summarizeToolInput(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  for (const key of [
    "command",
    "description",
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
    "prompt",
  ]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

/** The latest thing an assistant row did: its last tool call, or its last line of text. */
export function describeClaudeAssistantActivity(entry: ClaudeCliProjectEntry): string | undefined {
  const content = entry.message?.content;
  if (typeof content === "string") {
    return content.trim() ? safeText(content.trim().split("\n").at(-1) ?? "") : undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block: unknown = content[index];
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "tool_use" && typeof block.name === "string") {
      const detail = summarizeToolInput(block.input);
      return safeText(detail ? `${block.name}: ${detail}` : block.name);
    }
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      const lines = block.text
        .trim()
        .split("\n")
        .filter((line) => line.trim());
      return safeText(lines.at(-1) ?? "");
    }
  }
  return undefined;
}

function decodeLine(line: string): ClaudeCliProjectEntry | undefined {
  if (!line.trim()) {
    return undefined;
  }
  try {
    return decodeClaudeCliProjectEntry(line);
  } catch {
    return undefined;
  }
}

function readSubagentTail(transcriptPath: string, size: number, mtimeMs: number): TailFacts {
  const key = `${size}:${mtimeMs}`;
  const cached = tailCache.get(transcriptPath);
  if (cached?.key === key) {
    return cached.facts;
  }
  const facts: TailFacts = { finished: false };
  for (const windowBytes of SUBAGENT_TAIL_WINDOWS) {
    const start = Math.max(0, size - windowBytes);
    const chunk = readRangeSync(transcriptPath, start, size);
    if (!chunk) {
      break;
    }
    // Skip the partial first row of a window and the row Claude Code is still writing.
    const lines = chunk
      .toString("utf8")
      .split("\n")
      .slice(start > 0 ? 1 : 0, -1);
    let found = false;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = decodeLine(lines[index] ?? "");
      if (entry?.type !== "user" && entry?.type !== "assistant") {
        continue;
      }
      if (!found) {
        found = true;
        const stopReason = entry.message?.stop_reason;
        facts.finished =
          entry.type === "assistant" &&
          typeof stopReason === "string" &&
          stopReason !== "tool_use" &&
          stopReason !== "pause_turn";
      }
      if (entry.type === "assistant") {
        const activity = describeClaudeAssistantActivity(entry);
        if (activity) {
          facts.activity = activity;
          facts.activityAt = resolveClaudeCliTimestampMs(entry.timestamp);
          break;
        }
      }
    }
    if (facts.activity || start === 0) {
      break;
    }
  }
  tailCache.set(transcriptPath, { key, facts });
  boundCache(tailCache);
  return facts;
}

const NOTIFICATION_STATUS: Record<string, ClaudeCliBackgroundItemStatus> = {
  completed: "done",
  failed: "failed",
  stopped: "stopped",
  killed: "stopped",
};

/** Latest `<task-notification>` status per task id, from the tail of the main transcript. */
function readTaskNotifications(sessionFile: string): Map<string, Notification> {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(sessionFile);
  } catch {
    return new Map();
  }
  const key = `${stats.size}:${stats.mtimeMs}`;
  const cached = notificationCache.get(sessionFile);
  if (cached?.key === key) {
    return cached.byTaskId;
  }
  const byTaskId = new Map<string, Notification>();
  const start = Math.max(0, stats.size - NOTIFICATION_TAIL_BYTES);
  const chunk = readRangeSync(sessionFile, start, stats.size);
  for (const line of chunk?.toString("utf8").split("\n") ?? []) {
    if (!line.includes("<task-notification>")) {
      continue;
    }
    const entry = decodeLine(line);
    const at = resolveClaudeCliTimestampMs(entry?.timestamp);
    // Rows can carry several notifications; each names its task before its status.
    for (const match of line.matchAll(
      /<task-id>([A-Za-z0-9_-]{1,128})<\/task-id>[\s\S]*?<status>([a-z_]+)<\/status>/g,
    )) {
      const status = NOTIFICATION_STATUS[match[2]!];
      if (status && at !== undefined) {
        byTaskId.set(match[1]!, { status, at });
      }
    }
  }
  notificationCache.set(sessionFile, { key, byTaskId });
  boundCache(notificationCache, 64);
  return byTaskId;
}

export function listClaudeCliBackgroundSubagents(params: {
  sessionFile: string;
  claude: ProcInfo | undefined;
  processScan: boolean;
  now: number;
  staleAfterMs: number;
}): ClaudeCliBackgroundItem[] {
  const { sessionFile, claude, now } = params;
  const subagentsDir = path.join(
    path.dirname(sessionFile),
    path.basename(sessionFile, ".jsonl"),
    "subagents",
  );
  let names: string[];
  try {
    names = fs.readdirSync(subagentsDir);
  } catch {
    return [];
  }
  const notifications = readTaskNotifications(sessionFile);
  const items: ClaudeCliBackgroundItem[] = [];
  const agentIds = names
    .flatMap((name) => /^agent-([A-Za-z0-9_-]{1,128})\.meta\.json$/.exec(name)?.[1] ?? [])
    .slice(-MAX_META_FILES);
  for (const agentId of agentIds) {
    const meta = readMeta(subagentsDir, agentId);
    if (!meta?.background) {
      continue;
    }
    const transcriptPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(transcriptPath);
    } catch {
      continue;
    }
    const lastActivityAt = Math.floor(stats.mtimeMs);
    if (!stats.isFile() || now - lastActivityAt > MAX_RUNNING_AGE_MS) {
      continue;
    }
    const tail = readSubagentTail(transcriptPath, stats.size, stats.mtimeMs);
    const notification = notifications.get(agentId);
    let status: ClaudeCliBackgroundItemStatus;
    let endedAt: number | undefined;
    // A notification older than the transcript's last write was followed by a resume.
    if (notification && notification.at + 1_000 >= lastActivityAt) {
      status = notification.status;
      endedAt = notification.at;
    } else if (tail.finished) {
      status = "done";
      endedAt = lastActivityAt;
    } else if (params.processScan && (!claude || claude.startedAt > lastActivityAt)) {
      // Subagents run inside the claude process: without it (or since its restart), they stopped.
      status = "stopped";
      endedAt = lastActivityAt;
    } else {
      status = "running";
    }
    if (status !== "running" && now - (endedAt ?? lastActivityAt) > RECENT_FINISHED_MS) {
      continue;
    }
    items.push({
      id: `subagent:${agentId}`,
      kind: "subagent",
      status,
      title: safeText(meta.description ?? meta.agentType ?? agentId),
      ...(meta.agentType ? { agentType: meta.agentType } : {}),
      ...(meta.toolUseId ? { toolCallId: meta.toolUseId } : {}),
      ...(tail.activity ? { activity: tail.activity } : {}),
      ...(tail.activityAt ? { activityAt: tail.activityAt } : {}),
      startedAt: meta.createdAt,
      lastActivityAt,
      stale: status === "running" && now - lastActivityAt >= params.staleAfterMs,
    });
  }
  return items;
}

export function clearClaudeCliBackgroundSubagentCachesForTest(): void {
  metaCache.clear();
  tailCache.clear();
  notificationCache.clear();
}
