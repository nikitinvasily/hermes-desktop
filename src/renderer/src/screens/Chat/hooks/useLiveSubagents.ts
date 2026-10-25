import { useEffect, useRef, useState } from "react";

export interface LiveSubagentSnapshot {
  subagents?: Array<{ status?: string | null }>;
}

/** Live registry only: unfinished database rows are not proof of liveness. */
export function hasLiveSubagents(snapshot: LiveSubagentSnapshot): boolean {
  return (snapshot.subagents ?? []).some(
    (child) => child.status === "running" || child.status === "starting",
  );
}

/** Session-scoped polling also runs while the parent's own turn is idle. */
// @lat: [[sidebar-navigation#Waiting for subagents]]
export function useLiveSubagents(
  scope: string,
  enabled: boolean,
  read: () => Promise<LiveSubagentSnapshot>,
): boolean {
  const readRef = useRef(read);
  readRef.current = read;
  const [state, setState] = useState({ scope, active: false });
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ scope, active: false });
    if (!enabled) return;
    const poll = async (): Promise<void> => {
      let active = false;
      try {
        active = hasLiveSubagents(await readRef.current());
      } catch {
        // Unknown/disconnected is not evidence that children are still alive.
      }
      if (cancelled) return;
      setState((previous) =>
        previous.scope === scope && previous.active === active
          ? previous
          : { scope, active },
      );
      timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [scope, enabled]);
  return enabled && state.scope === scope && state.active;
}
