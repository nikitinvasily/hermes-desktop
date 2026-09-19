import http from "http";
import { afterEach, describe, expect, it } from "vitest";
import {
  remoteReadTextFile,
  remoteReadImageFile,
  remoteReadDirectory,
} from "../src/main/remote-files";

let server: http.Server | null = null;

function startServer(handler: http.RequestListener): Promise<{ url: string }> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (!address || typeof address === "string") {
        throw new Error("Unexpected server address");
      }
      resolve({ url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function remoteConn(url: string): {
  mode: "remote";
  remoteUrl: string;
  apiKey: string;
  remoteAuthMode: "token";
  remoteChatTransport: "dashboard";
  sshChatTransport: "auto";
  ssh: {
    host: string;
    port: number;
    username: string;
    keyPath: string;
    remotePort: number;
    localPort: number;
  };
} {
  return {
    mode: "remote" as const,
    remoteUrl: url,
    apiKey: "remote-token",
    remoteAuthMode: "token" as const,
    remoteChatTransport: "dashboard" as const,
    sshChatTransport: "auto" as const,
    ssh: {
      host: "",
      port: 22,
      username: "",
      keyPath: "",
      remotePort: 8642,
      localPort: 8642,
    },
  };
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

describe("remote file viewer access", () => {
  it("reads server file text through the dashboard fs route", async () => {
    const { url } = await startServer((req, res) => {
      expect(req.url).toBe(
        "/api/fs/read-text?path=" + encodeURIComponent("/srv/work/marker.txt"),
      );
      expect(req.headers["x-hermes-session-token"]).toBe("remote-token");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          text: "PARITY MARKER FILE CONTENT",
          truncated: false,
          byteSize: 25,
          binary: false,
        }),
      );
    });

    await expect(
      remoteReadTextFile(remoteConn(url), "/srv/work/marker.txt"),
    ).resolves.toEqual({
      content: "PARITY MARKER FILE CONTENT",
      truncated: false,
      binary: false,
    });
  });

  it("propagates the server truncated and binary flags", async () => {
    const { url } = await startServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          text: "\u0000\u0001",
          truncated: true,
          binary: true,
        }),
      );
    });

    await expect(
      remoteReadTextFile(remoteConn(url), "/srv/work/blob.bin"),
    ).resolves.toEqual({
      content: "\u0000\u0001",
      truncated: true,
      binary: true,
    });
  });

  it("returns null when the server file is missing (404)", async () => {
    const { url } = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "Not found" }));
    });

    await expect(
      remoteReadTextFile(remoteConn(url), "/srv/work/absent.txt"),
    ).resolves.toBeNull();
  });

  it("reads server images as data URLs", async () => {
    const { url } = await startServer((req, res) => {
      expect(req.url).toBe(
        "/api/fs/read-data-url?path=" + encodeURIComponent("/srv/work/pic.png"),
      );
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ dataUrl: "data:image/png;base64,QUJD" }));
    });

    await expect(
      remoteReadImageFile(remoteConn(url), "/srv/work/pic.png"),
    ).resolves.toBe("data:image/png;base64,QUJD");
  });

  it("lists server directories through the dashboard fs route", async () => {
    const { url } = await startServer((req, res) => {
      expect(req.url).toBe(
        "/api/fs/list?path=" + encodeURIComponent("/srv/work"),
      );
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          entries: [
            { name: "sub", path: "/srv/work/sub", isDirectory: true },
            { name: "a.txt", path: "/srv/work/a.txt", isDirectory: false },
          ],
        }),
      );
    });

    await expect(
      remoteReadDirectory(remoteConn(url), "/srv/work"),
    ).resolves.toEqual([
      { name: "sub", isDirectory: true },
      { name: "a.txt", isDirectory: false },
    ]);
  });

  it("returns null for a malformed directory listing", async () => {
    const { url } = await startServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ entries: "not-an-array" }));
    });

    await expect(
      remoteReadDirectory(remoteConn(url), "/srv/work"),
    ).resolves.toBeNull();
  });
});
