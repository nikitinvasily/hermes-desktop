export const SESSION_READ_EVENT = "hermes-session-read-state";

export interface SessionReadChange {
  sessionId: string;
  connectionId: string;
  profile: string;
  phase: "pending" | "settled";
  committed: boolean;
}

const pending = new Map<string, Promise<boolean>>();

/** Share a pending write between row activation and the visible-run effect.
 * No successful IDs are retained: future activity must be allowed to be unread.
 */
// @lat: [[sidebar-navigation#Session read lifecycle]]
export function markSessionViewed(
  sessionId: string,
  connectionId: string,
  profile: string,
  afterPending?: () => boolean,
): Promise<boolean> {
  const key = JSON.stringify([connectionId, profile, sessionId]);
  const existing = pending.get(key);
  if (existing) {
    // A later completion must not inherit an earlier activation watermark.
    return afterPending
      ? existing.then(() =>
          afterPending()
            ? markSessionViewed(sessionId, connectionId, profile, afterPending)
            : false,
        )
      : existing;
  }
  const notify = (
    phase: SessionReadChange["phase"],
    committed = false,
  ): void => {
    window.dispatchEvent(
      new CustomEvent<SessionReadChange>(SESSION_READ_EVENT, {
        detail: { sessionId, connectionId, profile, phase, committed },
      }),
    );
  };
  // Defer the IPC invocation so the shared promise exists before any reentry.
  const write = Promise.resolve().then(async (): Promise<boolean> => {
    let committed = false;
    try {
      if (afterPending && !afterPending()) return false;
      committed =
        (await window.hermesAPI.markSessionRead(
          sessionId,
          connectionId,
          profile,
        )) === true;
      return committed;
    } catch {
      return false;
    } finally {
      pending.delete(key);
      notify("settled", committed);
    }
  });
  pending.set(key, write);
  notify("pending");
  return write;
}
