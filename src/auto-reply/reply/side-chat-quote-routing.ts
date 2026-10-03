// Routes a channel quote-reply to one of our side answers into the side chat.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import { createCommandTurnContext, resolveCommandBody } from "../command-turn-context.js";
import type { FinalizedMsgContext } from "../templating.js";
import { applyCommandTextToContext } from "./command-context-rewrite.js";
import { hasSideAnswerBanner, isQuotedSideAnswer, readQuotedText } from "./side-thread.js";

/** Cheap pre-check so ordinary turns never load command authorization. */
export function mayBeSideChatQuoteReply(ctx: FinalizedMsgContext): boolean {
  if (ctx.CommandInterpretationSuppressed === true || ctx.CommandTurn?.kind !== "normal") {
    return false;
  }
  const body = normalizeOptionalString(resolveCommandBody(ctx));
  return Boolean(body && !body.startsWith("/") && readQuotedText(ctx));
}

/**
 * Turns a plain quote-reply to a side answer into `/btw <body>` before command
 * routing, ordering, and active-run admission read the turn, so the follow-up
 * runs beside the main run exactly like a typed /btw. Only the owner (or the
 * linked account itself, or an authorized sender in a direct chat) can do this;
 * every other message stays a normal main-conversation turn.
 */
export function routeSideChatQuoteReply(ctx: FinalizedMsgContext, cfg: OpenClawConfig): boolean {
  if (!mayBeSideChatQuoteReply(ctx)) {
    return false;
  }
  const quoted = readQuotedText(ctx);
  if (!quoted || !(isQuotedSideAnswer(quoted) || hasSideAnswerBanner(quoted))) {
    return false;
  }
  if (ctx.SenderIsSelf !== true) {
    // Plain messages skip channel command checks, so authorize here as if it were a command.
    const auth = resolveCommandAuthorization({ ctx, cfg, commandAuthorized: true });
    const direct = normalizeChatType(ctx.ChatType) === "direct";
    if (!auth.senderIsOwner && !(direct && auth.isAuthorizedSender)) {
      return false;
    }
  }
  const body = normalizeOptionalString(resolveCommandBody(ctx));
  if (!body) {
    return false;
  }
  // /btw reads only its first line, so fold a multi-line follow-up into one.
  const text = `/btw ${body.replace(/\s*\n\s*/gu, " ")}`;
  applyCommandTextToContext(ctx, text);
  ctx.CommandSource = "text";
  ctx.CommandAuthorized = true;
  ctx.CommandTurn = createCommandTurnContext("text", {
    authorized: true,
    commandName: "btw",
    body: text,
  });
  return true;
}
