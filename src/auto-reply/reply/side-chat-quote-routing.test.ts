import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCommandTurnContext } from "../command-turn-context.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { routeSideChatQuoteReply } from "./side-chat-quote-routing.js";
import { recordSideThreadExchange, resetSideThreadsForTest } from "./side-thread.js";

const ANSWER = "The migration is safe to run; it only adds a nullable column to the users table.";
const cfg = {} as OpenClawConfig;

function inbound(overrides: Record<string, unknown>) {
  return finalizeInboundContext({
    Body: "and how long will it take?",
    RawBody: "and how long will it take?",
    CommandBody: "and how long will it take?",
    Provider: "whatsapp",
    Surface: "whatsapp",
    ChatType: "direct",
    SessionKey: "agent:main:main",
    ReplyToBody: `BTW\nQuestion: is it safe?\n\n${ANSWER}`,
    SenderIsSelf: true,
    ...overrides,
  });
}

describe("routeSideChatQuoteReply", () => {
  beforeEach(() => {
    resetSideThreadsForTest();
    recordSideThreadExchange("agent:main:main", {
      kind: "btw",
      question: "is it safe?",
      answer: ANSWER,
    });
  });

  it("turns an owner's quote-reply to a side answer into a /btw command turn", () => {
    const ctx = inbound({});
    expect(routeSideChatQuoteReply(ctx, cfg)).toBe(true);
    expect(ctx.BodyForCommands).toBe("/btw and how long will it take?");
    expect(ctx.CommandAuthorized).toBe(true);
    expect(resolveCommandTurnContext(ctx)).toMatchObject({
      kind: "text-slash",
      authorized: true,
      commandName: "btw",
    });
  });

  it("folds a multi-line follow-up into one /btw line", () => {
    const text = "first part\nsecond part";
    const ctx = inbound({ Body: text, RawBody: text, CommandBody: text });
    expect(routeSideChatQuoteReply(ctx, cfg)).toBe(true);
    expect(ctx.BodyForCommands).toBe("/btw first part second part");
  });

  it("leaves slash commands such as /main to normal command routing", () => {
    const ctx = inbound({
      Body: "/main do it",
      RawBody: "/main do it",
      CommandBody: "/main do it",
    });
    expect(routeSideChatQuoteReply(ctx, cfg)).toBe(false);
  });

  it("leaves quotes of other messages in the main conversation", () => {
    const ctx = inbound({ ReplyToBody: "A normal answer from the main agent about the release." });
    expect(routeSideChatQuoteReply(ctx, cfg)).toBe(false);
    expect(ctx.BodyForCommands).toBe("and how long will it take?");
  });

  it("ignores a third party in a group quoting a side answer", () => {
    const ctx = inbound({ SenderIsSelf: undefined, ChatType: "group", SenderId: "+15550002" });
    expect(routeSideChatQuoteReply(ctx, cfg)).toBe(false);
  });
});
