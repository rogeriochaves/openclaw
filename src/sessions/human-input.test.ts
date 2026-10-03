import { describe, expect, it } from "vitest";
import { classifyUserMessageAuthor, isOwnerTypedUserMessage } from "./human-input.js";

const controlUiOwnerRow = {
  role: "user",
  content: "deploy the fix",
  __openclaw: {
    senderIsOwner: true,
    transport: { clients: [{ id: "openclaw-control-ui", mode: "webchat" }] },
  },
};

const agentCliRow = {
  role: "user",
  content: "run the nightly report",
  __openclaw: { senderIsOwner: true },
};

const whatsappSelfRow = {
  role: "user",
  content: [{ type: "text", text: "what is the status?" }],
  __openclaw: {
    senderIsOwner: false,
    senderIsSelf: true,
    transport: { channel: "whatsapp", messageId: "wamid-1" },
  },
};

const whatsappLegacySelfRow = {
  role: "user",
  content: "legacy self message",
  __openclaw: {
    senderIsOwner: false,
    transport: { channel: "whatsapp", messageId: "wamid-2" },
  },
};

const whatsappThirdPartyRow = {
  role: "user",
  content: "hi from a friend",
  __openclaw: {
    senderIsOwner: false,
    senderId: "+15550002",
    transport: { channel: "whatsapp", messageId: "wamid-3" },
  },
};

describe("classifyUserMessageAuthor", () => {
  it("treats an owner typing in the Control UI as human", () => {
    expect(classifyUserMessageAuthor(controlUiOwnerRow)).toBe("human");
  });

  it("treats `openclaw agent` rows without a chat client as not human", () => {
    expect(classifyUserMessageAuthor(agentCliRow)).toBe("not-human");
    expect(isOwnerTypedUserMessage(agentCliRow)).toBe(false);
  });

  it("treats a WhatsApp message from the linked account as human", () => {
    expect(classifyUserMessageAuthor(whatsappSelfRow)).toBe("human");
  });

  it("falls back to the text check for legacy WhatsApp self rows", () => {
    expect(classifyUserMessageAuthor(whatsappLegacySelfRow)).toBe("unknown");
    expect(isOwnerTypedUserMessage(whatsappLegacySelfRow)).toBe(true);
    expect(
      isOwnerTypedUserMessage({ ...whatsappLegacySelfRow, content: "[cron:daily] run it" }),
    ).toBe(false);
  });

  it("treats a third-party WhatsApp sender as not human", () => {
    expect(classifyUserMessageAuthor(whatsappThirdPartyRow)).toBe("not-human");
  });

  it.each([
    ["cron", { kind: "internal_system", sourceTool: "cron" }],
    ["heartbeat", { kind: "internal_system", sourceTool: "heartbeat" }],
    ["inter_session", { kind: "inter_session", sourceSessionKey: "agent:other:main" }],
    ["subagent", { kind: "inter_session", sourceTool: "subagent_announce" }],
  ])("treats %s rows as not human", (_label, provenance) => {
    const row = { ...controlUiOwnerRow, provenance };
    expect(classifyUserMessageAuthor(row)).toBe("not-human");
    expect(isOwnerTypedUserMessage({ role: "user", content: "hello", provenance })).toBe(false);
  });

  it("treats hidden rows as not human", () => {
    expect(classifyUserMessageAuthor({ ...controlUiOwnerRow, display: false })).toBe("not-human");
  });

  it("uses the text check only for rows without ingress metadata", () => {
    expect(classifyUserMessageAuthor({ role: "user", content: "plain" })).toBe("unknown");
    expect(isOwnerTypedUserMessage({ role: "user", content: "plain" })).toBe(true);
    expect(
      isOwnerTypedUserMessage({ role: "user", content: "[Inter-session message] relay" }),
    ).toBe(false);
  });
});
