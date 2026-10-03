// Parses side-chat commands (/btw, /catchup) and the /main hand-off command.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeCommandBody, type CommandNormalizeOptions } from "../commands-registry.js";

// Side-chat commands answer beside the main run and never enter session history.
const SIDE_CHAT_COMMAND_RE = /^\/(?:btw|catchup)(?::|\s|$)/i;

/** True for side-chat commands (/btw and /catchup) that run beside the main conversation. */
export function isBtwRequestText(text?: string, options?: CommandNormalizeOptions): boolean {
  if (!text) {
    return false;
  }
  const normalized = normalizeCommandBody(text, options).trim();
  return SIDE_CHAT_COMMAND_RE.test(normalized);
}

function extractCommandArgs(
  command: string,
  text?: string,
  options?: CommandNormalizeOptions,
): string | null {
  if (!text) {
    return null;
  }
  const normalized = normalizeCommandBody(text, options).trim();
  const match = normalized.match(new RegExp(`^\\/${command}(?:\\s+([\\s\\S]*))?$`, "i"));
  if (!match) {
    return null;
  }
  return normalizeOptionalString(match[1]) ?? "";
}

export function extractBtwQuestion(
  text?: string,
  options?: CommandNormalizeOptions,
): string | null {
  return extractCommandArgs("btw", text, options);
}

/** Returns the text after /catchup ("" when bare), or null when the text is not /catchup. */
export function extractCatchupArgs(
  text?: string,
  options?: CommandNormalizeOptions,
): string | null {
  return extractCommandArgs("catchup", text, options);
}

/** Returns the text after /main ("" when bare), or null when the text is not /main. */
export function extractMainText(text?: string, options?: CommandNormalizeOptions): string | null {
  return extractCommandArgs("main", text, options);
}
