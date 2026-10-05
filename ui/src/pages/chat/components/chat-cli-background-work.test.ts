/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatBackgroundWorkGetResult,
  ChatBackgroundWorkItem,
} from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import type { ApplicationGatewaySnapshot } from "../../../app/gateway.ts";
import { visibleCliBackgroundItems } from "./chat-cli-background-work.ts";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const MINUTE = 60_000;
const elements: HTMLElement[] = [];

afterEach(() => {
  for (const element of elements.splice(0)) {
    element.remove();
  }
  vi.useRealTimers();
});

const subagent: ChatBackgroundWorkItem = {
  id: "subagent:a1",
  kind: "subagent",
  status: "running",
  title: "Build the polish loop",
  agentType: "general-purpose",
  activity: "Bash: bash loop.sh",
  activityAt: NOW - MINUTE,
  startedAt: NOW - 30 * MINUTE,
  lastActivityAt: NOW - MINUTE,
  stale: false,
};

const stuckCommand: ChatBackgroundWorkItem = {
  id: "command:300:1",
  kind: "command",
  status: "running",
  title: "python3 pipeline.py",
  activity: "claude (claude-sonnet-5): Rewrite this draft",
  activityAt: NOW - 25 * MINUTE,
  startedAt: NOW - 40 * MINUTE,
  lastActivityAt: NOW - 25 * MINUTE,
  stale: true,
  pid: 300,
  cpuPercent: 0,
  processCount: 3,
  nested: [
    {
      pid: 302,
      label: "claude (claude-sonnet-5): Rewrite this draft",
      startedAt: NOW - 25 * MINUTE,
    },
  ],
};

function result(items: ChatBackgroundWorkItem[]): ChatBackgroundWorkGetResult {
  return {
    available: true,
    processScan: true,
    processAlive: true,
    items,
    active: items.filter((item) => item.status === "running").length,
    stale: items.filter((item) => item.stale).length,
    staleAfterMs: 10 * MINUTE,
    sampledAt: NOW,
  };
}

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

async function draw(request: ReturnType<typeof vi.fn>, runWorking = false) {
  await import("./chat-cli-background-work.ts");
  const element = document.createElement("openclaw-chat-cli-background-work") as HTMLElement & {
    context?: ApplicationContext;
    sessionKey: string;
    runWorking: boolean;
    updateComplete: Promise<boolean>;
  };
  element.sessionKey = "agent:content:main";
  element.runWorking = runWorking;
  element.context = gatewayContext(request);
  elements.push(element);
  document.body.append(element);
  // First render queues the read; let it settle and render its result.
  for (let index = 0; index < 4; index += 1) {
    await element.updateComplete;
    await Promise.resolve();
  }
  return element;
}

describe("visibleCliBackgroundItems", () => {
  it("hides a running turn's fresh commands but keeps long ones and subagents", () => {
    const fresh = { ...stuckCommand, id: "command:2", startedAt: NOW - 5_000 };
    expect(
      visibleCliBackgroundItems([subagent, stuckCommand, fresh], { runWorking: true, now: NOW }),
    ).toEqual([subagent, stuckCommand]);
    expect(
      visibleCliBackgroundItems([subagent, fresh], { runWorking: false, now: NOW }),
    ).toHaveLength(2);
  });
});

describe("openclaw-chat-cli-background-work", () => {
  it("shows a running count, flags quiet work and opens into the list", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const request = vi.fn().mockResolvedValue(result([subagent, stuckCommand]));

    const element = await draw(request);

    expect(request).toHaveBeenCalledWith("chat.backgroundWork.get", {
      sessionKey: "agent:content:main",
    });
    const bar = element.querySelector<HTMLButtonElement>(".chat-cli-work__bar")!;
    expect(element.querySelector(".chat-cli-work")?.getAttribute("data-tone")).toBe("stale");
    expect(bar.textContent).toContain("2 background tasks running");
    expect(bar.textContent).toContain("1 quiet for 10+ min");
    expect(element.querySelector(".chat-cli-work__list")).toBeNull();

    bar.click();
    await element.updateComplete;

    const items = [...element.querySelectorAll(".chat-cli-work__item")];
    expect(items.map((item) => item.querySelector(".chat-cli-work__title")?.textContent)).toEqual([
      "Build the polish loop",
      "python3 pipeline.py",
    ]);
    expect(items[0]?.textContent).toContain("Bash: bash loop.sh");
    expect(items[1]?.getAttribute("data-stale")).toBe("true");
    expect(items[1]?.textContent).toContain("Rewrite this draft");
    expect(items[1]?.textContent).toContain("It may be stuck.");
  });

  it("stays empty for sessions without claude-cli background work", async () => {
    const request = vi.fn().mockResolvedValue({ ...result([]), available: false });

    const element = await draw(request);

    expect(request).toHaveBeenCalledTimes(1);
    expect(element.querySelector(".chat-cli-work")).toBeNull();
  });
});
