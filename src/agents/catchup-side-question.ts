// Prepares the /catchup side question and renders its answer for text surfaces.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseCatchupAnswer, renderCatchupText } from "./catchup-answer.js";
import { catchupCoverageKey } from "./catchup-kept.js";
import { readCatchupTranscriptRows } from "./catchup-transcript.js";
import {
  buildCatchupIndex,
  buildCatchupQuestion,
  defaultCatchupTimeFormatter,
  type CatchupIndex,
} from "./catchup.js";
import { resolveUserTimezone } from "./date-time.js";

/** The question label shown for catch-up answers; the prompt itself is built per session. */
export const CATCHUP_SIDE_QUESTION = "/catchup";

export type PreparedCatchupSideQuestion = {
  index: CatchupIndex;
  /** What this catch-up covers; equal keys mean nothing new arrived since. */
  coverageKey: string;
  /** Fixed catch-up prompt with the numbered messages inline. */
  question: string;
  /** Rows before the owner's message, passed as background context only. */
  contextMessages: unknown[];
  /** Renders the raw model answer (JSON, or text as a fallback) with numbered refs. */
  render: (raw: string) => string;
};

export function prepareCatchupSideQuestion(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
}): PreparedCatchupSideQuestion {
  const read = readCatchupTranscriptRows({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  });
  const index = buildCatchupIndex(read.rows, { truncated: read.truncated });
  const formatTime = defaultCatchupTimeFormatter(
    resolveUserTimezone(params.cfg.agents?.defaults?.userTimezone),
  );
  return {
    index,
    coverageKey: catchupCoverageKey(params.sessionId, index),
    question: buildCatchupQuestion(index, { formatTime }),
    contextMessages: read.backgroundRows.map((row) => row.message),
    render: (raw) => renderCatchupText(parseCatchupAnswer(raw, index), raw, index, { formatTime }),
  };
}
