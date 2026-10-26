import { BrowserWindow } from "electron";
import type { ConnectionConfig } from "./config";

/**
 * Remote connection health, derived at the single REST boundary
 * (`remoteDashboardRequestJson`) and pushed to the renderer so the UI can
 * degrade loudly instead of silently showing stale data (backlog #74/#75).
 *
 * - `authLost` — the dashboard answered 401 / `session_expired` / the OAuth
 *   cookies no longer authenticate: the user must sign in again.
 * - `unreachable` — transport or server failure (DNS, WG tunnel down,
 *   timeout or HTTP 5xx): retryable, no credentials are at fault.
 * - `ok` — the dashboard answered successfully or rejected an operation
 *   with a non-authentication/non-timeout HTTP 4xx response.
 */
export type RemoteHealthState = "ok" | "authLost" | "unreachable";

export interface RemoteHealthEvent {
  remoteUrl: string | null;
  state: RemoteHealthState;
}

const listeners = new Set<(event: RemoteHealthEvent) => void>();

export function onRemoteHealthChanged(
  listener: (event: RemoteHealthEvent) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Duck-typed to avoid importing remote-oauth (Electron net/session stack). */
interface RemoteErrorLike {
  readonly needsOAuthLogin?: boolean;
  readonly statusCode?: number;
  readonly message?: string;
}

function classifyRemoteError(error: unknown): RemoteHealthState {
  if (error && typeof error === "object") {
    const e = error as RemoteErrorLike;
    if (e.needsOAuthLogin === true) return "authLost";
    if (e.statusCode === 401) return "authLost";
    if (typeof e.message === "string" && e.message.includes("session_expired"))
      return "authLost";
    // A rejected operation still reached the dashboard. The model-library
    // probe legitimately returns 404 before its compatibility fallback.
    // Treating that as a lost connection clears the sidebar on chat open.
    if (
      e.statusCode &&
      e.statusCode >= 400 &&
      e.statusCode < 500 &&
      e.statusCode !== 408
    )
      return "ok";
  }
  return "unreachable";
}

function emit(event: RemoteHealthEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* listener errors must not break the request path */
    }
  }
}

/**
 * The boundary does not know registry ids; events carry the remoteUrl and the
 * renderer matches them against the ACTIVE connection's url.
 */
export function reportRemoteHealth(
  connection: Pick<ConnectionConfig, "remoteUrl">,
  error: unknown,
): void {
  emit({
    remoteUrl: connection.remoteUrl ?? null,
    state: classifyRemoteError(error),
  });
}

export function reportRemoteHealthOk(
  connection: Pick<ConnectionConfig, "remoteUrl">,
): void {
  emit({
    remoteUrl: connection.remoteUrl ?? null,
    state: "ok",
  });
}

export function broadcastRemoteHealthToRenderer(
  event: RemoteHealthEvent,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("remote-health-changed", event);
    } catch {
      /* window may be closing */
    }
  }
}
