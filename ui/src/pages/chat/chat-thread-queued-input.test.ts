import { describe, expect, it } from "vitest";
import { t } from "../../i18n/index.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { buildChatItems, type BuildChatItemsProps } from "./chat-thread-build.ts";

type PendingInput = NonNullable<BuildChatItemsProps["pendingInputs"]>[number];

const SENT_AT = 1_000_000;
const userTurn = {
  role: "user",
  content: "Those drafts break every rule.",
  timestamp: SENT_AT - 4 * 60_000,
  __openclaw: { id: "user-1", seq: 1, idempotencyKey: "run-a:user" },
};
// The busy run finished (or was stopped) after the next message was sent.
const reply = {
  role: "assistant",
  content: [{ type: "text", text: "I'm rebuilding the pipeline now." }],
  stopReason: "stop",
  timestamp: SENT_AT + 80_000,
  __openclaw: { id: "assistant-1", seq: 2, idempotencyKey: "run-a:assistant" },
};
const queued: PendingInput = {
  id: "input-1",
  runId: "run-q",
  acceptedAt: SENT_AT,
  state: "queued",
  message: {
    role: "user",
    content: "Just my voice?",
    timestamp: SENT_AT,
    __openclaw: { id: "pending:input-1" },
  },
};

function rows(overrides: Partial<BuildChatItemsProps>): string[] {
  return buildChatItems({
    paneId: "queued-input",
    sessionKey: "agent:main:queued-input",
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  }).flatMap((item) =>
    item.kind === "group"
      ? item.messages.map(({ message }) => extractTextCached(message) ?? "")
      : item.kind === "notice"
        ? [`notice: ${item.text}`]
        : [item.kind],
  );
}

describe("input queued behind a busy run", () => {
  it("is marked as queued instead of looking sent", () => {
    expect(
      rows({
        messages: [userTurn],
        pendingInputs: [queued],
        runId: "run-a",
        stream: "I'm rebuilding",
        streamStartedAt: SENT_AT - 3 * 60_000,
        runWorking: true,
      }),
    ).toEqual([
      "Those drafts break every rule.",
      "stream",
      "reading-indicator",
      "Just my voice?",
      `notice: ${t("chat.pendingInputs.queued")}`,
    ]);
  });

  it("stays below the reply that finished after it was sent", () => {
    expect(rows({ messages: [userTurn, reply], pendingInputs: [queued] })).toEqual([
      "Those drafts break every rule.",
      "I'm rebuilding the pipeline now.",
      "Just my voice?",
      `notice: ${t("chat.pendingInputs.queued")}`,
    ]);
  });
});

describe("input interrupted days ago", () => {
  it("stays at its own time instead of jumping below later turns", () => {
    const interrupted: PendingInput = {
      ...queued,
      state: "interrupted",
      acceptedAt: SENT_AT - 60_000,
      message: { ...queued.message, timestamp: SENT_AT - 60_000 },
    };
    expect(rows({ messages: [userTurn, reply], pendingInputs: [interrupted] })).toEqual([
      "Those drafts break every rule.",
      "Just my voice?",
      `notice: ${t("chat.pendingInputs.interrupted")}`,
      "I'm rebuilding the pipeline now.",
    ]);
  });
});
