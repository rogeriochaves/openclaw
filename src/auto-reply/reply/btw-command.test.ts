import { describe, expect, it } from "vitest";
import {
  extractBtwQuestion,
  extractCatchupArgs,
  extractMainText,
  isBtwRequestText,
} from "./btw-command.js";

describe("side-chat command parsing", () => {
  it("treats /btw, /side and /catchup as side requests, never /main", () => {
    expect(isBtwRequestText("/btw what changed?")).toBe(true);
    expect(isBtwRequestText("/side what changed?")).toBe(true);
    expect(isBtwRequestText("/catchup")).toBe(true);
    expect(isBtwRequestText("/main ship it")).toBe(false);
    expect(isBtwRequestText("/catchupnow")).toBe(false);
  });

  it("extracts command arguments; /main keeps every line", () => {
    expect(extractBtwQuestion("/btw first\nsecond")).toBe("first");
    expect(extractCatchupArgs("/catchup")).toBe("");
    expect(extractCatchupArgs("/btw x")).toBeNull();
    expect(extractMainText("/main ship it\nnow")).toBe("ship it\nnow");
    expect(extractMainText("/main")).toBe("");
  });
});
