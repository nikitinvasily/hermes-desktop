import http from "http";
import { afterEach, describe, expect, it } from "vitest";
import {
  remoteProjectGroupSessions,
  type ProjectGroupSessions,
} from "../src/main/project-group-sessions";
import type { RemoteSessionConfig } from "../src/main/remote-sessions";

function startServer(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => unknown,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    try {
      const body = handler(req, res);
      if (body === undefined) return; // handler wrote the response itself
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    } catch {
      res.statusCode = 500;
      res.end("boom");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({ server, port: address.port });
    });
  });
}

const servers: http.Server[] = [];

function configFor(port: number): RemoteSessionConfig {
  return {
    remoteUrl: `http://127.0.0.1:${port}`,
    apiKey: "test-token",
  };
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("remoteProjectGroupSessions", () => {
  it("collects each project's sessions keyed by folder path", async () => {
    const { server, port } = await startServer(() => ({
      projects: [
        {
          id: "p_abc",
          label: "Трейдинг",
          path: "/home/hermes/.hermes/workspace/trading",
          previewSessions: [
            {
              id: "s1",
              title: "First",
              started_at: 100,
              last_active: 300,
              source: "telegram",
              message_count: 4,
              model: "gpt-test",
            },
            {
              id: "s2",
              preview: "preview-only row",
              started_at: 50,
              source: "tui",
            },
          ],
        },
        {
          id: "__no_project__",
          label: "Home",
          path: null,
          previewSessions: [{ id: "s3", title: " homeless " }],
        },
      ],
    }));
    servers.push(server);

    const result = await remoteProjectGroupSessions(configFor(port));
    expect(result.groups.size).toBe(1);
    const trading = result.groups.get(
      "/home/hermes/.hermes/workspace/trading",
    )!;
    expect(trading.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(trading[0]).toMatchObject({
      title: "First",
      startedAt: 100,
      lastActivityAt: 300,
      source: "telegram",
      messageCount: 4,
      contextFolder: "/home/hermes/.hermes/workspace/trading",
    });
    // A row without a title falls back to its preview text.
    expect(trading[1].title).toBe("preview-only row");
    // A row without either gets the Session <tail> fallback.
    const lonely: ProjectGroupSessions["groups"] = new Map();
    expect(lonely.size).toBe(0);
  });

  it("skips sessions without an id and projects without a path", async () => {
    const { server, port } = await startServer(() => ({
      projects: [
        {
          id: "p_def",
          label: "Empty-ish",
          path: "/w/diy",
          previewSessions: [{ title: "no id" }, { id: "", title: "blank id" }],
        },
        { id: "auto", label: "Auto", path: "/w/auto", previewSessions: [] },
      ],
    }));
    servers.push(server);

    const result = await remoteProjectGroupSessions(configFor(port));
    // No project produced a usable session list: empty groups are omitted.
    expect(result.groups.size).toBe(0);
  });

  it("returns empty groups when the tree request fails", async () => {
    const { server, port } = await startServer(() => {
      throw new Error("boom");
    });
    servers.push(server);

    const result = await remoteProjectGroupSessions(configFor(port));
    expect(result.groups.size).toBe(0);
  });

  it("sends a large preview_limit so slices are full membership", async () => {
    let seenUrl = "";
    const { server, port } = await startServer((req) => {
      seenUrl = req.url ?? "";
      return { projects: [] };
    });
    servers.push(server);

    await remoteProjectGroupSessions(configFor(port));
    expect(seenUrl).toContain("/api/profiles/projects/tree?preview_limit=");
    const limit = Number(seenUrl.split("preview_limit=")[1]);
    expect(limit).toBeGreaterThanOrEqual(100);
  });
});
