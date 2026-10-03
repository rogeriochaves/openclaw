/** Handles side-chat commands (/btw, /catchup) and /main against the active session context. */
import { randomUUID } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { runBtwSideQuestion } from "../../agents/btw.js";
import {
  CATCHUP_SIDE_QUESTION,
  prepareCatchupSideQuestion,
} from "../../agents/catchup-side-question.js";
import type { CatchupIndex } from "../../agents/catchup.js";
import { toolPolicyRestrictsTools } from "../../agents/tool-policy.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import type { SessionEntry } from "../../config/sessions.js";
import { conversationIdentityFromMsgContext } from "../../config/sessions/conversation-identity.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import {
  isTrustedMessageActionTurnIngress,
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import type { ImageContent } from "../../llm/types.js";
import type { ReplyPayload } from "../reply-payload.js";
import { extractBtwQuestion, extractCatchupArgs, extractMainText } from "./btw-command.js";
import { applyCommandTextToParams } from "./command-context-rewrite.js";
import { commandReply, defineAuthorizedTextCommand } from "./command-gates.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";
import { resolveCurrentTurnImages } from "./current-turn-images.js";
import {
  buildMainTextWithSideContext,
  buildSideThreadQuestion,
  clearSideThread,
  hasSideAnswerBanner,
  keepCatchup,
  readKeptCatchup,
  readQuotedText,
  readSideThread,
  recordSideThreadExchange,
  type SideThreadExchange,
} from "./side-thread.js";

const BTW_USAGE = "Usage: /btw [side question]";
const CATCHUP_USAGE = "Usage: /catchup [refresh]";
const MAIN_USAGE = "Usage: /main <message>";

type SideReplyBtw = NonNullable<ReplyPayload["btw"]>;
type SideCommandLabel = "/btw" | "/catchup";

type SideQuestionRun = {
  sessionEntry: SessionEntry & { sessionId: string };
  /** Prompt text sent to the side model. */
  question: string;
  replyBtw: SideReplyBtw;
  images?: ImageContent[];
  contextMessages?: unknown[];
  /** False when the answer must arrive whole (structured output). */
  streamBlocks: boolean;
};

/** Shared preconditions: an active session and a tool policy the side path can honor. */
function prepareSideCommand(
  params: HandleCommandsParams,
  label: SideCommandLabel,
  replyBtw: SideReplyBtw,
): { sessionEntry: SessionEntry & { sessionId: string } } | CommandHandlerResult {
  const sessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  if (!sessionEntry?.sessionId) {
    return commandReply(`⚠️ ${label} requires an active session with existing context.`);
  }
  if (toolPolicyRestrictsTools(params.ctx.ConversationToolPolicy)) {
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ ${label} cannot enforce this conversation's tool policy. Ask in the main conversation or switch this session to the embedded runtime.`,
        btw: replyBtw,
        isError: true,
      },
    };
  }
  return { sessionEntry: sessionEntry as SessionEntry & { sessionId: string } };
}

function sideCommandFailure(
  label: SideCommandLabel,
  replyBtw: SideReplyBtw,
  error: unknown,
): CommandHandlerResult {
  const message = error instanceof Error ? error.message.trim() : "";
  return {
    shouldContinue: false,
    reply: {
      text: `⚠️ ${label} failed${message ? `: ${message}` : "."}`,
      btw: replyBtw,
      isError: true,
    },
  };
}

/** Runs one side question with the turn's routing, sender, and capability facts. */
async function runSideQuestionCommand(
  params: HandleCommandsParams,
  run: SideQuestionRun,
): Promise<ReplyPayload | undefined> {
  const sessionAgentId = params.agentId;
  const agentDir = params.agentDir ?? resolveAgentDir(params.cfg, sessionAgentId);
  const targetSessionEntry = run.sessionEntry;
  await params.typing?.startTypingLoop();
  const messageTo =
    params.ctx.OriginatingTo?.trim() || params.command.to || params.command.channelId;
  const nativeChannelId =
    params.ctx.NativeChannelId?.trim() || params.ctx.ChatId?.trim() || undefined;
  const currentChannelId = nativeChannelId ?? messageTo;
  const chatType = normalizeChatType(params.ctx.ChatType);
  const groupId = resolveGroupSessionKey(params.ctx)?.id ?? targetSessionEntry.groupId;
  const runId = params.opts?.runId ?? `btw-${randomUUID()}`;
  const authorityRunId = `btw-${randomUUID()}`;
  const currentChannelProvider = normalizeAnyChannelId(params.ctx.Provider);
  const capabilitySessionKey = params.ctx.RuntimePolicySessionKey ?? params.sessionKey;
  const messageActionTurnCapability =
    isTrustedMessageActionTurnIngress(params.ctx.Provider) &&
    sessionAgentId &&
    capabilitySessionKey &&
    currentChannelProvider &&
    currentChannelId
      ? mintMessageActionTurnCapability({
          agentId: sessionAgentId,
          runId: authorityRunId,
          sessionKey: capabilitySessionKey,
          sessionId: targetSessionEntry.sessionId,
          requesterAccountId: params.ctx.AccountId,
          requesterSenderId: params.ctx.SenderId ?? params.command.senderId,
          requesterSenderName: params.ctx.SenderName,
          requesterSenderUsername: params.ctx.SenderUsername,
          requesterSenderE164: params.ctx.SenderE164,
          toolContext: {
            currentChannelId,
            currentChatType: chatType,
            currentMessagingTarget: messageTo,
            currentChannelProvider,
            currentMessageId: params.ctx.MessageSidFull ?? params.ctx.MessageSid,
          },
        })
      : undefined;
  try {
    return await runBtwSideQuestion({
      cfg: params.cfg,
      agentId: sessionAgentId,
      agentDir,
      provider: params.provider,
      model: params.model,
      question: run.question,
      ...(run.images ? { images: run.images } : {}),
      ...(run.contextMessages ? { contextMessages: run.contextMessages } : {}),
      replyBtw: run.replyBtw,
      sessionEntry: targetSessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      allowGatewaySubagentBinding: true,
      ...(params.ctx.RuntimePolicySessionKey
        ? { sandboxSessionKey: params.ctx.RuntimePolicySessionKey }
        : {}),
      storePath: params.storePath,
      // Side questions are quick, so do not inherit slower session-level
      // think/reasoning settings from the main run.
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
      // Without chunking the runner returns the whole answer instead of streaming blocks.
      ...(run.streamBlocks
        ? {
            blockReplyChunking: params.blockReplyChunking,
            resolvedBlockStreamingBreak: params.resolvedBlockStreamingBreak,
          }
        : {}),
      opts: { ...params.opts, runId },
      isNewSession: false,
      ...(params.command.channel ? { messageChannel: params.command.channel } : {}),
      ...(params.command.channel ? { messageProvider: params.command.channel } : {}),
      ...(chatType ? { chatType } : {}),
      ...(params.ctx.AccountId ? { agentAccountId: params.ctx.AccountId } : {}),
      ...(messageTo ? { messageTo } : {}),
      ...(params.ctx.MessageThreadId !== undefined
        ? { messageThreadId: params.ctx.MessageThreadId }
        : params.ctx.TransportThreadId !== undefined
          ? { messageThreadId: params.ctx.TransportThreadId }
          : {}),
      ...(nativeChannelId ? { chatId: nativeChannelId } : {}),
      ...(messageActionTurnCapability ? { messageActionTurnCapability } : {}),
      ...(groupId ? { groupId } : {}),
      ...(params.ctx.GroupChannel || params.ctx.GroupSubject || targetSessionEntry.groupChannel
        ? {
            groupChannel:
              params.ctx.GroupChannel ?? params.ctx.GroupSubject ?? targetSessionEntry.groupChannel,
          }
        : {}),
      ...(params.ctx.GroupSpace || targetSessionEntry.space
        ? { groupSpace: params.ctx.GroupSpace ?? targetSessionEntry.space }
        : {}),
      ...(params.ctx.MemberRoleIds ? { memberRoleIds: params.ctx.MemberRoleIds } : {}),
      ...(targetSessionEntry.parentSessionKey
        ? { spawnedBy: targetSessionEntry.parentSessionKey }
        : {}),
      ...(params.ctx.SenderId || params.command.senderId
        ? { senderId: params.ctx.SenderId ?? params.command.senderId }
        : {}),
      ...(params.ctx.SenderName ? { senderName: params.ctx.SenderName } : {}),
      ...(params.ctx.SenderUsername ? { senderUsername: params.ctx.SenderUsername } : {}),
      ...(params.ctx.SenderE164 ? { senderE164: params.ctx.SenderE164 } : {}),
      senderIsOwner: params.command.senderIsOwner,
      ...(currentChannelId ? { currentChannelId } : {}),
      authorityRunId,
    });
  } finally {
    revokeMessageActionTurnCapability(messageActionTurnCapability);
  }
}

/**
 * Earlier side-chat turns for a /btw follow-up. A quote of an older side answer
 * (for example from before a restart) seeds the thread with the quoted text.
 */
function resolveBtwThread(params: HandleCommandsParams): SideThreadExchange[] {
  const exchanges = readSideThread(params.sessionKey);
  if (exchanges.length > 0) {
    return exchanges;
  }
  const quoted = readQuotedText(params.ctx);
  return quoted && hasSideAnswerBanner(quoted)
    ? [{ kind: "btw", question: "(earlier side question)", answer: quoted, ts: Date.now() }]
    : [];
}

/** Command handler for /btw side questions; continues a live side thread when there is one. */
export const handleBtwCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/btw", match: (body) => extractBtwQuestion(body) },
  async (params, question) => {
    if (!question) {
      return commandReply(BTW_USAGE);
    }
    const replyBtw: SideReplyBtw = { question };
    const prepared = prepareSideCommand(params, "/btw", replyBtw);
    if (!("sessionEntry" in prepared)) {
      return prepared;
    }
    try {
      const { images } = await resolveCurrentTurnImages({
        ctx: params.ctx,
        cfg: params.cfg,
        images: params.opts?.images,
        imageOrder: params.opts?.imageOrder,
        extractedFileImages: params.opts?.extractedFileImages,
      });
      // Streamed blocks are already delivered, so collect them to remember the answer.
      const streamed: string[] = [];
      const onBlockReply = params.opts?.onBlockReply;
      const sideParams: HandleCommandsParams = onBlockReply
        ? {
            ...params,
            opts: {
              ...params.opts,
              onBlockReply: (payload, context) => {
                if (payload.text) {
                  streamed.push(payload.text);
                }
                return onBlockReply(payload, context);
              },
            },
          }
        : params;
      const reply = await runSideQuestionCommand(sideParams, {
        sessionEntry: prepared.sessionEntry,
        question: buildSideThreadQuestion(resolveBtwThread(params), question),
        replyBtw,
        images,
        streamBlocks: true,
      });
      const answer = reply?.text ?? streamed.join("");
      if (answer.trim()) {
        recordSideThreadExchange(params.sessionKey, { kind: "btw", question, answer });
      }
      return {
        shouldContinue: false,
        reply: reply ? { ...reply, btw: replyBtw } : reply,
      };
    } catch (error) {
      return sideCommandFailure("/btw", replyBtw, error);
    }
  },
);

/**
 * Quote target for the catch-up answer: the owner's last message, only when it
 * came from the same channel conversation, so tapping the quote jumps to where
 * the catch-up window starts.
 */
function resolveCatchupReplyTarget(
  params: HandleCommandsParams,
  index: CatchupIndex,
): string | undefined {
  const lastHuman = index.lastHuman;
  const channel = normalizeLowercaseStringOrEmpty(params.command.channel);
  if (
    !lastHuman?.channelMessageId ||
    !channel ||
    normalizeLowercaseStringOrEmpty(lastHuman.channel) !== channel
  ) {
    return undefined;
  }
  const currentConversationRef = conversationIdentityFromMsgContext({
    ctx: params.ctx,
  })?.conversationRef;
  if (
    lastHuman.conversationRef &&
    currentConversationRef &&
    lastHuman.conversationRef !== currentConversationRef
  ) {
    return undefined;
  }
  return lastHuman.channelMessageId;
}

/** Remembers a catch-up for side-chat follow-ups unless it is already the newest exchange. */
function recordCatchupExchange(sessionKey: string, text: string): void {
  const newest = readSideThread(sessionKey).at(-1);
  if (newest?.kind === "catchup" && newest.answer === text.trim()) {
    return;
  }
  recordSideThreadExchange(sessionKey, {
    kind: "catchup",
    question: CATCHUP_SIDE_QUESTION,
    answer: text,
  });
}

/**
 * Command handler for /catchup: a side answer covering everything since the
 * owner's last message. A repeat with nothing new in the session returns the
 * kept answer without a model run; `/catchup refresh` always runs again.
 */
export const handleCatchupCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/catchup", match: (body) => extractCatchupArgs(body) },
  async (params, args) => {
    const refresh = normalizeLowercaseStringOrEmpty(args) === "refresh";
    if (args && !refresh) {
      return commandReply(CATCHUP_USAGE);
    }
    const replyBtw: SideReplyBtw = { question: CATCHUP_SIDE_QUESTION, kind: "catchup" };
    const prepared = prepareSideCommand(params, "/catchup", replyBtw);
    if (!("sessionEntry" in prepared)) {
      return prepared;
    }
    try {
      const catchup = prepareCatchupSideQuestion({
        cfg: params.cfg,
        agentId: params.agentId,
        sessionId: prepared.sessionEntry.sessionId,
        sessionKey: params.sessionKey,
        ...(params.storePath ? { storePath: params.storePath } : {}),
      });
      const replyToId = resolveCatchupReplyTarget(params, catchup.index);
      const kept = refresh ? undefined : readKeptCatchup(params.sessionKey, catchup.coverageKey);
      if (kept) {
        recordCatchupExchange(params.sessionKey, kept);
        return {
          shouldContinue: false,
          reply: {
            text: kept,
            btw: replyBtw,
            ...(replyToId ? { replyToId, replyToTag: true } : {}),
          },
        };
      }
      const reply = await runSideQuestionCommand(params, {
        sessionEntry: prepared.sessionEntry,
        question: catchup.question,
        replyBtw,
        // The catch-up rows are inside the question; earlier rows are background only.
        contextMessages: catchup.contextMessages,
        streamBlocks: false,
      });
      const raw = reply?.text?.trim();
      if (!raw) {
        throw new Error("No catch-up answer generated.");
      }
      const text = catchup.render(raw);
      keepCatchup(params.sessionKey, catchup.coverageKey, text);
      recordCatchupExchange(params.sessionKey, text);
      return {
        shouldContinue: false,
        reply: {
          text,
          btw: replyBtw,
          ...(replyToId ? { replyToId, replyToTag: true } : {}),
        },
      };
    } catch (error) {
      return sideCommandFailure("/catchup", replyBtw, error);
    }
  },
);

/**
 * Command handler for /main: brings the side chat into the main conversation.
 * The rewritten body is the persisted user turn, so later turns keep the context.
 */
export const handleMainCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/main", match: (body) => extractMainText(body) },
  (params, text) => {
    if (!text) {
      return commandReply(MAIN_USAGE);
    }
    const exchanges = readSideThread(params.sessionKey);
    applyCommandTextToParams(params, buildMainTextWithSideContext(text, exchanges));
    clearSideThread(params.sessionKey);
    return { shouldContinue: true };
  },
);
