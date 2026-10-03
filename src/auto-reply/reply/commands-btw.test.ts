// Tests background side-question command routing and typing controller integration.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveMessageActionTurnCapability } from "../../gateway/message-action-turn-capability.js";
import { expectObjectFields, mockFirstObjectArg } from "../../test-utils/mock-call-assertions.js";
import { resolveAgentDirMock } from "./commands-agent-scope.test-support.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import { createMockTypingController } from "./test-helpers.js";

const runBtwSideQuestionMock = vi.fn();

vi.mock("../../agents/btw.js", () => ({
  runBtwSideQuestion: (...args: unknown[]) => runBtwSideQuestionMock(...args),
}));

const readCatchupTranscriptRowsMock = vi.fn();

vi.mock("../../agents/catchup-transcript.js", () => ({
  readCatchupTranscriptRows: (...args: unknown[]) => readCatchupTranscriptRowsMock(...args),
}));

const { handleBtwCommand, handleCatchupCommand, handleMainCommand } =
  await import("./commands-btw.js");
const { readSideThread, recordSideThreadExchange, resetSideThreadsForTest } =
  await import("./side-thread.js");

function buildParams(commandBody: string) {
  const cfg = {
    commands: { text: true },
    channels: { whatsapp: { allowFrom: ["*"] } },
  } as OpenClawConfig;
  return buildCommandTestParams(commandBody, cfg, undefined, { workspaceDir: "/tmp/workspace" });
}

describe("handleBtwCommand", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    runBtwSideQuestionMock.mockReset();
    resetSideThreadsForTest();
    resolveAgentDirMock.mockReset();
    resolveAgentDirMock.mockImplementation(
      (_cfg: unknown, agentId: string) => `/tmp/workspace/.openclaw/agents/${agentId}/agent`,
    );
  });

  it("returns usage when the side question is missing", async () => {
    const result = await handleBtwCommand(buildParams("/btw"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /btw [side question]" },
    });
  });

  it("ignores /btw when text commands are disabled", async () => {
    const result = await handleBtwCommand(buildParams("/btw what changed?"), false);

    expect(result).toBeNull();
    expect(runBtwSideQuestionMock).not.toHaveBeenCalled();
  });

  it("ignores /btw from unauthorized senders", async () => {
    const params = buildParams("/btw what changed?");
    params.command.isAuthorizedSender = false;

    const result = await handleBtwCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
    expect(runBtwSideQuestionMock).not.toHaveBeenCalled();
  });

  it("requires an active session context", async () => {
    const params = buildParams("/btw what changed?");
    params.sessionEntry = undefined;

    const result = await handleBtwCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚠️ /btw requires an active session with existing context." },
    });
  });

  it("returns an actionable visible error before running a restricted side question", async () => {
    const params = buildParams("/btw what changed?");
    params.agentDir = "/tmp/agent";
    params.sessionEntry = { sessionId: "session-1", updatedAt: Date.now() };
    params.ctx.ConversationToolPolicy = { deny: ["exec"] };

    const result = await handleBtwCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "⚠️ /btw cannot enforce this conversation's tool policy. Ask in the main conversation or switch this session to the embedded runtime.",
        btw: { question: "what changed?" },
        isError: true,
      },
    });
    expect(runBtwSideQuestionMock).not.toHaveBeenCalled();
  });

  it.each(["image", "described image", "document"] as const)(
    "handleBtwCommand forwards only current undescribed images: %s",
    async (attachment) => {
      const params = buildParams("/btw describe this");
      params.sessionEntry = { sessionId: "session-1", updatedAt: Date.now() };
      const dir = tempDirs.make("openclaw-btw-images-");
      const isDocument = attachment === "document";
      const data = isDocument
        ? Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n")
        : Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
            "base64",
          );
      const file = path.join(dir, isDocument ? "document.pdf" : "photo.png");
      await writeFile(file, data);
      params.ctx.media = [
        {
          path: file,
          contentType: isDocument ? "application/pdf" : "image/png",
          kind: isDocument ? "document" : "image",
          workspaceDir: dir,
        },
      ];
      if (attachment === "described image") {
        params.ctx.Body = "[Image]\nDescription:\na tiny dot image";
        params.ctx.MediaUnderstanding = [
          {
            kind: "image.description",
            attachmentIndex: 0,
            provider: "test",
            model: "test",
            text: "a tiny dot image",
          },
        ];
      }

      await handleBtwCommand(params, true);

      const runnerArgs = mockFirstObjectArg(runBtwSideQuestionMock);
      expect(runnerArgs.question).toBe("describe this");
      expect(runnerArgs.images).toEqual(
        attachment === "image"
          ? [{ type: "image", data: data.toString("base64"), mimeType: "image/png" }]
          : undefined,
      );
    },
  );

  it("delegates to the side-question runner", async () => {
    const params = buildParams("/btw what changed?");
    const typing = createMockTypingController();
    params.typing = typing;
    params.command.senderId = "sender-1";
    params.command.senderIsOwner = true;
    params.ctx.AccountId = "account-1";
    params.ctx.RuntimePolicySessionKey = "agent:main:runtime-policy";
    params.ctx.GroupChannel = "#ops";
    params.ctx.GroupSpace = "workspace-1";
    params.ctx.SenderId = "sender-1";
    params.ctx.SenderName = "Rosita";
    params.ctx.SenderUsername = "rosita";
    params.ctx.SenderE164 = "+15550001";
    params.ctx.MessageThreadId = "thread-1";
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "session-1",
      groupId: "group-1",
      parentSessionKey: "agent:main:parent",
      updatedAt: Date.now(),
    };
    let resolvedTurnContext: ReturnType<typeof resolveMessageActionTurnCapability> | undefined;
    runBtwSideQuestionMock.mockImplementation(async (input: Record<string, unknown>) => {
      resolvedTurnContext = resolveMessageActionTurnCapability({
        token:
          typeof input.messageActionTurnCapability === "string"
            ? input.messageActionTurnCapability
            : undefined,
        agentId: "main",
        runId: typeof input.authorityRunId === "string" ? input.authorityRunId : undefined,
        sessionKey: "agent:main:runtime-policy",
        sessionId: "session-1",
      });
      return { text: "nothing important" };
    });

    const result = await handleBtwCommand(params, true);

    const runnerArgs = mockFirstObjectArg(runBtwSideQuestionMock);
    expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
    expectObjectFields(runnerArgs, {
      question: "what changed?",
      agentId: params.agentId,
      sessionEntry: params.sessionEntry,
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
      messageChannel: "whatsapp",
      messageProvider: "whatsapp",
      agentAccountId: "account-1",
      sandboxSessionKey: "agent:main:runtime-policy",
      messageThreadId: "thread-1",
      groupId: "group-1",
      groupChannel: "#ops",
      groupSpace: "workspace-1",
      spawnedBy: "agent:main:parent",
      senderId: "sender-1",
      senderName: "Rosita",
      senderUsername: "rosita",
      senderE164: "+15550001",
      senderIsOwner: true,
    });
    expect(runnerArgs.agentDir).toBe(params.agentDir);
    expect(runnerArgs.messageActionTurnCapability).toEqual(expect.any(String));
    expect(runnerArgs.opts).toMatchObject({ runId: expect.any(String) });
    expect(runnerArgs.authorityRunId).toEqual(expect.any(String));
    expect(runnerArgs.authorityRunId).not.toBe(
      (runnerArgs.opts as { runId?: string } | undefined)?.runId,
    );
    expect(resolvedTurnContext).toMatchObject({
      requesterAccountId: "account-1",
      requesterSenderId: "sender-1",
      toolContext: {
        currentChannelProvider: "whatsapp",
      },
    });
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "nothing important", btw: { question: "what changed?" } },
    });
  });

  it("uses the originating target before the command transport target", async () => {
    const params = buildParams("/btw what changed?");
    params.ctx.OriginatingTo = "channel:source";
    params.ctx.NativeChannelId = "native:source";
    params.ctx.ChatType = "channel";
    params.command.to = "slash:transport";
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "source target" });

    await handleBtwCommand(params, true);

    expectObjectFields(mockFirstObjectArg(runBtwSideQuestionMock), {
      chatId: "native:source",
      chatType: "channel",
      messageTo: "channel:source",
      currentChannelId: "native:source",
    });
  });

  it("keeps provider and conversation target separate for side-question approvals", async () => {
    const params = buildParams("/btw what changed?");
    params.command.channel = "telegram";
    params.command.channelId = "telegram";
    params.command.to = "+2000";
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "targeted answer" });

    await handleBtwCommand(params, true);

    expectObjectFields(mockFirstObjectArg(runBtwSideQuestionMock), {
      messageChannel: "telegram",
      messageProvider: "telegram",
      currentChannelId: "+2000",
    });
  });

  it("does not mint current-turn context for Gateway chat with an explicit origin", async () => {
    const params = buildParams("/btw what changed?");
    params.ctx.Provider = "webchat";
    params.ctx.OriginatingChannel = "matrix";
    params.ctx.OriginatingTo = "!room:example.org";
    params.command.channel = "matrix";
    params.command.to = "!room:example.org";
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "origin answer" });

    await handleBtwCommand(params, true);

    expect(mockFirstObjectArg(runBtwSideQuestionMock).messageActionTurnCapability).toBeUndefined();
  });

  it("accepts /side as a /btw alias", async () => {
    const params = buildParams("/side what changed?");
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "alias answer" });

    const result = await handleBtwCommand(params, true);

    expect(mockFirstObjectArg(runBtwSideQuestionMock).question).toBe("what changed?");
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "alias answer", btw: { question: "what changed?" } },
    });
  });

  it("uses the canonical session agent when resolving a fallback agent dir", async () => {
    const params = buildParams("/btw what changed?");
    params.agentId = "worker-1";
    params.agentDir = undefined;
    params.sessionKey = "agent:worker-1:whatsapp:direct:12345";
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "resolved fallback" });

    const result = await handleBtwCommand(params, true);

    expect(String(mockFirstObjectArg(runBtwSideQuestionMock).agentDir)).toContain(
      "/agents/worker-1/agent",
    );
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "resolved fallback", btw: { question: "what changed?" } },
    });
  });

  it("reuses the prepared session agent directory", async () => {
    const params = buildParams("/btw what changed?");
    params.agentId = "worker-1";
    params.agentDir = "/tmp/worker-1-agent";
    params.sessionKey = "agent:worker-1:whatsapp:direct:12345";
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "resolved fallback" });

    const result = await handleBtwCommand(params, true);

    expect(resolveAgentDirMock).not.toHaveBeenCalled();
    expect(mockFirstObjectArg(runBtwSideQuestionMock).agentDir).toBe("/tmp/worker-1-agent");
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "resolved fallback", btw: { question: "what changed?" } },
    });
  });

  it("prefers the target session entry for side-question context", async () => {
    const params = buildParams("/btw what changed?");
    params.sessionKey = "agent:worker-1:whatsapp:direct:12345";
    params.sessionEntry = {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
    };
    params.sessionStore = {
      "agent:worker-1:whatsapp:direct:12345": {
        sessionId: "target-session",
        updatedAt: Date.now(),
      },
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "target context" });

    const result = await handleBtwCommand(params, true);

    const sideQuestionArgs = mockFirstObjectArg(runBtwSideQuestionMock);
    expectObjectFields(sideQuestionArgs.sessionEntry, { sessionId: "target-session" });
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "target context", btw: { question: "what changed?" } },
    });
  });
});

const CATCHUP_T0 = Date.UTC(2026, 9, 3, 9, 0);

function catchupRead() {
  return {
    rows: [
      {
        message: {
          role: "user",
          content: "fix the login bug",
          timestamp: CATCHUP_T0,
          __openclaw: {
            senderIsSelf: true,
            transport: { channel: "whatsapp", messageId: "wamid-owner" },
          },
        },
      },
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Fixed it and opened PR 12." }],
          timestamp: CATCHUP_T0 + 60_000,
        },
      },
    ],
    backgroundRows: [{ message: { role: "user", content: "earlier context" } }],
    truncated: false,
  };
}

function buildSessionParams(commandBody: string) {
  const params = buildParams(commandBody);
  params.agentDir = "/tmp/agent";
  params.sessionKey = "agent:main:main";
  params.sessionEntry = { sessionId: "session-1", updatedAt: Date.now() };
  params.cfg.agents = { defaults: { userTimezone: "UTC" } };
  return params;
}

describe("handleCatchupCommand", () => {
  beforeEach(() => {
    runBtwSideQuestionMock.mockReset();
    readCatchupTranscriptRowsMock.mockReset();
    resetSideThreadsForTest();
    readCatchupTranscriptRowsMock.mockReturnValue(catchupRead());
  });

  it("asks the side model with the catch-up prompt and renders numbered refs", async () => {
    const params = buildSessionParams("/catchup");
    params.blockReplyChunking = { minChars: 1, maxChars: 100, breakPreference: "paragraph" };
    runBtwSideQuestionMock.mockResolvedValue({
      text: JSON.stringify({
        fullReport: "m1",
        status: { state: "done", text: "Fixed", refs: ["m1"] },
      }),
    });

    const result = await handleCatchupCommand(params, true);

    expectObjectFields(mockFirstObjectArg(readCatchupTranscriptRowsMock), {
      agentId: params.agentId,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
    });
    const runnerArgs = mockFirstObjectArg(runBtwSideQuestionMock);
    expect(runnerArgs.question).toContain(
      'Since I sent this message at 09:00: "fix the login bug"',
    );
    expect(runnerArgs.contextMessages).toEqual([{ role: "user", content: "earlier context" }]);
    expect(runnerArgs.blockReplyChunking).toBeUndefined();
    expect(runnerArgs.replyBtw).toEqual({ question: "/catchup", kind: "catchup" });
    const text = [
      "Catch-up since your message at 09:00",
      "",
      "Full report: [1] 09:01",
      "",
      "**Where it stands**",
      "- Done. Fixed [1]",
      "",
      "**Refs**",
      '[1] 09:01 agent: "Fixed it and opened PR 12."',
    ].join("\n");
    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text,
        btw: { question: "/catchup", kind: "catchup" },
        replyToId: "wamid-owner",
        replyToTag: true,
      },
    });
    expect(readSideThread("agent:main:main")).toMatchObject([
      { kind: "catchup", question: "/catchup", answer: text },
    ]);
  });

  it("does not quote the owner's message from another channel", async () => {
    const params = buildSessionParams("/catchup");
    params.command.channel = "telegram";
    runBtwSideQuestionMock.mockResolvedValue({ text: "nothing new" });

    const result = await handleCatchupCommand(params, true);

    expect(result?.reply).toEqual({
      text: "Catch-up since your message at 09:00\n\nnothing new",
      btw: { question: "/catchup", kind: "catchup" },
    });
  });

  it("returns usage for arguments and refuses restricted tool policies", async () => {
    expect(await handleCatchupCommand(buildSessionParams("/catchup now"), true)).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /catchup" },
    });
    const params = buildSessionParams("/catchup");
    params.ctx.ConversationToolPolicy = { deny: ["exec"] };
    const refused = await handleCatchupCommand(params, true);
    expect(refused?.reply).toMatchObject({
      btw: { question: "/catchup", kind: "catchup" },
      isError: true,
    });
    expect(runBtwSideQuestionMock).not.toHaveBeenCalled();
  });
});

describe("side-chat follow-ups", () => {
  beforeEach(() => {
    runBtwSideQuestionMock.mockReset();
    resetSideThreadsForTest();
  });

  it("continues a live side thread and remembers the new exchange", async () => {
    recordSideThreadExchange("agent:main:main", {
      kind: "catchup",
      question: "/catchup",
      answer: "Catch-up since your message at 09:00\n\nAll done",
    });
    runBtwSideQuestionMock.mockResolvedValue({ text: "PR 12" });

    const result = await handleBtwCommand(buildSessionParams("/btw which PR?"), true);

    const question = String(mockFirstObjectArg(runBtwSideQuestionMock).question);
    expect(question).toContain("<side_chat_history>\nOwner: /catchup\nSide assistant: Catch-up");
    expect(question.endsWith("which PR?")).toBe(true);
    expect(result?.reply).toEqual({ text: "PR 12", btw: { question: "which PR?" } });
    expect(readSideThread("agent:main:main").map((entry) => entry.answer)).toEqual([
      "Catch-up since your message at 09:00\n\nAll done",
      "PR 12",
    ]);
  });

  it("remembers streamed answers", async () => {
    const params = buildSessionParams("/btw what changed?");
    const onBlockReply = vi.fn();
    params.opts = { onBlockReply };
    runBtwSideQuestionMock.mockImplementation(async (input: { opts?: typeof params.opts }) => {
      await input.opts?.onBlockReply?.({ text: "streamed " });
      await input.opts?.onBlockReply?.({ text: "answer" });
      return undefined;
    });

    await handleBtwCommand(params, true);

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(readSideThread("agent:main:main")[0]?.answer).toBe("streamed answer");
  });

  it("brings the side thread into the main conversation with /main", async () => {
    recordSideThreadExchange("agent:main:main", {
      kind: "btw",
      question: "is it safe?",
      answer: "Yes, it only adds a column.",
    });
    const params = buildSessionParams("/main run the migration");

    const result = await handleMainCommand(params, true);

    expect(result).toEqual({ shouldContinue: true });
    const body = [
      "run the migration",
      "",
      "<side_chat_context>",
      "Earlier side chat between the owner and a side assistant, outside this conversation, oldest first. The owner brought it here as context for the message above.",
      "",
      "Owner: is it safe?",
      "Side assistant: Yes, it only adds a column.",
      "",
      "</side_chat_context>",
    ].join("\n");
    expect(params.ctx.BodyForAgent).toBe(body);
    expect(params.command.commandBodyNormalized).toBe(body);
    expect(readSideThread("agent:main:main")).toEqual([]);
  });

  it("continues /main with the text alone, and asks for text when bare", async () => {
    const params = buildSessionParams("/main run it");
    expect(await handleMainCommand(params, true)).toEqual({ shouldContinue: true });
    expect(params.ctx.BodyForAgent).toBe("run it");
    expect(await handleMainCommand(buildSessionParams("/main"), true)).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /main <message>" },
    });
  });
});
