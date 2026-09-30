import { describe, expect, it, vi } from "vitest";
import {
  createSessionObserverCompletion,
  SESSION_OBSERVER_MODEL_TIMEOUT_MS,
} from "./session-observer-completion.js";
import type { SessionObserverState } from "./session-observer-model.js";

describe("session observer completion", () => {
  it("gives CLI-backed utility models 30s before aborting", async () => {
    const timers: Array<{ callback: () => void; delay?: number }> = [];
    const setTimeoutFn = ((callback: () => void, delay?: number) => {
      timers.push({ callback, delay });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const completeModel = vi.fn(
      async (params: { timeoutMs?: number; abortSignal?: AbortSignal }) => {
        expect(params.abortSignal?.aborted).toBe(false);
        return { text: "not json" };
      },
    );
    const complete = createSessionObserverCompletion({
      getConfig: () => ({}),
      prepareModel: async () => ({}) as never,
      completeModel: completeModel as never,
      setTimeoutFn,
      clearTimeoutFn: () => {},
      isCurrent: () => true,
    });
    const state = {
      agentId: "main",
      utilityModelRef: "anthropic/claude-haiku-4-5",
    } as SessionObserverState;

    await expect(complete(state, [])).rejects.toThrow("invalid JSON twice");

    expect(SESSION_OBSERVER_MODEL_TIMEOUT_MS).toBe(30_000);
    expect(timers.map((timer) => timer.delay)).toEqual([30_000]);
    expect(completeModel).toHaveBeenCalledTimes(2);
    expect(completeModel.mock.calls[0]?.[0].timeoutMs).toBe(30_000);
  });
});
