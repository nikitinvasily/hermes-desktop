import { describe, expect, it } from "vitest";
import {
  connectionTransportRevision,
  connectionTransportSignature,
  type ConnectionTransportConfigLike,
} from "./connectionTransport";

function conn(
  overrides: Partial<ConnectionTransportConfigLike> = {},
): ConnectionTransportConfigLike {
  return {
    connectionId: "c1",
    mode: "remote",
    remoteUrl: "http://10.255.0.10:9119",
    remoteChatTransport: "dashboard",
    sshChatTransport: "auto",
    ssh: {
      host: "",
      port: 22,
      username: "",
      keyPath: "",
      remotePort: 0,
      localPort: 0,
    },
    ...overrides,
  };
}

describe("connectionTransportSignature", () => {
  it("is stable across broadcasts that only re-activate the connection", () => {
    const a = conn();
    const b = conn({
      name: "renamed",
    } as Partial<ConnectionTransportConfigLike>);
    expect(connectionTransportSignature(a)).toBe(
      connectionTransportSignature(b),
    );
  });

  it("changes when the remote URL changes", () => {
    expect(
      connectionTransportSignature(conn({ remoteUrl: "http://other:9119" })),
    ).not.toBe(connectionTransportSignature(conn()));
  });

  it("changes when the mode changes", () => {
    expect(connectionTransportSignature(conn({ mode: "local" }))).not.toBe(
      connectionTransportSignature(conn()),
    );
  });

  it("changes when the ssh host changes (ssh mode)", () => {
    const base = conn({
      mode: "ssh",
      ssh: {
        host: "a.example",
        port: 2222,
        username: "u",
        keyPath: "~/.ssh/k",
        remotePort: 8080,
        localPort: 19642,
      },
    });
    const changed = conn({
      mode: "ssh",
      ssh: { ...base.ssh, host: "b.example" },
    });
    expect(connectionTransportSignature(changed)).not.toBe(
      connectionTransportSignature(base),
    );
  });

  it("ignores ssh fields when the mode is not ssh", () => {
    const a = conn({ mode: "remote" });
    const b = conn({
      mode: "remote",
      ssh: {
        host: "whatever",
        port: 1,
        username: "x",
        keyPath: "y",
        remotePort: 2,
        localPort: 3,
      },
    });
    expect(connectionTransportSignature(a)).toBe(
      connectionTransportSignature(b),
    );
  });
});

describe("connectionTransportRevision", () => {
  it("keeps the revision when the signature is unchanged", () => {
    expect(
      connectionTransportRevision(
        conn(),
        4,
        connectionTransportSignature(conn()),
      ),
    ).toBe(4);
  });

  it("bumps the revision when the signature changed", () => {
    expect(
      connectionTransportRevision(
        conn({ remoteUrl: "http://other:9119" }),
        4,
        connectionTransportSignature(conn()),
      ),
    ).toBe(5);
  });

  it("bumps on the first broadcast (null previous signature)", () => {
    expect(connectionTransportRevision(conn(), 0, null)).toBe(1);
  });
});
