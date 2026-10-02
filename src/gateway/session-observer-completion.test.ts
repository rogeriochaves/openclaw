import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHarness,
  flushObserver,
  modelMessage,
  resetSessionObserverEventSequence,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

afterEach(() => {
  vi.useRealTimers();
  resetSessionObserverEventSequence();
});

describe("session observer completion", () => {
  it("publishes a digest from a utility model that answers after 15s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // CLI-backed utility models (for example claude-cli Haiku) take 9-16s per call.
    const completeModel = vi.fn(
      (params: { timeoutMs?: number; abortSignal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          params.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
          setTimeout(
            () =>
              resolve(
                modelMessage({
                  headline: "Reviewing the implementation",
                  assessment: "The work is progressing steadily.",
                  health: "on-track",
                }),
              ),
            15_000,
          );
        }),
    );
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(completeModel).toHaveBeenCalledOnce();
    expect(completeModel.mock.calls[0]?.[0].timeoutMs).toBe(30_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await flushObserver();

    expect(completeModel.mock.calls[0]?.[0].abortSignal?.aborted).toBe(false);
    expect(harness.broadcastToConnIds).toHaveBeenCalledWith(
      "session.observer",
      expect.objectContaining({ headline: "Reviewing the implementation", health: "on-track" }),
      expect.any(Set),
      expect.anything(),
    );
    harness.observer.dispose();
  });
});
