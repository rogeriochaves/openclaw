import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildInterSessionPromptContext } from "../sessions/input-provenance.js";
import { readClaudeCliSessionMessages } from "./cli-session-history.claude.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";

const DRIFT_NOTE =
  "OpenClaw resumed this CLI session after prompt content changed. Follow the current turn's instructions; changed=system-prompt.";

function user(content: unknown, timestamp: number, meta?: Record<string, unknown>) {
  return { role: "user", content, timestamp, ...(meta ? { __openclaw: meta } : {}) };
}

function cliMeta(externalId: string) {
  return { importedFrom: "claude-cli", externalId, cliSessionId: "session-1" };
}

describe("cli session history inter-session prompts", () => {
  it("records inter-session provenance from the routed prompt envelope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-inter-session-"));
    try {
      const sessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
      const projectsDir = path.join(root, ".claude", "projects", "demo-workspace");
      await fs.mkdir(projectsDir, { recursive: true });
      const provenance = {
        kind: "inter_session" as const,
        sourceSessionKey: "agent:main:main",
        sourceChannel: "webchat",
        sourceTool: "sessions_send",
      };
      const envelope = buildInterSessionPromptContext(provenance).text;
      const rows = [
        { uuid: "routed-1", content: `${envelope}\n${DRIFT_NOTE}\nPlease check the build.` },
        { uuid: "routed-2", content: [{ type: "text", text: `${envelope}\nBlock body.` }] },
        {
          uuid: "announce-1",
          content: `${envelope}\n${DRIFT_NOTE}\nAgent-to-agent announce step.`,
        },
        {
          uuid: "look-alike-1",
          content: "[Inter-session message] sourceTool=sessions_send isUser=false\nTyped by hand.",
        },
      ];
      await fs.writeFile(
        path.join(projectsDir, `${sessionId}.jsonl`),
        rows
          .map(({ uuid, content }) =>
            JSON.stringify({ type: "user", uuid, message: { role: "user", content } }),
          )
          .join("\n"),
        "utf-8",
      );

      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir: root });

      expect(messages).toMatchObject([
        { role: "user", content: `${envelope}\nPlease check the build.`, provenance },
        { role: "user", content: [{ type: "text", text: `${envelope}\nBlock body.` }], provenance },
        { role: "user" },
      ]);
      expect((messages[2] as { provenance?: unknown }).provenance).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("dedupes routed prompts whose drift note sits under the inter-session envelope", () => {
    const provenance = {
      kind: "inter_session",
      sourceSessionKey: "agent:main:main",
      sourceTool: "sessions_send",
    };
    const envelope = buildInterSessionPromptContext({
      kind: "inter_session",
      sourceSessionKey: "agent:main:main",
      sourceTool: "sessions_send",
    }).text;
    const routed = { ...user(`${envelope}\nPlease check the build.`, 1_000), provenance };
    const settled = {
      ...user("[Subagent Context] Every subagent has settled.", 2_000),
      provenance: { kind: "inter_session", sourceTool: "subagent_settle" },
    };
    const settleEnvelope = buildInterSessionPromptContext({
      kind: "inter_session",
      sourceTool: "subagent_settle",
    }).text;

    const merged = mergeImportedChatHistoryMessages({
      localMessages: [routed, settled],
      importedMessages: [
        user(`${envelope}\n${DRIFT_NOTE}\nPlease check the build.`, 1_001, cliMeta("routed")),
        user(
          `${settleEnvelope}\n[Subagent Context] Every subagent has settled.`,
          2_001,
          cliMeta("settled"),
        ),
      ],
    });

    expect(merged).toEqual([
      { ...routed, __openclaw: cliMeta("routed") },
      { ...settled, __openclaw: cliMeta("settled") },
    ]);
  });

  it("dedupes prompts carrying queued system event lines", () => {
    const localMessage = user("what changed?", 1_000);
    const importedMessage = user(
      `${DRIFT_NOTE}\n\nSystem: [2026-09-30 17:16:38 UTC] Gateway connected.\nSystem: second line\n\nwhat changed?`,
      1_001,
      cliMeta("system-events"),
    );

    expect(
      mergeImportedChatHistoryMessages({
        localMessages: [localMessage],
        importedMessages: [importedMessage],
      }),
    ).toEqual([{ ...localMessage, __openclaw: cliMeta("system-events") }]);
  });
});
