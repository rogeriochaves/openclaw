import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Claude Code subagent copy follows its deferred viewer, not the application boot path.
const enChatNativeSubagent = {
  chat: {
    toolCards: {
      nativeSubagent: {
        title: "Subagent",
        running: "Running",
        done: "Done",
        background: "Background",
        waiting: "Waiting for the subagent to start…",
        empty: "No activity yet.",
        earlierOmitted: "Earlier activity is not shown.",
        stale: "No updates since {time}.",
        loadFailed: "Could not load subagent activity.",
      },
    },
  },
} satisfies TranslationMap;

export const registerChatNativeSubagentEnglish = Object.assign(
  () => Object.assign(en.chat.toolCards, enChatNativeSubagent.chat.toolCards),
  { catalog: enChatNativeSubagent },
);
