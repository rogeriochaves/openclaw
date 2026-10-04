import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearClaudeCliNativeSubagentCacheForTest,
  readClaudeCliNativeSubagent,
  resolveClaudeCliNativeSubagent,
} from "./cli-native-subagent.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
// Fixtures live under the temp home dir, so ignore any configured Claude config dir.
beforeEach(() => vi.stubEnv("CLAUDE_CONFIG_DIR", ""));
afterEach(() => {
  clearClaudeCliNativeSubagentCacheForTest();
  vi.unstubAllEnvs();
});

const SESSION_ID = "5b8b202c-f6bb-4046-9475-d2f15fd07530";

function row(type: "user" | "assistant", uuid: string, content: unknown, stopReason?: string) {
  return `${JSON.stringify({
    type,
    uuid,
    isSidechain: true,
    agentId: "a1",
    timestamp: "2026-10-04T12:00:00.000Z",
    message: { role: type, content, ...(stopReason ? { stop_reason: stopReason } : {}) },
  })}\n`;
}

async function createSubagent() {
  const homeDir = await tempDirs.make("openclaw-native-subagent-");
  const projectDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
  const subagentsDir = path.join(projectDir, SESSION_ID, "subagents");
  await fs.mkdir(subagentsDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, `${SESSION_ID}.jsonl`), "");
  for (const [agentId, toolUseId, requestShape] of [
    ["a0", "toolu_other", "foreground"],
    ["a1", "toolu_spawn", "background"],
  ]) {
    await fs.writeFile(
      path.join(subagentsDir, `agent-${agentId}.meta.json`),
      JSON.stringify({
        agentType: "general-purpose",
        description: "Scan logs",
        toolUseId,
        requestShape,
      }),
    );
  }
  const transcriptPath = path.join(subagentsDir, "agent-a1.jsonl");
  await fs.writeFile(
    transcriptPath,
    [
      row("user", "u0", "Scan the logs"),
      row("assistant", "a-1", [{ type: "text", text: "Looking." }]),
      row(
        "assistant",
        "a-2",
        [{ type: "tool_use", id: "toolu_grep", name: "Grep", input: { pattern: "ERROR" } }],
        "tool_use",
      ),
      row("user", "u-1", [{ type: "tool_result", tool_use_id: "toolu_grep", content: "2 hits" }]),
    ].join(""),
  );
  return { homeDir, transcriptPath };
}

it("follows a subagent transcript by its spawning tool call until it finishes", async () => {
  const { homeDir, transcriptPath } = await createSubagent();
  expect(
    await resolveClaudeCliNativeSubagent({
      cliSessionIds: [SESSION_ID],
      toolCallId: "toolu_missing",
      homeDir,
    }),
  ).toBeUndefined();
  const location = await resolveClaudeCliNativeSubagent({
    cliSessionIds: [SESSION_ID],
    toolCallId: "toolu_spawn",
    homeDir,
  });
  expect(location).toEqual({
    transcriptPath,
    agentType: "general-purpose",
    description: "Scan logs",
    background: true,
  });

  const first = await readClaudeCliNativeSubagent({ location: location! });
  expect(first?.status).toBe("running");
  // The prompt row is left out; the tool call and its result share one message.
  expect(first?.messages.map((message) => message.role)).toEqual(["assistant", "assistant"]);
  expect(first?.messages[1]?.content).toEqual([
    expect.objectContaining({ type: "toolcall", id: "toolu_grep", name: "Grep" }),
    expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_grep", name: "Grep" }),
  ]);
  expect(first).toMatchObject({ omittedEarlier: false, reset: false, more: false });

  // A row still being written is not consumed until its newline lands.
  const finalRow = row("assistant", "a-3", [{ type: "text", text: "Found 2 errors." }], "end_turn");
  await fs.appendFile(transcriptPath, finalRow.slice(0, 20));
  const partial = await readClaudeCliNativeSubagent({ location: location!, cursor: first!.cursor });
  expect(partial).toMatchObject({ messages: [], cursor: first!.cursor, status: "running" });
  // A complete final reply without its newline must not end the subagent before it is read.
  await fs.appendFile(transcriptPath, finalRow.slice(20, -1));
  const unterminated = await readClaudeCliNativeSubagent({
    location: location!,
    cursor: first!.cursor,
  });
  expect(unterminated).toMatchObject({ messages: [], status: "running" });

  await fs.appendFile(transcriptPath, "\n");
  const last = await readClaudeCliNativeSubagent({ location: location!, cursor: first!.cursor });
  expect(last?.status).toBe("done");
  expect(last?.messages).toEqual([
    expect.objectContaining({
      role: "assistant",
      content: [{ type: "text", text: "Found 2 errors." }],
    }),
  ]);

  // A cursor past the end means the file was replaced: start over.
  const restarted = await readClaudeCliNativeSubagent({
    location: location!,
    cursor: last!.cursor + 1_000,
  });
  expect(restarted).toMatchObject({ reset: true });
  expect(restarted?.messages).toHaveLength(3);
});

it("rejects session ids that would leave the Claude projects directory", async () => {
  const { homeDir } = await createSubagent();
  expect(
    await resolveClaudeCliNativeSubagent({
      cliSessionIds: [`../demo-workspace/${SESSION_ID}`],
      toolCallId: "toolu_spawn",
      homeDir,
    }),
  ).toBeUndefined();
});

it("looks through every Claude session of the OpenClaw session", async () => {
  const { homeDir, transcriptPath } = await createSubagent();
  expect(
    await resolveClaudeCliNativeSubagent({
      cliSessionIds: ["0f6c1d0e-62a4-4b8f-9f36-3d2f6b7c1a11", SESSION_ID],
      toolCallId: "toolu_spawn",
      homeDir,
    }),
  ).toMatchObject({ transcriptPath, background: true });
  expect(
    await resolveClaudeCliNativeSubagent({ cliSessionIds: [], toolCallId: "toolu_spawn", homeDir }),
  ).toBeUndefined();
});

it("reports a finished subagent whose final reply is longer than the status window", async () => {
  const { homeDir, transcriptPath } = await createSubagent();
  await fs.appendFile(
    transcriptPath,
    row("assistant", "a-3", [{ type: "text", text: "y".repeat(200_000) }], "end_turn"),
  );
  const location = await resolveClaudeCliNativeSubagent({
    cliSessionIds: [SESSION_ID],
    toolCallId: "toolu_spawn",
    homeDir,
  });
  expect((await readClaudeCliNativeSubagent({ location: location! }))?.status).toBe("done");
});

it("reads past large non-message rows from the start of the transcript", async () => {
  const { homeDir, transcriptPath } = await createSubagent();
  const listing = `${JSON.stringify({ type: "attachment", attachment: { text: "x".repeat(600_000) } })}\n`;
  const original = await fs.readFile(transcriptPath, "utf8");
  const [prompt, ...rest] = original.split(/(?<=\n)/);
  await fs.writeFile(transcriptPath, [prompt, listing, ...rest].join(""));
  const location = await resolveClaudeCliNativeSubagent({
    cliSessionIds: [SESSION_ID],
    toolCallId: "toolu_spawn",
    homeDir,
  });

  const first = await readClaudeCliNativeSubagent({ location: location! });
  expect(first).toMatchObject({ omittedEarlier: false, more: true, messages: [] });
  // A row longer than one window is skipped page by page; nothing after it is lost.
  const roles: unknown[] = [];
  let page = first;
  while (page?.more) {
    page = await readClaudeCliNativeSubagent({ location: location!, cursor: page.cursor });
    roles.push(...(page?.messages.map((message) => message.role) ?? []));
  }
  expect(roles).toEqual(["assistant", "assistant"]);
});

it("reads the Claude config dir instead of the home dir when one is set", async () => {
  const { homeDir, transcriptPath } = await createSubagent();
  const otherHome = await tempDirs.make("openclaw-native-subagent-home-");
  const params = { cliSessionIds: [SESSION_ID], toolCallId: "toolu_spawn", homeDir: otherHome };
  expect(await resolveClaudeCliNativeSubagent(params)).toBeUndefined();
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(homeDir, ".claude"));
  expect(await resolveClaudeCliNativeSubagent(params)).toMatchObject({ transcriptPath });
});

it.skipIf(process.platform === "win32")("does not follow a symlinked transcript", async () => {
  const { homeDir, transcriptPath } = await createSubagent();
  const outside = path.join(await tempDirs.make("openclaw-native-subagent-outside-"), "x.jsonl");
  await fs.rename(transcriptPath, outside);
  await fs.symlink(outside, transcriptPath);
  const location = await resolveClaudeCliNativeSubagent({
    cliSessionIds: [SESSION_ID],
    toolCallId: "toolu_spawn",
    homeDir,
  });
  expect(await readClaudeCliNativeSubagent({ location: location! })).toBeUndefined();
});
