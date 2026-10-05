import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createProcSampler, parseProcStat, type ProcReader } from "./cli-background-work-proc.js";
import {
  collectClaudeCliBackgroundWork,
  setClaudeCliBackgroundWorkDepsForTest,
  summarizeClaudeCliBackgroundWork,
  unwrapClaudeShellCommand,
} from "./cli-background-work.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => vi.stubEnv("CLAUDE_CONFIG_DIR", ""));
afterEach(() => {
  setClaudeCliBackgroundWorkDepsForTest();
  vi.unstubAllEnvs();
});

const SESSION_ID = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const BOOT = NOW - 10 * 24 * 60 * 60_000;
const MINUTE = 60_000;
const WORKSPACE = "/srv/agents/workspace-content";

type FakeProc = {
  pid: number;
  ppid: number;
  comm: string;
  argv: string[];
  startedAt: number;
  cpuMs?: number;
  cwd?: string;
  state?: string;
};

function fakeReader(table: FakeProc[]): ProcReader {
  const byPid = new Map(table.map((proc) => [proc.pid, proc]));
  return {
    listPids: () => [...byPid.keys()],
    readStat: (pid) => {
      const proc = byPid.get(pid);
      if (!proc) {
        return undefined;
      }
      const ticks = Math.round((proc.cpuMs ?? 0) / 10);
      const start = Math.round((proc.startedAt - BOOT) / 10);
      return `${pid} (${proc.comm}) ${proc.state ?? "S"} ${proc.ppid} 0 0 0 -1 0 0 0 0 0 ${ticks} 0 0 0 20 0 1 0 ${start} 0 0`;
    },
    readCmdline: (pid) => `${byPid.get(pid)?.argv.join("\0")}\0`,
    readCwd: (pid) => byPid.get(pid)?.cwd,
    bootTimeMs: () => BOOT,
    clockTicksPerSecond: 100,
  };
}

function claudeShell(command: string): string[] {
  return [
    "/bin/bash",
    "-c",
    `source /home/u/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true && eval '${command.replaceAll("'", `'"'"'`)}' < /dev/null && pwd -P >| /tmp/claude-1-cwd`,
  ];
}

const baseTable: FakeProc[] = [
  { pid: 1, ppid: 0, comm: "systemd", argv: ["/sbin/init"], startedAt: BOOT },
  {
    pid: 100,
    ppid: 1,
    comm: "node",
    argv: ["node", "openclaw", "gateway"],
    startedAt: NOW - 60 * MINUTE,
    cwd: "/root",
  },
  {
    pid: 200,
    ppid: 100,
    comm: "claude",
    argv: ["/usr/bin/claude", "-p", "--input-format", "stream-json", "--resume", SESSION_ID],
    startedAt: NOW - 50 * MINUTE,
    cwd: WORKSPACE,
  },
  // An MCP server child is plumbing, not task work.
  {
    pid: 210,
    ppid: 200,
    comm: "node",
    argv: ["node", "mcp-server.js"],
    startedAt: NOW - 50 * MINUTE,
  },
  {
    pid: 300,
    ppid: 200,
    comm: "bash",
    argv: claudeShell("cd tmp && python3 pipeline.py 'draft one'"),
    startedAt: NOW - 20 * MINUTE,
  },
  {
    pid: 301,
    ppid: 300,
    comm: "python3",
    argv: ["python3", "pipeline.py", "draft one"],
    startedAt: NOW - 20 * MINUTE,
  },
  {
    pid: 302,
    ppid: 301,
    comm: "claude",
    argv: ["claude", "-p", "--model", "claude-sonnet-5", "Rewrite this draft in plain English"],
    startedAt: NOW - 2 * MINUTE,
  },
  // Detached from the workspace with systemd-run: counted.
  {
    pid: 400,
    ppid: 1,
    comm: "bash",
    argv: ["bash", `${WORKSPACE}/tmp/loop.sh`],
    startedAt: NOW - 40 * MINUTE,
  },
  {
    pid: 401,
    ppid: 400,
    comm: "sleep",
    argv: ["sleep", "600"],
    startedAt: NOW - 30 * MINUTE,
  },
  // A sibling workspace that shares the prefix is someone else's.
  {
    pid: 500,
    ppid: 1,
    comm: "bash",
    argv: ["bash", `${WORKSPACE}-other/run.sh`],
    startedAt: NOW - 5 * MINUTE,
  },
  // A long-lived server started from the workspace is not task work.
  {
    pid: 600,
    ppid: 1,
    comm: "python3",
    argv: ["python3", "-m", "http.server"],
    startedAt: NOW - 30 * 60 * MINUTE,
    cwd: WORKSPACE,
  },
];

function useTable(table: FakeProc[], homeDir?: string) {
  const sampler = createProcSampler(fakeReader(table));
  setClaudeCliBackgroundWorkDepsForTest({
    sample: (now) => sampler(now),
    gatewayPid: 100,
    ...(homeDir ? { homeDir } : {}),
  });
}

function row(type: "user" | "assistant", content: unknown, at: number, stopReason?: string) {
  return `${JSON.stringify({
    type,
    timestamp: new Date(at).toISOString(),
    message: { role: type, content, ...(stopReason ? { stop_reason: stopReason } : {}) },
  })}\n`;
}

async function writeSubagent(params: {
  subagentsDir: string;
  agentId: string;
  description: string;
  background: boolean;
  rows: string[];
  modifiedAt: number;
}) {
  const metaPath = path.join(params.subagentsDir, `agent-${params.agentId}.meta.json`);
  await fs.writeFile(
    metaPath,
    JSON.stringify({
      agentType: "general-purpose",
      description: params.description,
      toolUseId: `toolu_${params.agentId}`,
      requestShape: params.background ? "background" : "foreground",
    }),
  );
  const transcriptPath = path.join(params.subagentsDir, `agent-${params.agentId}.jsonl`);
  await fs.writeFile(transcriptPath, params.rows.join(""));
  const at = new Date(params.modifiedAt);
  await fs.utimes(
    metaPath,
    new Date(params.modifiedAt - MINUTE),
    new Date(params.modifiedAt - MINUTE),
  );
  await fs.utimes(transcriptPath, at, at);
}

async function createClaudeSession() {
  const homeDir = await tempDirs.make("openclaw-cli-background-");
  const projectDir = path.join(homeDir, ".claude", "projects", "workspace-content");
  const subagentsDir = path.join(projectDir, SESSION_ID, "subagents");
  await fs.mkdir(subagentsDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, `${SESSION_ID}.jsonl`),
    row(
      "user",
      "<task-notification>\n<task-id>adone</task-id>\n<status>completed</status>\n<summary>Background agent finished</summary>\n</task-notification>",
      NOW - 3 * MINUTE,
    ),
  );
  await writeSubagent({
    subagentsDir,
    agentId: "awork",
    description: "Build the polish loop",
    background: true,
    rows: [
      row("user", "Build it", NOW - 30 * MINUTE),
      row(
        "assistant",
        [
          { type: "text", text: "Running the loop now." },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "bash loop.sh" } },
        ],
        NOW - MINUTE,
        "tool_use",
      ),
    ],
    modifiedAt: NOW - MINUTE,
  });
  await writeSubagent({
    subagentsDir,
    agentId: "aquiet",
    description: "Wait for the scorer",
    background: true,
    rows: [row("assistant", [{ type: "text", text: "Waiting." }], NOW - 25 * MINUTE, "tool_use")],
    modifiedAt: NOW - 25 * MINUTE,
  });
  await writeSubagent({
    subagentsDir,
    agentId: "adone",
    description: "Score drafts",
    background: true,
    rows: [
      row(
        "assistant",
        [{ type: "tool_use", id: "t2", name: "Read", input: {} }],
        NOW - 4 * MINUTE,
        "tool_use",
      ),
    ],
    modifiedAt: NOW - 4 * MINUTE,
  });
  await writeSubagent({
    subagentsDir,
    agentId: "aold",
    description: "Old research",
    background: true,
    rows: [row("assistant", [{ type: "text", text: "All done." }], NOW - 90 * MINUTE, "end_turn")],
    modifiedAt: NOW - 90 * MINUTE,
  });
  await writeSubagent({
    subagentsDir,
    agentId: "afg",
    description: "Foreground helper",
    background: false,
    rows: [row("assistant", [{ type: "text", text: "Inline." }], NOW - MINUTE, "tool_use")],
    modifiedAt: NOW - MINUTE,
  });
  return homeDir;
}

describe("parseProcStat", () => {
  it("reads fields after a command name with spaces and parentheses", () => {
    expect(
      parseProcStat("42 (my (odd) cmd) R 7 0 0 0 -1 0 0 0 0 0 150 50 0 0 20 0 1 0 1234 0 0", 100),
    ).toEqual({ comm: "my (odd) cmd", state: "R", ppid: 7, cpuMs: 2000, startTicks: 1234 });
  });
});

describe("unwrapClaudeShellCommand", () => {
  it("drops the Claude Code shell snapshot preamble and cwd capture", () => {
    expect(unwrapClaudeShellCommand(claudeShell("grep 'a b' log.txt")[2]!)).toBe(
      "grep 'a b' log.txt",
    );
  });
});

describe("collectClaudeCliBackgroundWork", () => {
  it("lists background subagents, commands under the claude process and detached workspace jobs", async () => {
    useTable(baseTable, await createClaudeSession());

    const work = collectClaudeCliBackgroundWork({ cliSessionIds: [SESSION_ID], now: NOW });

    expect(work.processAlive).toBe(true);
    expect(work.items.map((item) => [item.id, item.status, item.stale])).toEqual([
      ["subagent:awork", "running", false],
      ["command:300:" + String((NOW - 20 * MINUTE - BOOT) / 10), "running", false],
      ["subagent:aquiet", "running", true],
      ["detached:400:" + String((NOW - 40 * MINUTE - BOOT) / 10), "running", true],
      ["subagent:adone", "done", false],
    ]);
    expect(work.items[0]).toMatchObject({
      title: "Build the polish loop",
      toolCallId: "toolu_awork",
      activity: "Bash: bash loop.sh",
      lastActivityAt: NOW - MINUTE,
    });
    expect(work.items[1]).toMatchObject({
      kind: "command",
      title: "cd tmp && python3 pipeline.py 'draft one'",
      activity: "claude (claude-sonnet-5): Rewrite this draft in plain English",
      activityAt: NOW - 2 * MINUTE,
      processCount: 3,
      nested: [
        {
          pid: 302,
          label: "claude (claude-sonnet-5): Rewrite this draft in plain English",
          startedAt: NOW - 2 * MINUTE,
        },
      ],
    });
    expect(work.items[3]).toMatchObject({
      kind: "detached",
      title: `bash ${WORKSPACE}/tmp/loop.sh`,
      activity: "sleep 600",
    });
    expect(work).toMatchObject({ active: 4, stale: 2, lastActivityAt: NOW - MINUTE });
  });

  it("counts a process tree as active again once it uses CPU", async () => {
    const table = baseTable.map((proc) => ({ ...proc }));
    useTable(table);
    collectClaudeCliBackgroundWork({ cliSessionIds: [SESSION_ID], now: NOW });
    table.find((proc) => proc.pid === 401)!.cpuMs = 500;

    const work = collectClaudeCliBackgroundWork({
      cliSessionIds: [SESSION_ID],
      now: NOW + 5_000,
    });

    expect(work.items.find((item) => item.kind === "detached")).toMatchObject({
      stale: false,
      lastActivityAt: NOW + 5_000,
      cpuPercent: 10,
    });
  });

  it("marks unfinished subagents stopped once the claude process is gone", async () => {
    useTable(
      baseTable.filter((proc) => proc.pid !== 200 && proc.ppid !== 200),
      await createClaudeSession(),
    );

    const work = collectClaudeCliBackgroundWork({ cliSessionIds: [SESSION_ID], now: NOW });

    expect(work.processAlive).toBe(false);
    expect(work.active).toBe(0);
    expect(work.items.map((item) => [item.id, item.status])).toEqual([
      ["subagent:awork", "stopped"],
      ["subagent:adone", "done"],
    ]);
  });
});

describe("summarizeClaudeCliBackgroundWork", () => {
  it("summarizes running work and omits idle sessions", async () => {
    useTable(baseTable, await createClaudeSession());

    expect(summarizeClaudeCliBackgroundWork({ cliSessionIds: [SESSION_ID], now: NOW })).toEqual({
      active: 4,
      stale: 2,
      lastActivityAt: NOW - MINUTE,
    });
    expect(summarizeClaudeCliBackgroundWork({ cliSessionIds: ["missing"], now: NOW })).toBe(
      undefined,
    );
    expect(summarizeClaudeCliBackgroundWork({ cliSessionIds: [], now: NOW })).toBe(undefined);
  });
});
