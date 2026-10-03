import { describe, expect, it } from "vitest";
import {
  buildCompanionQuestionPrefill,
  extractCompanionCommandQuestion,
  extractMainCommandText,
  isCatchupCommand,
} from "./companion-question.ts";

describe("companion selection questions", () => {
  it("builds a rail composer prefill without changing the main composer", () => {
    expect(buildCompanionQuestionPrefill("cron scan job")).toBe('Regarding "cron scan job": ');
  });

  it("extracts both Control UI command aliases", () => {
    expect(extractCompanionCommandQuestion("/btw what changed?")).toBe("what changed?");
    expect(extractCompanionCommandQuestion("/side: what changed?")).toBe("what changed?");
    expect(extractCompanionCommandQuestion("/btw")).toBe("");
  });

  it("recognizes /catchup and extracts /main text", () => {
    expect(isCatchupCommand(" /catchup ")).toBe(true);
    expect(isCatchupCommand("/catchupnow")).toBe(false);
    expect(extractMainCommandText("/main: ship it")).toBe("ship it");
    expect(extractMainCommandText("/main")).toBe("");
    expect(extractMainCommandText("/mainline")).toBeNull();
    expect(extractMainCommandText("ship it")).toBeNull();
  });
});
