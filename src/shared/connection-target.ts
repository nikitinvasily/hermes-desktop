// A stable identity for the agent that supplies a connection's data.
// Keep this shared between renderer (drawer binding and reload) and main
// (the last check before an assignment enters any transport).
export interface ConnectionTargetLike {
  connectionId: string;
  mode: string;
  remoteUrl?: string | null;
  ssh?: {
    host?: string | null;
    port?: number | null;
    username?: string | null;
    keyPath?: string | null;
    remotePort?: number | null;
    localPort?: number | null;
    dockerContainerName?: string | null;
  } | null;
}

export function connectionTargetSignature(conn: ConnectionTargetLike): string {
  const ssh = conn.ssh;
  return JSON.stringify([
    conn.connectionId,
    conn.mode,
    conn.remoteUrl ?? "",
    conn.mode === "ssh"
      ? [
          ssh?.host ?? "",
          ssh?.port ?? 0,
          ssh?.username ?? "",
          ssh?.keyPath ?? "",
          ssh?.remotePort ?? 0,
          ssh?.localPort ?? 0,
          ssh?.dockerContainerName ?? "",
        ]
      : null,
  ]);
}
