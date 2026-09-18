/**
 * Transport-relevant slice of a public connection config. `select-connection`
 * broadcasts the full config for EVERY connection on each switch, so the chat
 * must decide whether its own transport parameters actually changed before
 * tearing down a live WebSocket (issue #76).
 */
export interface ConnectionTransportConfigLike {
  connectionId: string;
  mode: "local" | "remote" | "ssh";
  remoteUrl: string;
  remoteChatTransport: string;
  sshChatTransport: string;
  ssh: {
    host: string;
    port: number;
    username: string;
    keyPath: string;
    remotePort: number;
    localPort: number;
    dockerContainerName?: string;
  };
}

/**
 * Stable signature of the transport-relevant fields. Two broadcasts with the
 * same signature describe the same transport endpoint; re-activating a
 * connection (`select-connection` onto the chat's own connectionId) keeps the
 * signature and therefore must NOT bump the transport revision.
 */
export function connectionTransportSignature(
  conn: ConnectionTransportConfigLike,
): string {
  // @lat: [[dashboard-detach#Transport revision only bumps on real changes]]
  return [
    conn.mode,
    conn.remoteUrl,
    conn.remoteChatTransport,
    conn.mode === "ssh" && conn.ssh
      ? [
          conn.ssh.host,
          conn.ssh.port,
          conn.ssh.username,
          conn.ssh.keyPath,
          conn.ssh.remotePort,
          conn.ssh.localPort,
          conn.ssh.dockerContainerName ?? "",
        ].join("|")
      : "",
    conn.mode === "ssh" ? conn.sshChatTransport : "",
  ].join("~");
}

/**
 * Next revision value for a broadcast: bump only when the signature changed
 * relative to the last applied one. `null` previous means "first broadcast for
 * this connection" — the revision still bumps only when a signature exists,
 * which is always true for real configs.
 */
export function connectionTransportRevision(
  conn: ConnectionTransportConfigLike,
  revision: number,
  previousSignature: string | null,
): number {
  return connectionTransportSignature(conn) === previousSignature
    ? revision
    : revision + 1;
}
