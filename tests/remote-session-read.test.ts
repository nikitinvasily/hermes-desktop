import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "../src/main/config";

const oauth = vi.hoisted(() => vi.fn());
vi.mock("../src/main/remote-oauth", () => ({ requestRemoteOAuthJson: oauth }));
import { remoteMarkSessionRead } from "../src/main/remote-sessions";

describe("durable remote read watermark", () => {
  let server: http.Server;
  let baseUrl: string;
  let modern: boolean;
  let snapshotAvailable: boolean;
  let exists: boolean;
  let revision: unknown;
  let refusal: number;
  const requests: Array<{
    method: string;
    url: string;
    body: Record<string, unknown>;
  }> = [];
  beforeEach(async () => {
    requests.length = 0;
    modern = true;
    snapshotAvailable = true;
    exists = true;
    revision = 7;
    refusal = 0;
    oauth.mockReset();
    server = http.createServer((req, res): void => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer): void => {
        chunks.push(chunk);
      });
      req.on("end", (): void => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
          requests.push({
            method: req.method || "GET",
            url: req.url || "",
            body,
          });
          res.setHeader("Content-Type", "application/json");
          if (req.method === "GET") {
            const snapshotRoute = req.url?.includes("/mutation-snapshot");
            if (snapshotRoute && (!modern || !snapshotAvailable)) {
              res.statusCode = 404;
              res.end('{"detail":"Not Found"}');
              return;
            }
            if (!snapshotRoute) {
              res.end(
                JSON.stringify({
                  id: "read/id",
                  last_read_at: 0,
                  ...(modern
                    ? { runtime_revision: revision, runtime_generation: 3 }
                    : {}),
                }),
              );
              return;
            }
            res.end(
              JSON.stringify({
                session_id: "read/id",
                exists,
                runtime_revision: revision,
                runtime_generation: 3,
              }),
            );
            return;
          }
          if (refusal) {
            res.statusCode = refusal;
            res.end('{"detail":"revision_conflict"}');
            return;
          }
          if (
            modern &&
            (body.expected_revision !== 7 ||
              body.expected_generation !== 3 ||
              !body.request_id)
          ) {
            res.statusCode = 409;
            res.end('{"detail":"client_upgrade_required"}');
            return;
          }
          res.end('{"ok":true}');
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ detail: String(error) }));
        }
      });
    });
    await new Promise<void>((resolve): void => {
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject): void => {
      server.close((error): void => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  it("uses the authoritative snapshot and a unique guarded receipt for each read", async () => {
    await remoteMarkSessionRead(
      { remoteUrl: baseUrl, apiKey: "fixture" },
      "read/id",
    );
    await remoteMarkSessionRead(
      { remoteUrl: baseUrl, apiKey: "fixture" },
      "read/id",
    );
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ["GET", "/api/sessions/read%2Fid/mutation-snapshot"],
      ["PATCH", "/api/sessions/read%2Fid"],
      ["GET", "/api/sessions/read%2Fid/mutation-snapshot"],
      ["PATCH", "/api/sessions/read%2Fid"],
    ]);
    expect(requests[1].body).toMatchObject({
      unread: false,
      expected_revision: 7,
      expected_generation: 3,
    });
    expect(requests[1].body.request_id).toEqual(expect.any(String));
    expect(requests[3].body.request_id).not.toBe(requests[1].body.request_id);
  });

  it("keeps query and mutation-body profile on the same owning profile", async () => {
    await remoteMarkSessionRead(
      { remoteUrl: baseUrl, apiKey: "fixture", profile: "research" },
      "read/id",
    );
    expect(requests[0].url).toBe(
      "/api/sessions/read%2Fid/mutation-snapshot?profile=research",
    );
    expect(requests[1].url).toBe("/api/sessions/read%2Fid?profile=research");
    expect(requests[1].body.profile).toBe("research");
  });

  it("supports legacy dashboards only when the snapshot route is absent", async () => {
    modern = false;
    await remoteMarkSessionRead(
      { remoteUrl: baseUrl, apiKey: "fixture" },
      "read/id",
    );
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(requests[2].body).toEqual({ unread: false });
  });

  it("uses real detail counters on revision-fenced dashboards without the snapshot route", async () => {
    snapshotAvailable = false;
    await remoteMarkSessionRead(
      { remoteUrl: baseUrl, apiKey: "fixture" },
      "read/id",
    );
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(requests[2].body).toMatchObject({
      unread: false,
      expected_revision: 7,
      expected_generation: 3,
    });
  });

  it("does not downgrade a malformed modern snapshot to an unfenced write", async () => {
    revision = "7";
    await expect(
      remoteMarkSessionRead(
        { remoteUrl: baseUrl, apiKey: "fixture" },
        "read/id",
      ),
    ).rejects.toThrow();
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
  });

  it("does not mark a missing modern session read", async () => {
    exists = false;
    await expect(
      remoteMarkSessionRead(
        { remoteUrl: baseUrl, apiKey: "fixture" },
        "read/id",
      ),
    ).rejects.toThrow();
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
  });

  it("preserves a conflict instead of retrying an unfenced mutation", async () => {
    refusal = 409;
    await expect(
      remoteMarkSessionRead(
        { remoteUrl: baseUrl, apiKey: "fixture" },
        "read/id",
      ),
    ).rejects.toThrow("409");
    expect(requests.map((r) => r.method)).toEqual(["GET", "PATCH"]);
  });

  it("reports a confirmed write as true to the renderer", async () => {
    oauth
      .mockResolvedValueOnce({
        session_id: "read/id",
        exists: true,
        runtime_revision: 7,
        runtime_generation: 3,
      })
      .mockResolvedValueOnce({ ok: true });
    const config = {
      mode: "remote",
      remoteUrl: baseUrl,
      remoteAuthMode: "oauth",
      apiKey: "",
    } as ConnectionConfig;
    expect(await remoteMarkSessionRead(config, "read/id")).toBe(true);
  });

  it("uses the authenticated OAuth boundary for both snapshot and receipt", async () => {
    oauth
      .mockResolvedValueOnce({
        session_id: "read/id",
        exists: true,
        runtime_revision: 7,
        runtime_generation: 3,
      })
      .mockResolvedValueOnce({ ok: true });
    const config = {
      mode: "remote",
      remoteUrl: baseUrl,
      remoteAuthMode: "oauth",
      apiKey: "",
      profile: "research",
    } as ConnectionConfig & { profile: string };
    await remoteMarkSessionRead(config, "read/id");
    expect(oauth.mock.calls[0][0]).toBe(
      `${baseUrl}/api/sessions/read%2Fid/mutation-snapshot?profile=research`,
    );
    expect(oauth.mock.calls[1][1].body).toMatchObject({
      unread: false,
      profile: "research",
      expected_revision: 7,
      expected_generation: 3,
    });
    expect(requests).toEqual([]);
  });

  it("does not treat an OAuth authentication failure as a legacy backend", async () => {
    oauth.mockRejectedValueOnce(
      Object.assign(new Error("expired"), { statusCode: 401 }),
    );
    const config = {
      mode: "remote",
      remoteUrl: baseUrl,
      remoteAuthMode: "oauth",
      apiKey: "",
    } as ConnectionConfig;
    await expect(remoteMarkSessionRead(config, "read/id")).rejects.toThrow(
      "expired",
    );
    expect(oauth).toHaveBeenCalledTimes(1);
  });
});
