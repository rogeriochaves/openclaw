// Decides whether a stored user-role transcript row is a message the owner typed
// on a chat surface, from facts recorded at ingress.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { readMessageClientSources } from "../chat/message-client-source.js";
import { normalizeInputProvenance } from "./input-provenance.js";

/** "unknown" means the row predates the ingress facts this check relies on. */
export type HumanInputVerdict = "human" | "not-human" | "unknown";

// Clients where a person types into a composer. CLI and backend clients are
// scripts or other agents even when they hold owner scope.
const HUMAN_CHAT_CLIENT_IDS = new Set<string>([
  GATEWAY_CLIENT_IDS.CONTROL_UI,
  GATEWAY_CLIENT_IDS.WEBCHAT_UI,
  GATEWAY_CLIENT_IDS.WEBCHAT,
  GATEWAY_CLIENT_IDS.TUI,
  GATEWAY_CLIENT_IDS.MACOS_APP,
  GATEWAY_CLIENT_IDS.LINUX_APP,
  GATEWAY_CLIENT_IDS.IOS_APP,
  GATEWAY_CLIENT_IDS.WATCHOS_APP,
  GATEWAY_CLIENT_IDS.ANDROID_APP,
]);

// Transport channels that are not a person's chat app.
const NON_HUMAN_TRANSPORT_CHANNELS = new Set(["internal", "webchat", "heartbeat", "cron"]);

// Machine-authored prompts that older rows carry without any ingress facts.
const MACHINE_PROMPT_PREFIXES = [
  "[inter-session message]",
  "[openclaw ",
  "[cron:",
  "[subagent",
  "[system",
  "[queued",
  "[restart",
  "system:",
  "<task-notification",
  "<system-reminder",
  "read heartbeat.md",
];

function readUserText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      const record = asOptionalRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("\n");
}

function looksMachineAuthored(text: string): boolean {
  const head = text.trimStart().slice(0, 64).toLowerCase();
  return MACHINE_PROMPT_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/**
 * Classifies a user-role row. Owner chat turns are recognized only from ingress
 * facts: no routed provenance, an owner (or the linked account itself) as the
 * sender, and either a human chat client or a real channel message id. Rows with
 * no ingress metadata at all are "unknown" so callers can fall back to text.
 */
export function classifyUserMessageAuthor(message: unknown): HumanInputVerdict {
  const record = asOptionalRecord(message);
  if (!record || record.role !== "user") {
    return "not-human";
  }
  if (record.display === false) {
    return "not-human";
  }
  const provenance = normalizeInputProvenance(record.provenance);
  if (provenance && provenance.kind !== "external_user") {
    return "not-human";
  }
  const metadata = asOptionalRecord(record["__openclaw"]);
  if (!metadata) {
    return provenance ? "not-human" : "unknown";
  }
  const senderIsOwner = metadata.senderIsOwner === true;
  const senderIsSelf = metadata.senderIsSelf === true;
  if (readMessageClientSources(record).some((source) => HUMAN_CHAT_CLIENT_IDS.has(source.id))) {
    return senderIsOwner ? "human" : "not-human";
  }
  const transport = asOptionalRecord(metadata.transport);
  const channel = normalizeOptionalString(transport?.channel)?.toLowerCase();
  const channelMessageId = normalizeOptionalString(transport?.messageId);
  if (channel && channelMessageId && !NON_HUMAN_TRANSPORT_CHANNELS.has(channel)) {
    if (senderIsOwner || senderIsSelf) {
      return "human";
    }
    // Rows from before senderIsSelf was recorded: channel turns from the linked
    // account itself were stored without any sender, unlike third-party senders.
    return metadata.senderId === undefined && metadata.senderIdentity === undefined
      ? "unknown"
      : "not-human";
  }
  // Imported Claude CLI rows with no local twin carry no ingress facts.
  if (metadata.importedFrom !== undefined && metadata.senderIsOwner === undefined) {
    return "unknown";
  }
  return "not-human";
}

/** True for owner chat turns, with a text check only for rows older than the ingress facts. */
export function isOwnerTypedUserMessage(message: unknown): boolean {
  const verdict = classifyUserMessageAuthor(message);
  if (verdict !== "unknown") {
    return verdict === "human";
  }
  const record = asOptionalRecord(message);
  const text = record ? readUserText(record).trim() : "";
  return text.length > 0 && !looksMachineAuthored(text);
}
