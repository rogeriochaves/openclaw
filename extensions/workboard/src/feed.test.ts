// Workboard tests cover the Feed view: metadata, owner decisions, and routing to agents.
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { mergeFeedPatch } from "./feed-normalize.js";
import { resolveFeedNotifySession, selectFeedCards } from "./feed.js";
import { registerWorkboardFeedGatewayMethods } from "./gateway-feed.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

type Handler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];

function setup(pluginConfig: unknown = { feed: { boards: ["owner"], ownerName: "Sam" } }) {
  const store = createWorkboardSqliteTestStore();
  const methods = new Map<string, Handler>();
  const gateway = { request: vi.fn(async () => ({ runId: "run-1" })) };
  const api = createTestPluginApi({
    pluginConfig: pluginConfig as Record<string, unknown>,
    registerGatewayMethod: (name, handler) => {
      methods.set(name, handler);
    },
  });
  registerWorkboardFeedGatewayMethods({ api, store, gateway });
  const call = async (method: string, params: Record<string, unknown>) => {
    const respond = vi.fn();
    await methods.get(method)!({ params, respond } as never);
    const [ok, payload, error] = respond.mock.calls[0] ?? [];
    if (!ok) {
      throw new Error(error?.message ?? "request failed");
    }
    return payload as Record<string, unknown>;
  };
  return { store, gateway, call };
}

function toolsFor(
  store: ReturnType<typeof createWorkboardSqliteTestStore>,
  agentId: string,
  boards: string[] = ["owner"],
) {
  const tools = createWorkboardTools({
    store,
    context: { agentId, sessionKey: `agent:${agentId}:main` } as never,
    feedConfig: { boards },
  });
  return (name: string) => tools.find((tool) => tool.name === name)!;
}

const emailFeed = {
  tag: "EMAIL · DRAFT",
  summary: "She asked yesterday; you said Friday.",
  draftHeader: "To: Dana\nRe: Q3 proposal",
  draft: "Hi Dana,\n\nHere is the proposal.",
  actions: [
    { label: "Send", message: "Send the Q3 proposal email now.", style: "primary" },
    { label: "Edit draft", message: "Rework the draft." },
  ],
};

describe("workboard feed", () => {
  it("validates feed fields and merges patches, with empty values clearing a field", () => {
    const feed = mergeFeedPatch(undefined, emailFeed);
    expect(feed?.actions?.map((action) => action.id)).toEqual(["send", "edit-draft"]);
    const next = mergeFeedPatch(
      { ...feed, ackedAt: 5, ackedAction: "send" },
      {
        summary: "",
        links: [{ label: "Open draft", url: "https://mail.example.com/d/1" }],
        reopen: true,
      },
    );
    expect(next?.summary).toBeUndefined();
    expect(next?.ackedAt).toBeUndefined();
    expect(next?.draft).toBe(emailFeed.draft);
    expect(() => mergeFeedPatch(undefined, { draft: "x".repeat(6001) })).toThrow(/6000/);
    expect(() =>
      mergeFeedPatch(undefined, { links: [{ label: "x", url: "file:///etc" }] }),
    ).toThrow(/http/);
  });

  it("stores feed metadata and the creator's notify session from workboard_create", async () => {
    const { store } = setup();
    const tool = toolsFor(store, "content");
    const result = await tool("workboard_create").execute("call-1", {
      title: "LinkedIn: approve the launch post",
      boardId: "owner",
      feed: { tag: "LINKEDIN · DRAFT", draft: "We shipped it." },
    });
    const card = (result.details as { card: { id: string } }).card;
    const stored = await store.get(card.id);
    expect(stored?.metadata?.feed).toEqual({
      tag: "LINKEDIN · DRAFT",
      draft: "We shipped it.",
      notify: "agent:content:main",
    });
    // A plain card on a Feed board still remembers who to tell.
    const plain = await tool("workboard_create").execute("call-2", {
      title: "Decide the pricing tier",
      boardId: "owner",
    });
    const plainId = (plain.details as { card: { id: string } }).card.id;
    expect(resolveFeedNotifySession((await store.get(plainId))!)).toBe("agent:content:main");
    // Cards elsewhere without feed fields stay out of the Feed and carry no feed record.
    const other = await store.create({ title: "Unrelated", boardId: "ops" });
    expect(other.metadata?.feed).toBeUndefined();
    const selected = selectFeedCards(await store.list(), { boards: ["owner"] });
    expect(selected.map((entry) => entry.title).toSorted()).toEqual([
      "Decide the pricing tier",
      "LinkedIn: approve the launch post",
    ]);
  });

  it("routes an action click with the edited draft and acks without finishing the card", async () => {
    const { store, gateway, call } = setup();
    const card = await store.create({
      title: "Dana is waiting on the Q3 proposal",
      boardId: "owner",
      metadata: { feed: { ...emailFeed, notify: "agent:email:main" } },
    });
    const result = await call("workboard.feed.act", {
      id: card.id,
      actionId: "send",
      draft: "Hi Dana,\n\nHere is the proposal. Pricing is on slide 6.",
      idempotencyKey: "click-1",
    });
    expect(gateway.request).toHaveBeenCalledTimes(1);
    const [method, params, options] = gateway.request.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
      unknown,
    ];
    expect(method).toBe("sessions.send");
    expect(options).toEqual({ scopes: ["operator.write"] });
    expect(params.key).toBe("agent:email:main");
    expect(params.idempotencyKey).toBe("click-1");
    expect(params.message).toContain(
      `[Feed] Sam clicked "Send" on card ${card.id} "Dana is waiting on the Q3 proposal".`,
    );
    expect(params.message).toContain("Send the Q3 proposal email now.");
    expect(params.message).toContain("> Here is the proposal. Pricing is on slide 6.");
    expect(params.message).toContain(`workboard_comment with id "${card.id}"`);
    expect(result.routed).toEqual({ sessionKey: "agent:email:main", runId: "run-1" });
    const stored = await store.get(card.id);
    expect(stored?.status).toBe("todo");
    expect(stored?.metadata?.feed).toMatchObject({
      ackedAction: "send",
      draft: "Hi Dana,\n\nHere is the proposal. Pricing is on slide 6.",
    });
    expect(stored?.metadata?.feed?.ackedAt).toEqual(expect.any(Number));
  });

  it("keeps the card open when routing fails", async () => {
    const { store, gateway, call } = setup();
    gateway.request.mockRejectedValueOnce(new Error("session not found"));
    const card = await store.create({ title: "Decide", metadata: { feed: emailFeed } });
    await expect(call("workboard.feed.act", { id: card.id, actionId: "send" })).rejects.toThrow(
      "session not found",
    );
    expect((await store.get(card.id))?.metadata?.feed?.ackedAt).toBeUndefined();
    // No notify and no assignee falls back to the main agent session.
    expect(resolveFeedNotifySession(card)).toBe("agent:main:main");
  });

  it("stores an owner comment, acks, routes it, and an agent reply reopens the card", async () => {
    const { store, gateway, call } = setup();
    const card = await store.create({
      title: "Pick the conference",
      agentId: "events",
      boardId: "owner",
    });
    await call("workboard.feed.comment", { id: card.id, body: "Only if the booth is under 5k." });
    const [, params] = gateway.request.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(params.key).toBe("agent:events:main");
    expect(params.message).toContain(
      `[Feed] Sam commented on card ${card.id} "Pick the conference":`,
    );
    expect(params.message).toContain("> Only if the booth is under 5k.");
    const acked = await store.get(card.id);
    const ackedAt = acked?.metadata?.feed?.ackedAt;
    expect(ackedAt).toEqual(expect.any(Number));
    expect(acked?.metadata?.comments?.[0]).toMatchObject({
      body: "Only if the booth is under 5k.",
      author: { kind: "owner" },
    });

    const tool = toolsFor(store, "events");
    await tool("workboard_comment").execute("call-3", {
      id: card.id,
      body: "Booth is 4.2k. Book it?",
    });
    const replied = await store.get(card.id);
    const reply = replied?.metadata?.comments?.at(-1);
    expect(reply).toMatchObject({ author: { kind: "agent", id: "events" } });
    // Reopening is derived: an agent comment newer than the ack puts it back in front.
    expect(reply!.createdAt).toBeGreaterThanOrEqual(ackedAt!);
  });

  it("acks and undoes, and agents can reopen through workboard_feed", async () => {
    const { store, call } = setup();
    const card = await store.create({ title: "FYI: invoice paid", metadata: { feed: emailFeed } });
    await call("workboard.feed.ack", { id: card.id });
    expect((await store.get(card.id))?.metadata?.feed?.ackedAt).toEqual(expect.any(Number));
    await call("workboard.feed.ack", { id: card.id, acked: false });
    expect((await store.get(card.id))?.metadata?.feed?.ackedAt).toBeUndefined();

    await call("workboard.feed.ack", { id: card.id });
    const tool = toolsFor(store, "email");
    await tool("workboard_feed").execute("call-4", {
      id: card.id,
      summary: "New draft after your note.",
      reopen: true,
    });
    const reopened = await store.get(card.id);
    expect(reopened?.metadata?.feed).toMatchObject({
      summary: "New draft after your note.",
      notify: "agent:email:main",
    });
    expect(reopened?.metadata?.feed?.ackedAt).toBeUndefined();

    await call("workboard.feed.update", { id: card.id, draft: "Shorter draft." });
    expect((await store.get(card.id))?.metadata?.feed?.draft).toBe("Shorter draft.");
    const listed = await call("workboard.feed.list", {});
    expect(listed).toMatchObject({ boards: ["owner"], ownerName: "Sam" });
    expect((listed.cards as unknown[]).length).toBe(1);
  });
});
