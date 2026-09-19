import { useEffect, useRef } from "react";

type PublicConnectionConfig = Awaited<
  ReturnType<typeof window.hermesAPI.getConnectionConfig>
>;

/**
 * Reload a per-connection data screen when the ACTIVE connection changes.
 *
 * Screens whose data is fetched per connection (cron jobs, kanban boards,
 * installed skills — each IPC has local / remote / ssh branches in the main
 * process) keep showing the PREVIOUS connection's data after a local/remote
 * switch unless they refetch. This hook subscribes to
 * `onConnectionConfigChanged` and calls `onChange` when the connection's
 * transport-relevant signature (`connectionId|mode|remoteUrl`) actually
 * changed.
 *
 * The baseline is seeded with the CURRENT connection at mount, so
 * re-activating the same connection (e.g. saving connection settings without
 * a real switch) never triggers a refetch — the same rule as the chat
 * transport (issue #76), so switching chats back and forth never causes
 * pointless refetches. If an event arrives before the seed resolves, the
 * null baseline lets it fire (conservative: a real switch is never missed).
 */
export function useConnectionChangeReload(onChange: () => void): void {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const signatureRef = useRef<string | null>(null);
  useEffect(() => {
    // Seed the baseline with the active connection so the first event for an
    // UNCHANGED connection is a no-op.
    window.hermesAPI
      .getConnectionConfig()
      .then((conn) => {
        if (signatureRef.current === null) {
          signatureRef.current = connectionSignature(conn);
        }
      })
      .catch(() => {
        /* stay on the null baseline: first event fires (conservative) */
      });

    const unsubscribe = window.hermesAPI.onConnectionConfigChanged((conn) => {
      const signature = connectionSignature(conn);
      if (signatureRef.current === signature) return;
      signatureRef.current = signature;
      onChangeRef.current();
    });
    return unsubscribe;
    // The callback is read through a ref, so the subscription never needs to
    // re-bind when the caller's load function identity changes.
  }, []);
}

function connectionSignature(conn: PublicConnectionConfig): string {
  return `${conn.connectionId}|${conn.mode}|${conn.remoteUrl}`;
}
