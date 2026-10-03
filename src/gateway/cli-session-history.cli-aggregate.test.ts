// Claude CLI aggregate projection tests cover replies whose run outlives one
// native Claude turn, so the local row joins text across extra native rows.
import { describe, expect, it } from "vitest";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";

const MINUTE = 60_000;

const meta = (externalId: string) => ({
  importedFrom: "claude-cli",
  cliSessionId: "session-1",
  externalId,
});

const importedText = (externalId: string, text: string, timestamp: number) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "end_turn",
  timestamp,
  __openclaw: meta(externalId),
});

const importedTool = (externalId: string, timestamp: number) => ({
  role: "assistant",
  content: [
    { type: "toolcall", id: externalId, name: "Bash", arguments: {} },
    { type: "tool_result", tool_use_id: externalId, content: "ok" },
  ],
  stopReason: "tool_use",
  timestamp,
  __openclaw: meta(externalId),
});

const importedUser = (externalId: string, text: string, timestamp: number) => ({
  role: "user",
  content: text,
  timestamp,
  __openclaw: meta(externalId),
});

function visibleAssistantTexts(messages: unknown[]): string[] {
  return messages.flatMap((message) => {
    const record = message as { role?: string; content?: unknown };
    if (record.role !== "assistant" || !Array.isArray(record.content)) {
      return [];
    }
    const text = record.content
      .filter((block: { type?: string }) => block.type === "text")
      .map((block: { text?: string }) => block.text)
      .join("\n");
    return text ? [text] : [];
  });
}

describe("Claude CLI aggregates that span several native turns", () => {
  it("shows a reply once when a task notification woke the CLI inside the run", () => {
    const localUser = { role: "user", content: "start round 2", timestamp: 0 };
    const localAggregate = {
      role: "assistant",
      content: [{ type: "text", text: "Round 2 is running.\n\nRound 2 is on the site." }],
      stopReason: "stop",
      timestamp: 7 * MINUTE,
      idempotencyKey: "cli-assistant:run-1",
    };
    const merged = mergeImportedChatHistoryMessages({
      localMessages: [localUser, localAggregate],
      importedMessages: [
        importedUser("native-user", "start round 2", 1),
        importedTool("native-tool-1", 10_000),
        importedText("native-first", "Round 2 is running.", 20_000),
        importedUser(
          "native-notification",
          "<task-notification>\n<task-id>a1</task-id>\n</task-notification>",
          6 * MINUTE,
        ),
        importedTool("native-tool-2", 6 * MINUTE + 1_000),
        importedText("native-final", "Round 2 is on the site.", 7 * MINUTE),
      ],
    });

    expect(visibleAssistantTexts(merged)).toEqual([
      "Round 2 is running.",
      "Round 2 is on the site.",
    ]);
  });

  it("shows a reply once when an omitted native record sits between its segments", () => {
    const localUser = { role: "user", content: "docs rules too?", timestamp: 0 };
    const localAggregate = {
      role: "assistant",
      content: [{ type: "text", text: "Checking the previews.\n\nThe docs rules are in." }],
      stopReason: "aborted",
      timestamp: 3 * MINUTE,
      idempotencyKey: "cli-assistant:run-2",
    };
    const merged = mergeImportedChatHistoryMessages({
      localMessages: [localUser, localAggregate],
      importedMessages: [
        importedUser("native-user", "docs rules too?", 1),
        importedText("native-progress", "Checking the previews.", 10_000),
        importedTool("native-tool", 11_000),
        importedUser(
          "native-omitted",
          "[Claude CLI history record omitted from context because it exceeded 1 MiB.]",
          12_000,
        ),
        importedTool("native-read", 13_000),
        importedText("native-final", "The docs rules are in.", 20_000),
      ],
    });

    expect(visibleAssistantTexts(merged)).toEqual([
      "Checking the previews.",
      "The docs rules are in.",
    ]);
  });

  it("shows a reply once when the run ended long after it and abort wrote a second copy", () => {
    const reply = "Yes, good point. The guides are where it starts.";
    const localUser = { role: "user", content: "use the guides", timestamp: 0 };
    const abortPartial = {
      role: "assistant",
      content: [{ type: "text", text: reply }],
      stopReason: "stop",
      timestamp: 9 * MINUTE,
      idempotencyKey: "run-3:assistant",
      openclawAbort: { aborted: true, origin: "rpc", runId: "run-3" },
      __openclaw: { runId: "run-3" },
    };
    const cliAggregate = {
      role: "assistant",
      content: [{ type: "text", text: reply }],
      stopReason: "aborted",
      timestamp: 9 * MINUTE + 1_000,
      idempotencyKey: "cli-assistant:run-3",
    };
    const merged = mergeImportedChatHistoryMessages({
      localMessages: [localUser, abortPartial, cliAggregate],
      importedMessages: [
        importedUser("native-user", "use the guides", 1),
        importedTool("native-agent", 20_000),
        importedText("native-final", reply, 30_000),
      ],
    });

    expect(visibleAssistantTexts(merged)).toEqual([reply]);
  });

  it("keeps two equal replies from different runs", () => {
    const merged = mergeImportedChatHistoryMessages({
      localMessages: [
        { role: "user", content: "first", timestamp: 0 },
        {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          timestamp: 1_000,
          idempotencyKey: "cli-assistant:run-a",
        },
        { role: "user", content: "second", timestamp: 2_000 },
        {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          timestamp: 3_000,
          idempotencyKey: "cli-assistant:run-b",
        },
      ],
      importedMessages: [
        importedUser("native-u1", "first", 1),
        importedText("native-a1", "Done.", 900),
        importedUser("native-u2", "second", 2_001),
        importedText("native-a2", "Done.", 2_900),
      ],
    });

    expect(visibleAssistantTexts(merged)).toEqual(["Done.", "Done."]);
  });
});
