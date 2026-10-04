// CLI session ids of turns that are running now, per OpenClaw session. The session
// binding is only written when a turn ends, so readers that follow a running turn's
// own CLI files (for example its native subagents) look the session up here.
const activeSessions = new Map<string, Map<string, number>>();

function activeKey(backendId: string, sessionKey: string): string {
  return JSON.stringify([backendId, sessionKey]);
}

/** Marks `cliSessionId` as in use by a running turn; call the result when the turn ends. */
export function markCliSessionActive(params: {
  backendId: string;
  sessionKey: string;
  cliSessionId: string;
}): () => void {
  const key = activeKey(params.backendId, params.sessionKey);
  const sessions = activeSessions.get(key) ?? new Map<string, number>();
  activeSessions.set(key, sessions);
  sessions.set(params.cliSessionId, (sessions.get(params.cliSessionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const count = (sessions.get(params.cliSessionId) ?? 1) - 1;
    if (count > 0) {
      sessions.set(params.cliSessionId, count);
      return;
    }
    sessions.delete(params.cliSessionId);
    if (sessions.size === 0 && activeSessions.get(key) === sessions) {
      activeSessions.delete(key);
    }
  };
}

export function listActiveCliSessionIds(params: {
  backendId: string;
  sessionKey: string;
}): string[] {
  return [...(activeSessions.get(activeKey(params.backendId, params.sessionKey))?.keys() ?? [])];
}
