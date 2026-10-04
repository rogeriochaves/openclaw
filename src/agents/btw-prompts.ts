import type { Message } from "../llm/types.js";

export function buildBtwSystemPrompt(): string {
  return [
    "You are answering an ephemeral /btw side question about the current conversation.",
    "Use the conversation only as background context.",
    "Answer only the side question in the last user message.",
    "Do not continue, resume, or complete any unfinished task from the conversation.",
    "Do not emit tool calls, pseudo-tool calls, shell commands, file writes, patches, or code unless the side question explicitly asks for them.",
    "Do not say you will continue the main task after answering.",
    "If the question can be answered briefly, answer briefly.",
  ].join("\n");
}

export function buildBtwQuestionPrompt(question: string, inFlightPrompt?: string): string {
  const lines = [
    "Answer this side question only.",
    "Ignore any unfinished task in the conversation while answering it.",
  ];
  const trimmedPrompt = inFlightPrompt?.trim();
  if (trimmedPrompt) {
    lines.push(
      "",
      "Current in-flight main task request for background context only:",
      "<in_flight_main_task>",
      trimmedPrompt,
      "</in_flight_main_task>",
      "Do not continue or complete that task while answering the side question.",
    );
  }
  lines.push("", "<btw_side_question>", question.trim(), "</btw_side_question>");
  return lines.join("\n");
}

function collectBtwMessageText(content: Message["content"]): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "image") {
        return "[Image content omitted from CLI side-question context.]";
      }
      return [];
    })
    .join("\n")
    .trim();
}

export function buildBtwCliPrompt(params: {
  messages: Message[];
  question: string;
  imageCount: number;
  inFlightPrompt?: string;
}): string {
  const lines = [
    "Use this sanitized conversation history as background context only.",
    "Do not continue, resume, or complete any unfinished task from the conversation.",
    "",
    "<conversation_history>",
  ];
  for (const message of params.messages) {
    const text = collectBtwMessageText(message.content);
    if (!text) {
      continue;
    }
    lines.push(`${message.role === "assistant" ? "Assistant" : "User"}:`, text, "");
  }
  lines.push("</conversation_history>", "");
  lines.push(buildBtwQuestionPrompt(params.question, params.inFlightPrompt));
  if (params.imageCount > 0) {
    lines.push(`[${params.imageCount} attached image(s) omitted from CLI side-question input.]`);
  }
  return lines.join("\n");
}

/**
 * Question for a side question that runs in an unsaved fork of the session's
 * own native conversation, so the conversation itself needs no excerpt.
 */
export function buildBtwForkedSessionPrompt(params: {
  question: string;
  exchanges?: ReadonlyArray<{ question: string; answer: string }>;
  imageCount?: number;
}): string {
  const lines = [
    "This is a side question, apart from the conversation above. Answer it and stop.",
    "Answer from what this conversation already holds.",
    "The main turn may still be running. Its last tool call can show as interrupted by the user only because this side question branched off mid-call, so that marker does not mean anyone stopped it. Unless the conversation shows the call finished, say it has no result yet and is likely still running; you cannot confirm whether it is. Do not mention the interrupted marker or this branch in your answer.",
    "Do not use tools. Do not continue, resume, or change any task.",
  ];
  if (params.exchanges?.length) {
    lines.push("", "Earlier in this side chat:");
    for (const exchange of params.exchanges) {
      lines.push(`I asked: ${exchange.question.trim()}`, `You answered: ${exchange.answer.trim()}`);
    }
  }
  lines.push("", "<btw_side_question>", params.question.trim(), "</btw_side_question>");
  if (params.imageCount && params.imageCount > 0) {
    lines.push(`[${params.imageCount} attached image(s) omitted from CLI side-question input.]`);
  }
  return lines.join("\n");
}
