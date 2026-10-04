import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { markCliSessionActive } from "../../agents/cli-active-sessions.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { clearClaudeCliNativeSubagentCacheForTest } from "../cli-native-subagent.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { chatNativeSubagentHandlers } from "./chat-native-subagent-handler.js";
import type { RespondFn } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  clearClaudeCliNativeSubagentCacheForTest();
  vi.unstubAllEnvs();
});

const BOUND_ID = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
const RUNNING_ID = "0f6c1d0e-62a4-4b8f-9f36-3d2f6b7c1a11";

async function writeSubagent(configDir: string, cliSessionId: string, toolUseId: string) {
  const projectDir = path.join(configDir, "projects", "demo-workspace");
  const subagentsDir = path.join(projectDir, cliSessionId, "subagents");
  await fs.mkdir(subagentsDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, `${cliSessionId}.jsonl`), "");
  await fs.writeFile(
    path.join(subagentsDir, "agent-a1.meta.json"),
    JSON.stringify({ agentType: "Explore", description: "Scan logs", toolUseId }),
  );
  await fs.writeFile(
    path.join(subagentsDir, "agent-a1.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      uuid: "a-1",
      isSidechain: true,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done scanning." }],
        stop_reason: "end_turn",
      },
    })}\n`,
  );
}

async function get(sessionKey: string, toolCallId: string) {
  const respond = vi.fn<RespondFn>();
  await expectDefined(
    chatNativeSubagentHandlers["chat.nativeSubagent.get"],
    "native subagent handler",
  )({
    params: { sessionKey, toolCallId },
    context: createDirectChatContext(),
    req: { type: "req", id: "native-subagent", method: "chat.nativeSubagent.get" },
    client: null,
    isWebchatConnect: () => false,
    respond,
  });
  return respond.mock.calls[0]?.slice(0, 2);
}

it("reads subagents of the bound and the running Claude session under CLAUDE_CONFIG_DIR", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const configDir = await tempDirs.make("openclaw-native-subagent-config-");
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    await writeSubagent(configDir, BOUND_ID, "toolu_bound");
    await writeSubagent(configDir, RUNNING_ID, "toolu_running");
    const sessionKey = "agent:main:native-subagent";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, sessionId: "native-subagent" },
      {
        sessionId: "native-subagent",
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: BOUND_ID } },
      },
    );

    expect(await get(sessionKey, "toolu_bound")).toEqual([
      true,
      expect.objectContaining({
        ok: true,
        agentType: "Explore",
        description: "Scan logs",
        background: false,
        status: "done",
        messages: [expect.objectContaining({ role: "assistant" })],
      }),
    ]);
    // A turn's new Claude session is only bound when the turn ends.
    expect(await get(sessionKey, "toolu_running")).toEqual([
      true,
      { ok: false, unavailableReason: "not_found" },
    ]);
    const release = markCliSessionActive({
      backendId: "claude-cli",
      sessionKey,
      cliSessionId: RUNNING_ID,
    });
    try {
      expect(await get(sessionKey, "toolu_running")).toEqual([
        true,
        expect.objectContaining({ ok: true, status: "done" }),
      ]);
    } finally {
      release();
    }
  });
});

it("does not reveal sessions that do not exist", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    expect(await get("agent:main:missing", "toolu_bound")).toEqual([false, undefined]);
  });
});
