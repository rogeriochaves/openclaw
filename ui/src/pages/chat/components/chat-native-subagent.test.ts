/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import type { ApplicationGatewaySnapshot } from "../../../app/gateway.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { NATIVE_SUBAGENT_REFRESH_MS } from "./chat-native-subagent.ts";
import { renderToolCard } from "./chat-tool-cards.ts";

const hosts: HTMLElement[] = [];

afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.remove();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const agentCard: ToolCard = {
  id: "agent-card",
  callId: "toolu_spawn",
  name: "Agent",
  args: { description: "Scan logs", prompt: "Scan the logs" },
};

function gatewayContext(request: ReturnType<typeof vi.fn>) {
  const snapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello: { features: { methods: [] }, auth: { role: "operator", scopes: [] } },
  } as unknown as ApplicationGatewaySnapshot;
  return {
    gateway: { snapshot, connectionRevision: 1, subscribe: () => () => undefined },
  } as unknown as ApplicationContext;
}

async function drawExpandedAgentCard(request: ReturnType<typeof vi.fn>, runActive: boolean) {
  const host = document.createElement("div");
  hosts.push(host);
  document.body.append(host);
  render(
    renderToolCard(agentCard, {
      messageKey: "m1",
      sessionKey: "agent:main:main",
      runActive,
      expanded: true,
      onToggleExpanded: () => undefined,
    }),
    host,
  );
  const element = host.querySelector("openclaw-chat-native-subagent") as HTMLElement & {
    context?: ApplicationContext;
    updateComplete: Promise<boolean>;
  };
  element.context = gatewayContext(request);
  await element.updateComplete;
  return element;
}

async function settle(element: { updateComplete: Promise<boolean> }, ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  await element.updateComplete;
}

describe("native subagent activity", () => {
  it("shows the subagent's calls under its Agent card and follows it until done", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        description: "Scan logs",
        agentType: "general-purpose",
        background: true,
        status: "running",
        cursor: 100,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "toolcall", id: "toolu_grep", name: "Grep", arguments: { pattern: "ERROR" } },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: "done",
        background: true,
        cursor: 200,
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_grep", name: "Grep", content: "2 hits" },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "Found **2** errors." }] },
        ],
      });
    const element = await drawExpandedAgentCard(request, true);
    await settle(element);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenLastCalledWith("chat.nativeSubagent.get", {
      sessionKey: "agent:main:main",
      toolCallId: "toolu_spawn",
    });
    const header = element.querySelector(".chat-native-subagent__header")?.textContent ?? "";
    expect(header).toContain("Subagent");
    expect(header).toContain("Scan logs");
    expect(header).toContain("Running");
    expect(header).toContain("Background");
    expect(element.querySelectorAll(".chat-native-subagent__items .chat-tool-row")).toHaveLength(1);

    await settle(element, NATIVE_SUBAGENT_REFRESH_MS);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(
      "chat.nativeSubagent.get",
      expect.objectContaining({ cursor: 100 }),
    );
    expect(element.querySelector(".chat-native-subagent__header")?.textContent).toContain("Done");
    // The later result merges into its call instead of adding a second row.
    expect(element.querySelectorAll(".chat-native-subagent__items .chat-tool-row")).toHaveLength(1);
    expect(element.querySelector(".chat-native-subagent__text strong")?.textContent).toBe("2");

    await settle(element, NATIVE_SUBAGENT_REFRESH_MS * 5);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps paging a finished subagent until every written row is read", async () => {
    vi.useFakeTimers();
    let cursor = 0;
    const request = vi.fn().mockImplementation(async () => {
      cursor += 1;
      return { ok: true, status: "done", cursor, more: cursor < 10, messages: [] };
    });
    const element = await drawExpandedAgentCard(request, false);
    await settle(element);
    expect(request).toHaveBeenCalledTimes(8);

    await settle(element, NATIVE_SUBAGENT_REFRESH_MS);
    expect(request).toHaveBeenCalledTimes(10);
    await settle(element, NATIVE_SUBAGENT_REFRESH_MS * 5);
    expect(request).toHaveBeenCalledTimes(10);
  });

  it("renders nothing for a finished turn without a subagent transcript", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue({ ok: false, unavailableReason: "not_found" });
    const element = await drawExpandedAgentCard(request, false);
    await settle(element);
    await settle(element, NATIVE_SUBAGENT_REFRESH_MS * 5);

    expect(request).toHaveBeenCalledTimes(1);
    expect(element.querySelector(".chat-native-subagent")).toBeNull();
  });
});
