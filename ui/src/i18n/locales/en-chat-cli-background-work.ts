import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// claude-cli background work copy follows its deferred status row, not the boot path.
const enChatCliBackgroundWork = {
  chat: {
    backgroundTasks: {
      cliWork: {
        runningOne: "1 background task running",
        runningMany: "{count} background tasks running",
        finishedOne: "1 background task ended",
        finishedMany: "{count} background tasks ended",
        lastActivity: "last activity",
        ago: "ago",
        quietOne: "1 quiet for {minutes}+ min",
        quietMany: "{count} quiet for {minutes}+ min",
        show: "Show background work",
        hide: "Hide background work",
        kindSubagent: "Subagent",
        kindCommand: "Command",
        kindDetached: "Detached job",
        statusRunning: "Running",
        statusDone: "Done",
        statusFailed: "Failed",
        statusStopped: "Stopped",
        started: "started",
        latest: "Latest",
        waitingOn: "Waiting on",
        nested: "Nested",
        cpu: "CPU {percent}%",
        processes: "{count} processes",
        pid: "pid {pid}",
        stale: "No activity for {minutes}+ minutes. It may be stuck.",
        processGone: "The Claude process for this session is not running.",
      },
    },
  },
} satisfies TranslationMap;

export const registerChatCliBackgroundWorkEnglish = Object.assign(
  () =>
    Object.assign(en.chat.backgroundTasks, {
      cliWork: enChatCliBackgroundWork.chat.backgroundTasks.cliWork,
    }),
  { catalog: enChatCliBackgroundWork },
);
