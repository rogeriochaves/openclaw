// Background work of a claude-cli backed session: what keeps running after (or
// alongside) its turns. Three sources, all read only:
// - background subagents (Claude Code `Agent` tool with run_in_background), see
//   cli-background-work-subagents.ts;
// - commands the session's persistent `claude` process is running (Bash tool shells
//   and everything under them, such as nested `claude -p` calls), from /proc;
// - detached process trees (setsid, systemd-run) started from the session's
//   workspace, which leave the process tree but still belong to its work.
import os from "node:os";
import path from "node:path";
import { listActiveCliSessionIds } from "../agents/cli-active-sessions.js";
import { redactSensitiveArgv } from "../config/redact-argv.js";
import {
  getCliSessionBinding,
  type CliSessionBindingEntry,
} from "../config/sessions/cli-session-binding.js";
import {
  createLinuxProcReader,
  createProcSampler,
  findLeafProcess,
  listDescendants,
  type ProcInfo,
  type ProcSnapshot,
} from "./cli-background-work-proc.js";
import {
  clearClaudeCliBackgroundSubagentCachesForTest,
  listClaudeCliBackgroundSubagents,
} from "./cli-background-work-subagents.js";
import { boundCache, safeBackgroundText as safeText } from "./cli-background-work-text.js";
import { resolveClaudeCliSessionFilePath } from "./cli-session-history.claude.js";

/** Running work with no sign of life for this long is flagged as possibly stuck. */
export const CLI_BACKGROUND_STALE_AFTER_MS = 10 * 60_000;
// Detached trees older than this are services, not task work.
const MAX_DETACHED_AGE_MS = 12 * 60 * 60_000;
const PROC_SAMPLE_TTL_MS = 2_000;
const SUMMARY_TTL_MS = 3_000;
const MAX_ITEMS = 24;
const MAX_NESTED = 6;
const SHELL_NAMES = new Set(["bash", "sh", "zsh", "dash"]);

export type ClaudeCliBackgroundItemKind = "subagent" | "command" | "detached";
export type ClaudeCliBackgroundItemStatus = "running" | "done" | "failed" | "stopped";

export type ClaudeCliBackgroundNestedProcess = {
  pid: number;
  label: string;
  startedAt: number;
};

export type ClaudeCliBackgroundItem = {
  id: string;
  kind: ClaudeCliBackgroundItemKind;
  status: ClaudeCliBackgroundItemStatus;
  title: string;
  agentType?: string;
  toolCallId?: string;
  /** What it is doing now: the leaf command, or the subagent's latest tool call or line. */
  activity?: string;
  activityAt?: number;
  startedAt?: number;
  lastActivityAt?: number;
  stale: boolean;
  pid?: number;
  cpuPercent?: number;
  processCount?: number;
  nested?: ClaudeCliBackgroundNestedProcess[];
};

export type ClaudeCliBackgroundWork = {
  /** Process data could be read (Linux /proc); without it only subagents are listed. */
  processScan: boolean;
  /** The session's `claude` process is running. */
  processAlive: boolean;
  items: ClaudeCliBackgroundItem[];
  active: number;
  stale: number;
  lastActivityAt?: number;
  staleAfterMs: number;
  sampledAt: number;
};

export type ClaudeCliBackgroundSummary = {
  active: number;
  stale: number;
  lastActivityAt?: number;
};

type Deps = {
  sample: (now: number) => ProcSnapshot | undefined;
  homeDir?: string;
  gatewayPid: number;
};

function createDefaultDeps(): Deps {
  const sampler =
    process.platform === "linux" ? createProcSampler(createLinuxProcReader()) : undefined;
  let cached: ProcSnapshot | undefined;
  return {
    sample: (now) => {
      if (!sampler) {
        return undefined;
      }
      if (!cached || now - cached.sampledAt >= PROC_SAMPLE_TTL_MS || now < cached.sampledAt) {
        cached = sampler(now);
      }
      return cached;
    },
    gatewayPid: process.pid,
  };
}

let deps: Deps = createDefaultDeps();

// ---------------------------------------------------------------------------
// Processes

function basename(value: string | undefined): string {
  return value ? path.basename(value) : "";
}

function isClaudeProcess(info: ProcInfo): boolean {
  const exe = basename(info.argv[0]);
  if (exe === "claude" || exe === "claude.exe") {
    return true;
  }
  // `node .../@anthropic-ai/claude-code/cli.js`
  return (
    (exe === "node" || info.comm === "node") &&
    /@anthropic-ai[/\\]claude-code[/\\]/.test(info.argv[1] ?? "")
  );
}

const SESSION_FLAGS = new Set(["--resume", "-r", "--session-id"]);

function claudeSessionIdOf(info: ProcInfo): string | undefined {
  for (let index = 0; index < info.argv.length - 1; index += 1) {
    if (SESSION_FLAGS.has(info.argv[index]!)) {
      return info.argv[index + 1];
    }
  }
  return undefined;
}

const claudeIndexCache = new WeakMap<ProcSnapshot, Map<string, ProcInfo>>();

function claudeProcessesBySessionId(snapshot: ProcSnapshot): Map<string, ProcInfo> {
  let index = claudeIndexCache.get(snapshot);
  if (!index) {
    index = new Map();
    for (const info of snapshot.byPid.values()) {
      const sessionId = isClaudeProcess(info) ? claudeSessionIdOf(info) : undefined;
      const prior = sessionId ? index.get(sessionId) : undefined;
      // A nested `claude -p --resume` of the same session is not the session process.
      if (sessionId && (!prior || info.startedAt < prior.startedAt)) {
        index.set(sessionId, info);
      }
    }
    claudeIndexCache.set(snapshot, index);
  }
  return index;
}

/** The command a Claude Code Bash tool shell runs, without its snapshot preamble. */
export function unwrapClaudeShellCommand(script: string): string {
  const evalAt = script.indexOf("eval '");
  if (evalAt < 0) {
    return script;
  }
  const body = script
    .slice(evalAt + "eval '".length)
    .replace(/'\s*(?:<\s*\/dev\/null\s*)?(?:&&\s*pwd -P[\s\S]*)?$/, "");
  return body.replaceAll(`'"'"'`, "'");
}

function isShellCommand(info: ProcInfo): boolean {
  return SHELL_NAMES.has(basename(info.argv[0]) || info.comm) && info.argv[1] === "-c";
}

function describeArgv(info: ProcInfo): string {
  if (isShellCommand(info) && info.argv[2]) {
    return safeText(unwrapClaudeShellCommand(info.argv[2]));
  }
  return safeText(redactSensitiveArgv(info.argv.length > 0 ? info.argv : [info.comm]).join(" "));
}

const CLAUDE_VALUE_FLAGS = new Set([
  "--model",
  "--output-format",
  "--input-format",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--append-system-prompt",
  "--system-prompt",
  "--mcp-config",
  "--permission-mode",
  "--resume",
  "-r",
  "--session-id",
  "--settings",
  "--max-turns",
  "--add-dir",
  "--plugin-dir",
  "--effort",
]);

/** `claude -p` children: what they were asked, when it is on the command line. */
function describeNestedClaude(info: ProcInfo): string {
  const args = redactSensitiveArgv(info.argv.slice(1));
  let model: string | undefined;
  let prompt: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--model") {
      model = args[index + 1];
    }
    if (CLAUDE_VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-") && (!prompt || arg.length > prompt.length)) {
      prompt = arg;
    }
  }
  const head = `claude${model ? ` (${model})` : ""}`;
  return prompt ? safeText(`${head}: ${prompt}`, 160) : head;
}

function within(dir: string, candidate: string | undefined): boolean {
  return Boolean(candidate) && (candidate === dir || candidate!.startsWith(`${dir}${path.sep}`));
}

function mentionsDir(argv: readonly string[], dir: string): boolean {
  return argv.some((arg) => arg === dir || arg.includes(`${dir}${path.sep}`));
}

function describeProcessTree(params: {
  snapshot: ProcSnapshot;
  root: ProcInfo;
  kind: "command" | "detached";
  now: number;
  /** Paths under it read relative, as the agent wrote them. */
  workspaceDir?: string;
}): ClaudeCliBackgroundItem {
  const { snapshot, root, workspaceDir } = params;
  const show = (text: string) => (workspaceDir ? text.replaceAll(`${workspaceDir}/`, "") : text);
  const tree = [root, ...listDescendants(snapshot, root.pid)];
  const leaf = findLeafProcess(snapshot, root);
  let lastActivityAt = 0;
  let cpuPercent = 0;
  for (const info of tree) {
    lastActivityAt = Math.max(
      lastActivityAt,
      info.startedAt,
      snapshot.lastBusyAt.get(info.pid) ?? 0,
    );
    cpuPercent += snapshot.cpuPercent.get(info.pid) ?? 0;
  }
  // The leaf already shows as the activity.
  const nested = tree
    .filter((info) => info !== root && info !== leaf && isClaudeProcess(info))
    .slice(0, MAX_NESTED)
    .map((info) => ({
      pid: info.pid,
      label: show(describeNestedClaude(info)),
      startedAt: info.startedAt,
    }));
  const stale = params.now - lastActivityAt >= CLI_BACKGROUND_STALE_AFTER_MS;
  return {
    id: `${params.kind}:${root.pid}:${root.startTicks}`,
    kind: params.kind,
    status: "running",
    title: show(describeArgv(root)),
    ...(leaf !== root
      ? {
          activity: show(isClaudeProcess(leaf) ? describeNestedClaude(leaf) : describeArgv(leaf)),
          activityAt: leaf.startedAt,
        }
      : {}),
    startedAt: root.startedAt,
    lastActivityAt,
    stale,
    pid: root.pid,
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    processCount: tree.length,
    ...(nested.length > 0 ? { nested } : {}),
  };
}

function listCommandItems(
  snapshot: ProcSnapshot,
  claude: ProcInfo,
  now: number,
): ClaudeCliBackgroundItem[] {
  const workspaceDir = workspaceDirOf(snapshot, claude);
  // Bash tool calls run as `bash -c` children; MCP servers and helpers are not task work.
  return (snapshot.children.get(claude.pid) ?? []).flatMap((pid) => {
    const info = snapshot.byPid.get(pid);
    return info && isShellCommand(info) && info.state !== "Z"
      ? [describeProcessTree({ snapshot, root: info, kind: "command", now, workspaceDir })]
      : [];
  });
}

function isServiceManager(info: ProcInfo | undefined): boolean {
  return !info || info.pid === 1 || info.comm === "systemd" || info.comm === "init";
}

function listDetachedItems(
  snapshot: ProcSnapshot,
  workspaceDirs: readonly string[],
  now: number,
): ClaudeCliBackgroundItem[] {
  if (workspaceDirs.length === 0) {
    return [];
  }
  const items: ClaudeCliBackgroundItem[] = [];
  for (const info of snapshot.byPid.values()) {
    if (
      info.pid === deps.gatewayPid ||
      info.state === "Z" ||
      now - info.startedAt > MAX_DETACHED_AGE_MS ||
      isClaudeProcess(info) ||
      !isServiceManager(snapshot.byPid.get(info.ppid)) ||
      info.ppid === 0
    ) {
      continue;
    }
    const workspaceDir =
      workspaceDirs.find((dir) => mentionsDir(info.argv, dir)) ??
      workspaceDirs.find((dir) => within(dir, snapshot.readCwd(info.pid)));
    // Gateways and agent hosts run claude sessions themselves; they are not task work.
    if (!workspaceDir || listDescendants(snapshot, info.pid).some(isClaudeSessionHost(snapshot))) {
      continue;
    }
    items.push(describeProcessTree({ snapshot, root: info, kind: "detached", now, workspaceDir }));
  }
  return items;
}

function isClaudeSessionHost(snapshot: ProcSnapshot) {
  const index = claudeProcessesBySessionId(snapshot);
  const hosts = new Set([...index.values()].map((info) => info.pid));
  return (info: ProcInfo) => hosts.has(info.pid);
}

function workspaceDirOf(snapshot: ProcSnapshot, claude: ProcInfo): string | undefined {
  const cwd = snapshot.readCwd(claude.pid);
  // A session started in / or the home dir has no workspace of its own to match on.
  if (!cwd || cwd === path.parse(cwd).root || cwd === os.homedir()) {
    return undefined;
  }
  return cwd;
}

// ---------------------------------------------------------------------------

/** Claude sessions behind an OpenClaw session: the bound one and those of running turns. */
export function resolveClaudeCliSessionIds(
  entry: CliSessionBindingEntry | undefined,
  sessionKey: string,
): string[] {
  const bound = getCliSessionBinding(entry, "claude-cli")?.sessionId;
  // A turn that starts a new Claude session binds it only when the turn ends.
  const active = listActiveCliSessionIds({ backendId: "claude-cli", sessionKey });
  return [...new Set([...(bound ? [bound] : []), ...active])];
}

const STATUS_ORDER: Record<ClaudeCliBackgroundItemStatus, number> = {
  running: 0,
  failed: 1,
  stopped: 2,
  done: 3,
};

/** Background work of the Claude sessions behind one OpenClaw session. */
export function collectClaudeCliBackgroundWork(params: {
  cliSessionIds: readonly string[];
  now?: number;
}): ClaudeCliBackgroundWork {
  const now = params.now ?? Date.now();
  const snapshot = deps.sample(now);
  const index = snapshot ? claudeProcessesBySessionId(snapshot) : undefined;
  const items: ClaudeCliBackgroundItem[] = [];
  const workspaceDirs = new Set<string>();
  let processAlive = false;
  for (const cliSessionId of new Set(params.cliSessionIds)) {
    const claude = index?.get(cliSessionId);
    if (snapshot && claude) {
      processAlive = true;
      items.push(...listCommandItems(snapshot, claude, now));
      const workspaceDir = workspaceDirOf(snapshot, claude);
      if (workspaceDir) {
        workspaceDirs.add(workspaceDir);
      }
    }
    const sessionFile = resolveClaudeCliSessionFilePath({ cliSessionId, homeDir: deps.homeDir });
    if (sessionFile) {
      items.push(
        ...listClaudeCliBackgroundSubagents({
          sessionFile,
          claude,
          processScan: Boolean(snapshot),
          now,
          staleAfterMs: CLI_BACKGROUND_STALE_AFTER_MS,
        }),
      );
    }
  }
  if (snapshot) {
    items.push(...listDetachedItems(snapshot, [...workspaceDirs], now));
  }
  items.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0),
  );
  const listed = items.slice(0, MAX_ITEMS);
  const running = items.filter((item) => item.status === "running");
  const lastActivityAt = running.reduce<number | undefined>(
    (latest, item) => Math.max(latest ?? 0, item.lastActivityAt ?? 0) || latest,
    undefined,
  );
  return {
    processScan: Boolean(snapshot),
    processAlive,
    items: listed,
    active: running.length,
    stale: running.filter((item) => item.stale).length,
    ...(lastActivityAt ? { lastActivityAt } : {}),
    staleAfterMs: CLI_BACKGROUND_STALE_AFTER_MS,
    sampledAt: now,
  };
}

const summaryCache = new Map<
  string,
  { at: number; summary: ClaudeCliBackgroundSummary | undefined }
>();

/**
 * Cheap per-row summary for session lists: counts of running and stale items, or
 * undefined when nothing runs. Reuses one result per Claude session set for a few seconds.
 */
export function summarizeClaudeCliBackgroundWork(params: {
  cliSessionIds: readonly string[];
  now?: number;
}): ClaudeCliBackgroundSummary | undefined {
  if (params.cliSessionIds.length === 0) {
    return undefined;
  }
  const now = params.now ?? Date.now();
  const key = JSON.stringify([...new Set(params.cliSessionIds)].toSorted());
  const cached = summaryCache.get(key);
  if (cached && now - cached.at < SUMMARY_TTL_MS && now >= cached.at) {
    return cached.summary;
  }
  const work = collectClaudeCliBackgroundWork({ cliSessionIds: params.cliSessionIds, now });
  const summary =
    work.active > 0
      ? {
          active: work.active,
          stale: work.stale,
          ...(work.lastActivityAt ? { lastActivityAt: work.lastActivityAt } : {}),
        }
      : undefined;
  summaryCache.set(key, { at: now, summary });
  boundCache(summaryCache, 256);
  return summary;
}

export function setClaudeCliBackgroundWorkDepsForTest(next?: Partial<Deps>): void {
  deps = next ? { ...createDefaultDeps(), ...next } : createDefaultDeps();
  clearClaudeCliBackgroundSubagentCachesForTest();
  summaryCache.clear();
}
