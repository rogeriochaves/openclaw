import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "side-chat catch-up" });
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const base = 1_800_000_000_000;

const history = [
  {
    role: "user",
    content: "Fix the flaky login test and tell me when it is green.",
    timestamp: base,
    __openclaw: { id: "catchup-asked", seq: 1 },
  },
  ...Array.from({ length: 6 }, (_, index) => ({
    role: "assistant",
    content: `Progress note ${index + 1}: still checking the login flow.`,
    timestamp: base + 60_000 * (index + 1),
    __openclaw: { id: `catchup-progress-${index}`, seq: index + 2 },
  })),
  {
    role: "assistant",
    content:
      "Report: the login test was flaky because of a shared cookie jar. Fixed it, ran the suite 20 times, all green.",
    timestamp: base + 600_000,
    __openclaw: { id: "catchup-report", seq: 20 },
  },
];

const catchup = {
  ownerMessageFound: true,
  sinceTs: base,
  fullReport: "m7",
  asked: { text: "Fix the flaky login test and report when green", refs: ["m0"] },
  status: { text: "Fixed and verified with 20 green runs", refs: ["m7"], state: "done" },
  facts: [
    { text: "Cause was a shared cookie jar between tests", refs: ["m7"] },
    { text: "Early progress notes found nothing", refs: ["m1", "m2"] },
  ],
  waiting: [{ text: "Review and merge the fix", refs: ["m7"] }],
  blocked: [],
  other: [{ text: "A cron checked the backups", refs: [] }],
  refs: [
    { ref: "m0", entryId: "catchup-asked", ts: base, label: "you", excerpt: "Fix the flaky login" },
    {
      ref: "m1",
      entryId: "catchup-progress-0",
      ts: base + 60_000,
      label: "agent",
      excerpt: "Progress note 1",
    },
    {
      ref: "m2",
      entryId: "catchup-progress-1",
      ts: base + 120_000,
      label: "agent",
      excerpt: "Progress note 2",
    },
    {
      ref: "m7",
      entryId: "catchup-report",
      ts: base + 600_000,
      label: "agent",
      excerpt: "Report: the login test was flaky",
    },
  ],
};

suite.define(() => {
  for (const width of [1440, 390]) {
    it(`runs /catchup in the Side chat and links refs to the main chat at ${width}px`, async () => {
      await suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
        const sessionKey = `agent:main:side-chat-catchup-${width}`;
        const gateway = await installMockGateway(page, {
          sessionKey,
          historyMessages: history,
          methodResponses: {
            "sessions.companion.state": { exchanges: [] },
            "sessions.companion.ask": {
              question: "/catchup",
              answer: "Catch-up since your message",
              ts: base + 700_000,
              catchup,
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.getByText("Progress note 6", { exact: false }).waitFor();
        const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
        await composer.fill("/catchup");
        await composer.press("Enter");

        const side = page.locator("openclaw-chat-session-rail");
        const view = side.locator('[data-testid="side-chat-catchup"]');
        await view.waitFor();
        expect((await gateway.getRequests("sessions.companion.ask")).map((r) => r.params)).toEqual([
          expect.objectContaining({ sessionKey, mode: "catchup" }),
        ]);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(
          (await view.locator(".chat-session-rail__catchup-title").allTextContents()).map((title) =>
            title.trim(),
          ),
        ).toEqual([
          "What you asked",
          "Where it stands",
          "Key facts",
          "Waiting on you",
          "Also happened",
        ]);
        const thread = await side.locator(".chat-session-rail__thread").evaluate((node) => ({
          width: node.clientWidth,
          contentWidth: node.scrollWidth,
        }));
        expect(thread.contentWidth).toBeLessThanOrEqual(thread.width + 1);
        if (captureProof) {
          const output = createControlUiE2eArtifactDir(`side-chat-catchup-${width}`);
          await writeFile(
            path.join(output, `catchup-${width}.png`),
            await page.screenshot({ animations: "disabled" }),
          );
        }

        // Ref 1 points at an older progress note; the main chat scrolls to it and flashes it.
        await view
          .locator('[data-section="facts"] .chat-session-rail__catchup-ref')
          .filter({ hasText: "1" })
          .first()
          .click();
        const target = page.locator('.chat-bubble[data-entry-id="catchup-progress-0"]');
        await expect
          .poll(() =>
            target.evaluate((node) => node.classList.contains("chat-bubble--reply-target")),
          )
          .toBe(true);
        await expect.poll(() => target.isVisible()).toBe(true);

        await view.locator(".chat-session-rail__catchup-report").click();
        const report = page.locator('.chat-bubble[data-entry-id="catchup-report"]');
        await expect
          .poll(() =>
            report.evaluate((node) => node.classList.contains("chat-bubble--reply-target")),
          )
          .toBe(true);
      });
    });
  }

  it("sends a Side chat follow-up to the main chat with the thread attached", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const sessionKey = "agent:main:side-chat-to-main";
      const gateway = await installMockGateway(page, {
        sessionKey,
        historyMessages: history,
        methodResponses: {
          "sessions.companion.state": {
            exchanges: [{ question: "Is it green?", answer: "Yes, 20 green runs.", ts: base }],
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await openChatSidePanelType(page, "Side chat");
      const side = page.locator("openclaw-chat-session-rail");
      await side.getByText("Yes, 20 green runs.", { exact: true }).waitFor();
      await side.getByRole("textbox").fill("Open the PR for this fix.");
      await side.getByRole("button", { name: "Send to main chat" }).click();

      await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(1);
      const params = (await gateway.getRequests("chat.send"))[0]?.params as {
        message?: string;
        attachments?: Array<{ fileName?: string; content?: string }>;
      };
      expect(params.message).toBe("Open the PR for this fix.");
      expect(params.attachments?.map((attachment) => attachment.fileName)).toEqual([
        "side-chat.txt",
      ]);
      expect(
        Buffer.from(params.attachments?.[0]?.content ?? "", "base64").toString("utf8"),
      ).toContain("Owner: Is it green?\nSide assistant: Yes, 20 green runs.");
      expect(await gateway.getRequests("sessions.companion.ask")).toHaveLength(0);
      await expect.poll(() => side.getByRole("textbox").inputValue()).toBe("");
      await side.getByText("Yes, 20 green runs.", { exact: true }).waitFor();
    });
  });
});
