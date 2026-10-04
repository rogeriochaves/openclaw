import { expect, it } from "vitest";
import { listActiveCliSessionIds, markCliSessionActive } from "./cli-active-sessions.js";

it("tracks the CLI sessions of running turns per OpenClaw session", () => {
  const scope = { backendId: "claude-cli", sessionKey: "agent:main:main" };
  const first = markCliSessionActive({ ...scope, cliSessionId: "s1" });
  const second = markCliSessionActive({ ...scope, cliSessionId: "s1" });
  const other = markCliSessionActive({
    ...scope,
    sessionKey: "agent:main:other",
    cliSessionId: "s2",
  });
  expect(listActiveCliSessionIds(scope)).toEqual(["s1"]);

  first();
  first();
  expect(listActiveCliSessionIds(scope)).toEqual(["s1"]);
  second();
  expect(listActiveCliSessionIds(scope)).toEqual([]);
  expect(listActiveCliSessionIds({ ...scope, sessionKey: "agent:main:other" })).toEqual(["s2"]);
  other();
  expect(listActiveCliSessionIds({ ...scope, backendId: "codex-cli" })).toEqual([]);
});
