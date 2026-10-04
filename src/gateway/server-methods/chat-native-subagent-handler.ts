import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateChatNativeSubagentGetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listActiveCliSessionIds } from "../../agents/cli-active-sessions.js";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import { projectChatDisplayMessages } from "../chat-display-projection.js";
import {
  readClaudeCliNativeSubagent,
  resolveClaudeCliNativeSubagent,
} from "../cli-native-subagent.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { hiddenSessionNotFound } from "../session-sharing-policy.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

// Subagent rows are activity, not the main reply: keep each text field short.
const DEFAULT_NATIVE_SUBAGENT_MAX_CHARS = 4_000;

export const chatNativeSubagentHandlers: GatewayRequestHandlers = {
  "chat.nativeSubagent.get": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(
        params,
        validateChatNativeSubagentGetParams,
        "chat.nativeSubagent.get",
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
    const cliSessionId = getCliSessionBinding(entry, "claude-cli")?.sessionId;
    // A turn that starts a new Claude session binds it only when the turn ends.
    const activeCliSessionIds = listActiveCliSessionIds({
      backendId: "claude-cli",
      sessionKey: canonicalKey,
    });
    const location = await resolveClaudeCliNativeSubagent({
      cliSessionIds: [...(cliSessionId ? [cliSessionId] : []), ...activeCliSessionIds],
      toolCallId: params.toolCallId,
    });
    const read = location
      ? await readClaudeCliNativeSubagent({ location, cursor: params.cursor })
      : undefined;
    // The binding can move while the files are read; never answer for a different session.
    const current = loadGatewaySessionEntryReadOnly(params.sessionKey, {
      agentId: requestedAgent.agentId,
      clone: false,
      projection: "list",
    });
    if (getCliSessionBinding(current.entry, "claude-cli")?.sessionId !== cliSessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "session changed while reading subagent activity", {
          retryable: true,
        }),
      );
      return;
    }
    if (!read) {
      respond(true, { ok: false, unavailableReason: "not_found" });
      return;
    }
    respond(true, {
      ok: true,
      ...read,
      messages: projectChatDisplayMessages(read.messages, {
        maxChars: params.maxChars ?? DEFAULT_NATIVE_SUBAGENT_MAX_CHARS,
      }),
    });
  },
};
