// Workboard plugin module registers the Feed gateway methods: owner decisions on cards.
import { randomUUID } from "node:crypto";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import type { OpenClawPluginApi } from "../api.js";
import { redactClaimToken } from "./card-redaction.js";
import {
  buildFeedActionMessage,
  buildFeedCommentMessage,
  findFeedAction,
  resolveFeedNotifySession,
  resolveOwnerDraft,
  FEED_EMPTY_DRAFT_ERROR,
  resolveWorkboardFeedConfig,
  routeFeedMessage,
  selectFeedCards,
} from "./feed.js";
import { readId, registerWorkboardResultMethods } from "./gateway-helpers.js";
import type { WorkboardStore } from "./store.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;

function readIdempotencyKey(params: Record<string, unknown>, fallback: string): string {
  const value = params.idempotencyKey;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : fallback;
}

function readOptionalText(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string.`);
  }
  return value;
}

export function registerWorkboardFeedGatewayMethods(params: {
  api: OpenClawPluginApi;
  store: WorkboardStore;
  gateway?: Pick<OpenClawPluginApi["runtime"]["gateway"], "request">;
}) {
  const { api, store } = params;
  const config = resolveWorkboardFeedConfig(api.pluginConfig);
  const gateway = params.gateway ?? api.runtime.gateway;
  const requireCard = async (id: string): Promise<WorkboardCard> => {
    const card = await store.get(id);
    if (!card) {
      throw new Error(`card not found: ${id}`);
    }
    return card;
  };

  registerWorkboardResultMethods(api, [
    [
      "workboard.feed.list",
      READ_SCOPE,
      async () => ({
        cards: selectFeedCards(await store.list(), config).map(redactClaimToken),
        boards: config.boards,
        ...(config.ownerName ? { ownerName: config.ownerName } : {}),
      }),
    ],
    [
      "workboard.feed.update",
      WRITE_SCOPE,
      async ({ params: requestParams }) => {
        const id = readId(requestParams);
        const draft = requestParams.draft;
        if (draft !== null && typeof draft !== "string") {
          throw new Error("draft must be a string or null.");
        }
        if (typeof draft === "string" && !draft.trim()) {
          throw new Error(FEED_EMPTY_DRAFT_ERROR);
        }
        return {
          card: redactClaimToken(await store.setOwnerFeedDraft(id, draft)),
        };
      },
    ],
    [
      "workboard.feed.ack",
      WRITE_SCOPE,
      async ({ params: requestParams }) => ({
        card: redactClaimToken(
          await store.ackFeed(readId(requestParams), { acked: requestParams.acked !== false }),
        ),
      }),
    ],
    [
      "workboard.feed.act",
      WRITE_SCOPE,
      async ({ params: requestParams }) => {
        const card = await requireCard(readId(requestParams));
        const action = findFeedAction(card, requestParams.actionId);
        if (!action) {
          throw new Error(`card ${card.id} has no feed action ${String(requestParams.actionId)}.`);
        }
        const draft = resolveOwnerDraft(card, readOptionalText(requestParams, "draft"));
        const editedDraft = draft.edited;
        // Route before acking: a failed send leaves the card open for another try. The ack keeps
        // the time from before the send, so an agent reply that lands first still reopens the card.
        const touchedAt = Date.now();
        const routed = await routeFeedMessage({
          gateway,
          sessionKey: resolveFeedNotifySession(card),
          message: buildFeedActionMessage({ card, action, config, editedDraft }),
          idempotencyKey: readIdempotencyKey(requestParams, `workboard-feed:${randomUUID()}`),
        });
        const acked = await store.ackFeed(card.id, {
          acked: true,
          at: touchedAt,
          actionId: action.id,
          ...(draft.changed && editedDraft !== undefined ? { draft: editedDraft } : {}),
        });
        return { card: redactClaimToken(acked), routed };
      },
    ],
    [
      "workboard.feed.comment",
      WRITE_SCOPE,
      async ({ params: requestParams }) => {
        const card = await requireCard(readId(requestParams));
        const body = readOptionalText(requestParams, "body")?.trim();
        if (!body) {
          throw new Error("comment body is required.");
        }
        const draft = resolveOwnerDraft(card, readOptionalText(requestParams, "draft"));
        const touchedAt = Date.now();
        const routed = await routeFeedMessage({
          gateway,
          sessionKey: resolveFeedNotifySession(card),
          message: buildFeedCommentMessage({ card, body, config, editedDraft: draft.edited }),
          idempotencyKey: readIdempotencyKey(requestParams, `workboard-feed:${randomUUID()}`),
        });
        if (draft.changed && draft.edited !== undefined) {
          await store.setOwnerFeedDraft(card.id, draft.edited);
        }
        const commented = await store.addComment(card.id, {
          body,
          author: { kind: "owner" },
          ackFeed: true,
          createdAt: touchedAt,
        });
        return { card: redactClaimToken(commented), routed };
      },
    ],
  ]);
}
