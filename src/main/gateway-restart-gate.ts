import { restartGateway, profileKey, probeGatewayLiveWork } from "./hermes";

// Deferred gateway restart gate (issue #128): a config change (model switch,
// API-key write) must restart the gateway, but a hard restart kills every
// live session and in-flight subagent run in the process. This module owns
// the "wait until the gateway is idle, then restart" policy.

/** One deferred restart per profile. A NEW config change while waiting keeps
 * the single pending restart (the latest config is already on disk — only
 * the human-readable reason is refreshed). */
const pendingDeferredRestarts = new Map<string, { reason: string }>();

const DEFERRED_RESTART_POLL_MS = 5_000;

export type DeferredRestartOutcome = "restarted" | "deferred" | "failed";

/**
 * Restart the gateway for a config change, but only once no agent work is in
 * flight. Probes `probeGatewayLiveWork` first: idle/unknown restarts
 * immediately (unknown = probe failed → legacy behavior, fail open); busy
 * defers until the work drains.
 */
export async function restartGatewayWhenIdle(
  profile: string | undefined,
  reason: string,
): Promise<DeferredRestartOutcome> {
  const key = profileKey(profile);
  const probe = await probeGatewayLiveWork(profile);
  if (probe === "idle" || probe === "unknown") {
    const ok = await restartGateway(profile);
    return ok ? "restarted" : "failed";
  }
  const prev = pendingDeferredRestarts.get(key);
  if (prev) {
    // Already waiting; the newer config change wins for the reason only.
    prev.reason = reason;
    return "deferred";
  }
  pendingDeferredRestarts.set(key, { reason });
  void pollDeferredRestart(profile);
  return "deferred";
}

/** True when a deferred restart is pending for the profile (test seam). */
export function hasPendingDeferredRestart(profile?: string): boolean {
  return pendingDeferredRestarts.has(profileKey(profile));
}

async function pollDeferredRestart(profile?: string): Promise<void> {
  const key = profileKey(profile);
  for (;;) {
    await new Promise((r) => setTimeout(r, DEFERRED_RESTART_POLL_MS));
    const pending = pendingDeferredRestarts.get(key);
    if (!pending) return;
    const probe = await probeGatewayLiveWork(profile);
    if (probe === "busy") continue;
    pendingDeferredRestarts.delete(key);
    // idle or unknown: the work has drained (or we cannot tell — do not hold
    // the restart hostage forever). Restart now.
    await restartGateway(profile);
    return;
  }
}
