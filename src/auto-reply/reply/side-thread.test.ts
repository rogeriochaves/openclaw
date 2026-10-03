import { beforeEach, describe, expect, it } from "vitest";
import {
  buildMainTextWithSideContext,
  buildSideThreadQuestion,
  clearSideThread,
  hasSideAnswerBanner,
  isQuotedSideAnswer,
  readSideThread,
  recordSideThreadExchange,
  resetSideThreadsForTest,
} from "./side-thread.js";

const KEY = "agent:main:main";
const T0 = 1_000_000;
const ANSWER = "The deploy finished at noon and the **dashboard** shows green checks everywhere.";

describe("side thread memory", () => {
  beforeEach(() => resetSideThreadsForTest());

  it("expires 60 minutes after the newest exchange", () => {
    recordSideThreadExchange(KEY, { kind: "btw", question: "q1", answer: "a1", ts: T0 });
    expect(readSideThread(KEY, T0 + 59 * 60_000)).toHaveLength(1);
    expect(readSideThread(KEY, T0 + 61 * 60_000)).toEqual([]);
  });

  it("keeps at most 8 exchanges and about 24 KB", () => {
    for (let i = 0; i < 10; i++) {
      recordSideThreadExchange(KEY, { kind: "btw", question: `q${i}`, answer: "a", ts: T0 + i });
    }
    expect(readSideThread(KEY, T0 + 10).map((entry) => entry.question)).toEqual([
      "q2",
      "q3",
      "q4",
      "q5",
      "q6",
      "q7",
      "q8",
      "q9",
    ]);
    recordSideThreadExchange(KEY, {
      kind: "btw",
      question: "big",
      answer: "x".repeat(20_000),
      ts: T0 + 11,
    });
    recordSideThreadExchange(KEY, {
      kind: "btw",
      question: "big2",
      answer: "y".repeat(20_000),
      ts: T0 + 12,
    });
    expect(readSideThread(KEY, T0 + 12).map((entry) => entry.question)).toEqual(["big2"]);
    clearSideThread(KEY);
    expect(readSideThread(KEY, T0 + 12)).toEqual([]);
  });

  it("matches a quoted side answer after channel formatting", () => {
    recordSideThreadExchange(KEY, { kind: "btw", question: "deploy?", answer: ANSWER });
    expect(isQuotedSideAnswer(`BTW\nQuestion: deploy?\n\n${ANSWER.replaceAll("**", "*")}`)).toBe(
      true,
    );
    expect(isQuotedSideAnswer("the dashboard shows green checks everywhere.")).toBe(true);
    expect(isQuotedSideAnswer("ok")).toBe(false);
    expect(isQuotedSideAnswer("Something the main agent said about the weather today.")).toBe(
      false,
    );
  });

  it("recognizes side-answer banners", () => {
    expect(hasSideAnswerBanner("BTW\nQuestion: why?\n\nbecause")).toBe(true);
    expect(hasSideAnswerBanner("Catch-up since your message at 09:00\n\n...")).toBe(true);
    expect(hasSideAnswerBanner("Done. I fixed it.")).toBe(false);
  });

  it("formats earlier side turns for follow-ups and for /main", () => {
    const exchanges = [
      { kind: "catchup" as const, question: "/catchup", answer: "All done", ts: T0 },
    ];
    expect(buildSideThreadQuestion([], "next?")).toBe("next?");
    expect(buildSideThreadQuestion(exchanges, "next?")).toContain(
      "<side_chat_history>\nOwner: /catchup\nSide assistant: All done\n",
    );
    expect(buildMainTextWithSideContext("do it", [])).toBe("do it");
    const main = buildMainTextWithSideContext("do it", exchanges);
    expect(main.startsWith("do it\n\n<side_chat_context>\n")).toBe(true);
    expect(main).toContain("Owner: /catchup\nSide assistant: All done");
    expect(main.endsWith("</side_chat_context>")).toBe(true);
  });
});
