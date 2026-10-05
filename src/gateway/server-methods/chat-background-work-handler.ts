import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { validateChatBackgroundWorkGetParams } from "../../../packages/gateway-protocol/src/index.js";
import {
  CLI_BACKGROUND_STALE_AFTER_MS,
  collectClaudeCliBackgroundWork,
  resolveClaudeCliSessionIds,
} from "../cli-background-work.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { hiddenSessionNotFound } from "../session-sharing-policy.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const chatBackgroundWorkHandlers: GatewayRequestHandlers = {
  "chat.backgroundWork.get": ({ params, respond, context, client }) => {
    if (
      !assertValidParams(
        params,
        validateChatBackgroundWorkGetParams,
        "chat.backgroundWork.get",
        respond,
      )
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedSessionAgentId(
      cfg,
      params.sessionKey,
      normalizeOptionalString(params.agentId),
    );
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const session = loadGatewaySessionEntryReadOnly(
      params.sessionKey,
      { agentId: requestedAgent.agentId },
      cfg,
    );
    const { entry, canonicalKey } = session;
    const entryFilter = createSessionListEntryFilter({
      client,
      cfg: context.getCommittedRuntimeConfig?.() ?? session.cfg,
    });
    if (!entry || entryFilter?.(canonicalKey, entry) === false) {
      respond(false, undefined, hiddenSessionNotFound(canonicalKey));
      return;
    }
    const cliSessionIds = resolveClaudeCliSessionIds(entry, canonicalKey);
    if (cliSessionIds.length === 0) {
      respond(true, {
        available: false,
        items: [],
        active: 0,
        stale: 0,
        staleAfterMs: CLI_BACKGROUND_STALE_AFTER_MS,
        sampledAt: Date.now(),
      });
      return;
    }
    respond(true, { available: true, ...collectClaudeCliBackgroundWork({ cliSessionIds }) });
  },
};
