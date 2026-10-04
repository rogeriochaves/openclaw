import { describe, expect, it } from "vitest";
import { cliMeta, mergeImportedChatHistoryMessages } from "./cli-session-history.test-support.js";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-04T09:51:51.000Z");

function texts(messages: unknown[]): string[] {
  return messages.flatMap((message) => {
    const record = message as { role?: string; content?: unknown };
    if (typeof record.content === "string") {
      return [`${record.role}: ${record.content}`];
    }
    return [];
  });
}

describe("Claude CLI prompts queued behind a busy run", () => {
  // A prompt sent while a run is busy keeps its send time, but the transcript
  // writes it after that run's reply, when the queued turn starts.
  const prompt = "Just my voice? What about the rest?";
  const queuedTurn = (replyAt: number, deliveredAt: number) => ({
    localMessages: [
      { role: "user", content: "Those are all horrible!", timestamp: T0 },
      {
        role: "assistant",
        content: "I'm rebuilding the pipeline now.",
        stopReason: "stop",
        timestamp: replyAt,
      },
      { role: "user", content: prompt, timestamp: T0 + 4 * MINUTE },
    ],
    importedMessages: [
      {
        role: "user",
        content: "Those are all horrible!",
        timestamp: T0 + 1_000,
        __openclaw: cliMeta("u1"),
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", name: "Bash", arguments: { command: "ls" } }],
        timestamp: T0 + 30_000,
        __openclaw: cliMeta("a-tool"),
      },
      {
        role: "assistant",
        content: "I'm rebuilding the pipeline now.",
        timestamp: replyAt - 4 * MINUTE,
        __openclaw: cliMeta("a1"),
      },
      { role: "user", content: prompt, timestamp: deliveredAt, __openclaw: cliMeta("u2") },
    ],
  });

  it("keeps the queued prompt after the reply that finished before it ran", () => {
    const merged = mergeImportedChatHistoryMessages(
      queuedTurn(T0 + 5 * MINUTE, T0 + 5 * MINUTE + 10_000),
    );

    expect(texts(merged)).toEqual([
      "user: Those are all horrible!",
      "assistant: I'm rebuilding the pipeline now.",
      `user: ${prompt}`,
    ]);
  });

  it("shows the queued prompt once when Claude got it long after it was sent", () => {
    const merged = mergeImportedChatHistoryMessages(
      queuedTurn(T0 + 20 * MINUTE - 1_000, T0 + 20 * MINUTE),
    );

    expect(texts(merged).filter((text) => text === `user: ${prompt}`)).toHaveLength(1);
  });

  it("keeps the same prompt twice when the second one was queued", () => {
    const merged = mergeImportedChatHistoryMessages({
      localMessages: [
        { role: "user", content: "go on", timestamp: T0 },
        { role: "assistant", content: "Round 1 is done.", timestamp: T0 + 40 * MINUTE },
        { role: "user", content: "go on", timestamp: T0 + 30 * MINUTE },
      ],
      importedMessages: [
        { role: "user", content: "go on", timestamp: T0 + 1_000, __openclaw: cliMeta("u1") },
        {
          role: "assistant",
          content: "Round 1 is done.",
          timestamp: T0 + 40 * MINUTE,
          __openclaw: cliMeta("a1"),
        },
        {
          role: "user",
          content: "go on",
          timestamp: T0 + 40 * MINUTE + 1_000,
          __openclaw: cliMeta("u2"),
        },
      ],
    });

    expect(texts(merged)).toEqual(["user: go on", "assistant: Round 1 is done.", "user: go on"]);
  });
});
