import { describe, expect, it } from "vitest";
import { parseCatchupAnswer, renderCatchupText } from "./catchup-answer.js";
import {
  buildCatchupIndex,
  buildCatchupQuestion,
  catchupEntriesByRef,
  defaultCatchupTimeFormatter,
  type CatchupTranscriptRow,
} from "./catchup.js";

const T0 = Date.UTC(2026, 9, 3, 9, 0);
const formatTime = defaultCatchupTimeFormatter("UTC");
const longAsk = `Please fix the login bug and ship it. ${"x".repeat(300)}`;

function ownerRow(text: string, ts: number, messageId = "wamid-owner"): CatchupTranscriptRow {
  return {
    entryId: `entry-${messageId}`,
    message: {
      role: "user",
      content: text,
      timestamp: ts,
      __openclaw: {
        senderIsSelf: true,
        transport: { channel: "whatsapp", messageId, conversationRef: "conv-1" },
      },
    },
  };
}

const rows: CatchupTranscriptRow[] = [
  ownerRow("an older request", T0 - 60_000, "wamid-old"),
  { message: { role: "assistant", content: [{ type: "text", text: "old reply" }] } },
  ownerRow(longAsk, T0),
  {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Fixed the login bug in auth.ts and opened PR 12." }],
      timestamp: T0 + 5 * 60_000,
    },
  },
  {
    message: {
      role: "user",
      content: "nightly report done",
      timestamp: T0 + 10 * 60_000,
      provenance: { kind: "internal_system", sourceTool: "cron" },
    },
  },
  {
    message: {
      role: "user",
      content: "[Inter-session message] tests are green",
      timestamp: T0 + 12 * 60_000,
      provenance: { kind: "inter_session", sourceSessionKey: "agent:qa:main" },
    },
  },
];

describe("buildCatchupIndex", () => {
  it("indexes everything after the owner's last typed message", () => {
    const index = buildCatchupIndex(rows);
    expect(index.lastHuman).toMatchObject({
      ref: "m0",
      label: "you",
      ts: T0,
      channel: "whatsapp",
      channelMessageId: "wamid-owner",
      conversationRef: "conv-1",
    });
    expect(index.entries.map((entry) => [entry.ref, entry.label])).toEqual([
      ["m1", "agent"],
      ["m2", "cron"],
      ["m3", "message from agent:qa:main"],
    ]);
    expect(index.truncated).toBe(false);
  });

  it("keeps a /main side-chat block out of the owner's message text", () => {
    const index = buildCatchupIndex([
      ownerRow(
        "go ahead\n\n<side_chat_context>\nOwner: q\nSide assistant: a\n</side_chat_context>",
        T0,
      ),
    ]);
    expect(index.lastHuman?.text).toBe("go ahead");
  });

  it("falls back to the latest rows when no owner message is present", () => {
    const index = buildCatchupIndex(rows.slice(3), { truncated: true });
    expect(index.lastHuman).toBeUndefined();
    expect(index.entries).toHaveLength(3);
    expect(index.truncated).toBe(true);
  });
});

describe("buildCatchupQuestion", () => {
  it("quotes the first 200 chars of the owner's message and lists numbered refs", () => {
    const question = buildCatchupQuestion(buildCatchupIndex(rows), { formatTime });
    const preview = longAsk.slice(0, 200);
    expect(question).toContain(`Since I sent this message at 09:00: "${preview}..."`);
    expect(question).toContain("[m1] 09:05 agent (");
    expect(question).toContain("[m2] 09:10 cron (");
    expect(question).toContain("[m3] 09:12 message from agent:qa:main (");
    expect(question).toContain("tests are green");
    expect(question).not.toContain("old reply");
  });
});

describe("parseCatchupAnswer", () => {
  const index = buildCatchupIndex(rows);

  it("reads valid JSON and drops unknown refs", () => {
    const answer = parseCatchupAnswer(
      JSON.stringify({
        fullReport: "m1",
        asked: { text: "Fix the login bug", refs: ["m0"] },
        status: { state: "done", text: "Fixed, PR open", refs: ["m1", "m99"] },
        facts: [{ text: "PR 12", refs: ["[m1]"] }],
        waiting: [],
        blocked: [],
        other: [{ text: "Nightly report ran", refs: ["m2"] }],
      }),
      index,
    );
    expect(answer).toEqual({
      fullReport: "m1",
      asked: { text: "Fix the login bug", refs: ["m0"] },
      status: { text: "Fixed, PR open", refs: ["m1"], state: "done" },
      facts: [{ text: "PR 12", refs: ["m1"] }],
      waiting: [],
      blocked: [],
      other: [{ text: "Nightly report ran", refs: ["m2"] }],
    });
  });

  it("reads fenced JSON and strips em dashes", () => {
    const answer = parseCatchupAnswer(
      '```json\n{"facts":[{"text":"Fixed \u2014 shipped","refs":["m1"]}]}\n```',
      index,
    );
    expect(answer?.facts).toEqual([{ text: "Fixed, shipped", refs: ["m1"] }]);
  });

  it("returns undefined for garbage", () => {
    expect(parseCatchupAnswer("I could not do that.", index)).toBeUndefined();
    expect(parseCatchupAnswer('{"unrelated": true}', index)).toBeUndefined();
  });
});

describe("renderCatchupText", () => {
  const index = buildCatchupIndex(rows);

  it("renders sections with numbered refs and a refs list", () => {
    const answer = parseCatchupAnswer(
      JSON.stringify({
        fullReport: "m1",
        status: { state: "done", text: "Fixed", refs: ["m1"] },
        other: [{ text: "Nightly report ran", refs: ["m2"] }],
      }),
      index,
    );
    const text = renderCatchupText(answer, "", index, { formatTime });
    expect(text.split("\n")).toEqual([
      "Catch-up since your message at 09:00",
      "",
      "Full report: [1] 09:05",
      "",
      "**Where it stands**",
      "- Done. Fixed [1]",
      "",
      "**Also happened**",
      "- Nightly report ran [2]",
      "",
      "**Refs**",
      '[1] 09:05 agent: "Fixed the login bug in auth.ts and opened PR 12."',
      '[2] 09:10 cron: "nightly report done"',
    ]);
    expect(catchupEntriesByRef(index).size).toBe(4);
  });

  it("falls back to the raw text under the header", () => {
    expect(
      renderCatchupText(undefined, "All quiet \u2014 nothing new", index, { formatTime }),
    ).toBe("Catch-up since your message at 09:00\n\nAll quiet, nothing new");
  });
});
