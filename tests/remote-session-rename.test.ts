import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ConnectionConfig } from "../src/main/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const oauth = vi.hoisted(() => vi.fn());
vi.mock("../src/main/remote-oauth", () => ({ requestRemoteOAuthJson: oauth }));
import { remoteUpdateSessionTitle } from "../src/main/remote-sessions";

describe("guarded remote session rename", () => {
  let server: http.Server;
  let remoteUrl: string;
  let snapshotStatus: number;
  let snapshot: Record<string, unknown>;
  let detail: Record<string, unknown>;
  let refusal: string;
  const requests: Array<{
    method: string;
    url: URL;
    body: Record<string, unknown>;
  }> = [];
  beforeEach(async () => {
    requests.length = 0;
    oauth.mockReset();
    snapshotStatus = 200;
    refusal = "";
    detail = { id: "rename/id", runtime_revision: 7, runtime_generation: 3 };
    snapshot = {
      session_id: "rename/id",
      exists: true,
      runtime_revision: 7,
      runtime_generation: 3,
    };
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        const url = new URL(req.url || "/", "http://localhost");
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        requests.push({ method: req.method || "GET", url, body });
        res.setHeader("Content-Type", "application/json");
        if (req.method === "GET") {
          const isSnapshot = url.pathname.endsWith("/mutation-snapshot");
          res.statusCode = isSnapshot ? snapshotStatus : 200;
          res.end(JSON.stringify(isSnapshot ? snapshot : detail));
        } else if (refusal) {
          res.statusCode = 409;
          res.end(JSON.stringify({ detail: refusal }));
        } else if (
          "runtime_revision" in detail &&
          (body.expected_revision !== 7 ||
            body.expected_generation !== 3 ||
            !body.request_id)
        ) {
          res.statusCode = 409;
          res.end(JSON.stringify({ detail: "client_upgrade_required" }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  // @lat: [[connections#Connections#Test specifications#Guarded Remote rename receipts]]
  it("renames with authoritative counters in JSON and a unique receipt", async () => {
    await remoteUpdateSessionTitle(
      { remoteUrl, apiKey: "test" },
      "rename/id",
      "New title",
    );
    await remoteUpdateSessionTitle(
      { remoteUrl, apiKey: "test" },
      "rename/id",
      "Next title",
    );
    expect(requests.map((r) => [r.method, r.url.pathname])).toEqual([
      ["GET", "/api/sessions/rename%2Fid/mutation-snapshot"],
      ["PATCH", "/api/sessions/rename%2Fid"],
      ["GET", "/api/sessions/rename%2Fid/mutation-snapshot"],
      ["PATCH", "/api/sessions/rename%2Fid"],
    ]);
    expect(requests[1].body).toEqual({
      title: "New title",
      expected_revision: 7,
      expected_generation: 3,
      request_id: expect.any(String),
    });
    expect(requests[3].body.request_id).not.toBe(requests[1].body.request_id);
  });

  it("keeps preparation and JSON mutation on the owning profile", async () => {
    await remoteUpdateSessionTitle(
      { remoteUrl, apiKey: "test", profile: "research" },
      "rename/id",
      "New title",
    );
    expect(
      requests.every((r) => r.url.searchParams.get("profile") === "research"),
    ).toBe(true);
    expect(requests[1].body.profile).toBe("research");
  });

  it("uses exact detail counters when only the snapshot route is absent", async () => {
    snapshotStatus = 404;
    await remoteUpdateSessionTitle(
      { remoteUrl, apiKey: "test" },
      "rename/id",
      "New title",
    );
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(requests[2].body).toMatchObject({
      title: "New title",
      expected_revision: 7,
      expected_generation: 3,
    });
  });

  it("supports legacy renames only after checking the exact detail identity", async () => {
    snapshotStatus = 404;
    detail = { id: "rename/id" };
    await remoteUpdateSessionTitle(
      { remoteUrl, apiKey: "test" },
      "rename/id",
      "New title",
    );
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(requests[2].body).toEqual({ title: "New title" });
  });

  it.each([
    { id: "other" },
    { id: "rename/id", runtime_revision: null },
    { id: "rename/id", runtime_generation: 3 },
  ])("refuses unsafe legacy detail %j", async (invalid) => {
    snapshotStatus = 404;
    detail = invalid;
    await expect(
      remoteUpdateSessionTitle(
        { remoteUrl, apiKey: "test" },
        "rename/id",
        "New title",
      ),
    ).rejects.toThrow("not saved");
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET"]);
  });

  it.each([401, 403, 409, 500])(
    "never falls back after snapshot refusal %s",
    async (status) => {
      snapshotStatus = status;
      await expect(
        remoteUpdateSessionTitle(
          { remoteUrl, apiKey: "test" },
          "rename/id",
          "New title",
        ),
      ).rejects.toThrow(String(status));
      expect(requests.map((r) => r.method)).toEqual(["GET"]);
    },
  );

  it.each([
    { session_id: "another-session" },
    { exists: false },
    { exists: null },
    { runtime_revision: undefined },
    { runtime_revision: -1 },
    { runtime_revision: "7" },
    { runtime_revision: 1.5 },
    { runtime_revision: Number.MAX_SAFE_INTEGER + 1 },
    { runtime_generation: -1 },
    { runtime_generation: "3" },
    { runtime_generation: 1.5 },
  ])("refuses invalid snapshot %j without a write", async (invalid) => {
    Object.assign(snapshot, invalid);
    await expect(
      remoteUpdateSessionTitle(
        { remoteUrl, apiKey: "test" },
        "rename/id",
        "New title",
      ),
    ).rejects.toThrow("not saved");
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
  });

  it.each(["revision_conflict", "client_upgrade_required", "session_busy"])(
    "preserves %s without retrying unfenced",
    async (reason) => {
      refusal = reason;
      await expect(
        remoteUpdateSessionTitle(
          { remoteUrl, apiKey: "test" },
          "rename/id",
          "New title",
        ),
      ).rejects.toThrow(reason);
      expect(requests.map((r) => r.method)).toEqual(["GET", "PATCH"]);
    },
  );

  it("uses the OAuth boundary for snapshot and scoped mutation", async () => {
    oauth.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({ ok: true });
    const config = {
      mode: "remote",
      remoteUrl,
      remoteAuthMode: "oauth",
      apiKey: "",
      profile: "research",
    } as ConnectionConfig & { profile: string };
    await remoteUpdateSessionTitle(config, "rename/id", "OAuth title");
    expect(oauth.mock.calls[0][0]).toBe(
      `${remoteUrl}/api/sessions/rename%2Fid/mutation-snapshot?profile=research`,
    );
    expect(oauth.mock.calls[1][0]).toBe(
      `${remoteUrl}/api/sessions/rename%2Fid?profile=research`,
    );
    expect(oauth.mock.calls[1][1]).toMatchObject({
      method: "PATCH",
      body: {
        title: "OAuth title",
        profile: "research",
        expected_revision: 7,
        expected_generation: 3,
        request_id: expect.any(String),
      },
    });
    expect(requests).toEqual([]);
  });

  it("does not treat an OAuth authentication failure as legacy", async () => {
    oauth.mockRejectedValueOnce(
      Object.assign(new Error("expired"), { statusCode: 401 }),
    );
    const config = {
      mode: "remote",
      remoteUrl,
      remoteAuthMode: "oauth",
      apiKey: "",
    } as ConnectionConfig;
    await expect(
      remoteUpdateSessionTitle(config, "rename/id", "New title"),
    ).rejects.toThrow("expired");
    expect(oauth).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([]);
  });
});
