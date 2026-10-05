import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setClaudeCliBackgroundWorkDepsForTest } from "../cli-background-work.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { chatBackgroundWorkHandlers } from "./chat-background-work-handler.js";
import type { RespondFn } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  setClaudeCliBackgroundWorkDepsForTest();
  vi.unstubAllEnvs();
});

const BOUND_ID = "5b8b202c-f6bb-4046-9475-d2f15fd07530";

async function get(sessionKey: string) {
  const respond = vi.fn<RespondFn>();
  await expectDefined(
    chatBackgroundWorkHandlers["chat.backgroundWork.get"],
    "background work handler",
  )({
    params: { sessionKey },
    context: createDirectChatContext(),
    req: { type: "req", id: "background-work", method: "chat.backgroundWork.get" },
    client: null,
    isWebchatConnect: () => false,
    respond,
  });
  return respond.mock.calls[0]?.slice(0, 2);
}

it("lists the background subagents of the bound Claude session", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const configDir = await tempDirs.make("openclaw-background-work-config-");
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    // No process table: only the transcript-backed items are listed.
    setClaudeCliBackgroundWorkDepsForTest({ sample: () => undefined });
    const projectDir = path.join(configDir, "projects", "demo-workspace");
    const subagentsDir = path.join(projectDir, BOUND_ID, "subagents");
    await fs.mkdir(subagentsDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, `${BOUND_ID}.jsonl`), "");
    await fs.writeFile(
      path.join(subagentsDir, "agent-a1.meta.json"),
      JSON.stringify({
        description: "Scan logs",
        toolUseId: "toolu_1",
        requestShape: "background",
      }),
    );
    await fs.writeFile(
      path.join(subagentsDir, "agent-a1.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t", name: "Grep", input: { pattern: "ERROR" } }],
          stop_reason: "tool_use",
        },
      })}\n`,
    );
    const sessionKey = "agent:main:background-work";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, sessionId: "background-work" },
      {
        sessionId: "background-work",
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: BOUND_ID } },
      },
    );

    expect(await get(sessionKey)).toEqual([
      true,
      expect.objectContaining({
        available: true,
        processScan: false,
        active: 1,
        items: [
          expect.objectContaining({
            id: "subagent:a1",
            kind: "subagent",
            status: "running",
            title: "Scan logs",
            activity: "Grep: ERROR",
          }),
        ],
      }),
    ]);
  });
});

it("reports sessions without a Claude session as unavailable and hides missing ones", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const sessionKey = "agent:main:plain";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, sessionId: "plain" },
      { sessionId: "plain", updatedAt: 1 },
    );

    expect(await get(sessionKey)).toEqual([
      true,
      expect.objectContaining({ available: false, items: [], active: 0 }),
    ]);
    expect(await get("agent:main:missing")).toEqual([false, undefined]);
  });
});
