// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createUpdateRunFixture as updateRunFixture } from "../test-helpers/update-run.ts";
import { flushMicrotasks } from "./overlays-access.test-support.ts";
import type { ApplicationUpdateOverlayHooks } from "./overlays-updates.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { updateRunHarness } from "./update-run.test-support.ts";

const FAILURE = updateRunFixture({
  status: "failed",
  phase: "finished",
  reason: "build-failed",
  finishedAtMs: 3_000,
  after: { version: "2.0.0" },
  updatedAtMs: 3_000,
  steps: [{ step: "build", status: "failed", detail: "Disk is full" }],
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("update failure triage admission", () => {
  // Live fork patch: a recorded failure never opens a diagnostic turn by
  // itself. Upstream openclaw#157359 moves diagnosis behind an explicit click.
  it("does not start a diagnosis for a failed run on load or after an update", async () => {
    const harness = updateRunHarness(async (method) => {
      if (method === "update.run") {
        return { runId: FAILURE.runId };
      }
      return method === "update.runs.get" ? { run: FAILURE } : { lastRun: FAILURE };
    });
    const onUpdateFailure = vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>();
    const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    try {
      await flushMicrotasks();
      await overlays.runUpdate();
      expect(overlays.snapshot.updateRun).toEqual(FAILURE);
      expect(overlays.snapshot.updateRunning).toBe(false);
      expect(onUpdateFailure).not.toHaveBeenCalled();
    } finally {
      overlays.dispose();
    }
  });
});
