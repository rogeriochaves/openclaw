import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const CHAT_SELECTION_SNIPPET_MAX_CHARS = 300;

function collapseChatSelectionSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return truncateUtf16Safe(collapsed, CHAT_SELECTION_SNIPPET_MAX_CHARS);
}

export function buildCompanionQuestionPrefill(selection: string): string | null {
  const snippet = collapseChatSelectionSnippet(selection);
  return snippet ? `Regarding "${snippet}": ` : null;
}

export function extractCompanionCommandQuestion(message: string): string {
  return message
    .trim()
    .replace(/^\/(?:btw|side)(?::\s*|\s+|$)/i, "")
    .trim();
}

const CATCHUP_COMMAND_RE = /^\/catchup(?::|\s|$)/i;
const MAIN_COMMAND_RE = /^\/main(?::\s*|\s+|$)/i;

export function isCatchupCommand(message: string): boolean {
  return CATCHUP_COMMAND_RE.test(message.trim());
}

/** Text after `/main`, or null when the message is not a `/main` command. */
/** True for `/catchup refresh`, which runs a new catch-up even when nothing is new. */
export function isCatchupRefreshCommand(message: string): boolean {
  return /^\/catchup(?::\s*|\s+)refresh\s*$/i.test(message.trim());
}

export function extractMainCommandText(message: string): string | null {
  const trimmed = message.trim();
  return MAIN_COMMAND_RE.test(trimmed) ? trimmed.replace(MAIN_COMMAND_RE, "").trim() : null;
}
