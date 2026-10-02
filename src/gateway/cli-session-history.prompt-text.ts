// Compare-only text views for matching imported CLI prompts to local rows.
import { stripCliSessionDriftNote } from "../agents/cli-session.js";
import { readInterSessionPromptEnvelope } from "../sessions/input-provenance.js";

// Some local inter-session rows store the routed text without the envelope the
// CLI received, so both sides compare the text after it.
export function stripInterSessionPromptEnvelope(text: string): string {
  return text.slice(readInterSessionPromptEnvelope(text)?.length ?? 0);
}

// Queued system events reach the CLI as a block of `System:` lines above the
// prompt, separated by a blank line. The local row stores only the prompt.
function stripLeadingSystemEventLines(text: string): string {
  const lines = text.replace(/^\n+/u, "").split("\n");
  let end = 0;
  while (end < lines.length && (lines[end] === "System:" || lines[end]?.startsWith("System: "))) {
    end += 1;
  }
  if (end === 0 || (end < lines.length && lines[end] !== "")) {
    return text;
  }
  return lines.slice(end).join("\n");
}

// Compare-only view of an imported prompt without the context OpenClaw added
// around the user's text before handing it to the CLI.
export function stripCliPromptDecorations(text: string): string {
  return stripLeadingSystemEventLines(stripCliSessionDriftNote(text));
}
