import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/main/remote-oauth", () => ({
  requestRemoteOAuthJson: vi.fn(),
}));
import {
  remoteDeleteSession,
  remoteDeleteSessions,
} from "../src/main/remote-sessions";

describe("guarded remote session deletion", () => {
  let server: http.Server;
  let remoteUrl: string;
  let snapshotStatus: number;
  let snapshot: Record<string, unknown>;
  let refusal: number;
  let detail: Record<string, unknown>;
  const requests: Array<{ method: string; url: URL }> = [];
  beforeEach(async () => {
    requests.length = 0;
    snapshotStatus = 200;
    refusal = 0;
    detail = { id: "delete/id", runtime_revision: 7, runtime_generation: 3 };
    snapshot = {
      session_id: "delete/id",
      exists: true,
      runtime_revision: 7,
      runtime_generation: 3,
    };
    server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://localhost");
      requests.push({ method: req.method || "GET", url });
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET") {
        const isSnapshot = url.pathname.endsWith("/mutation-snapshot");
        res.statusCode = isSnapshot ? snapshotStatus : 200;
        res.end(JSON.stringify(isSnapshot ? snapshot : detail));
      } else if (refusal) {
        res.statusCode = refusal;
        res.end(JSON.stringify({ detail: "revision_conflict" }));
      } else if (
        "runtime_revision" in detail &&
        (url.searchParams.get("expected_revision") !== "7" ||
          url.searchParams.get("expected_generation") !== "3" ||
          !url.searchParams.get("request_id"))
      ) {
        res.statusCode = 409;
        res.end(JSON.stringify({ detail: "client_upgrade_required" }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  // @lat: [[connections#Connections#Test specifications#Guarded Remote delete receipts]]
  it("deletes using authoritative counters as query parameters and a unique receipt", async () => {
    await remoteDeleteSession({ remoteUrl, apiKey: "test" }, "delete/id");
    await remoteDeleteSession({ remoteUrl, apiKey: "test" }, "delete/id");
    expect(requests.map((r) => [r.method, r.url.pathname])).toEqual([
      ["GET", "/api/sessions/delete%2Fid/mutation-snapshot"],
      ["DELETE", "/api/sessions/delete%2Fid"],
      ["GET", "/api/sessions/delete%2Fid/mutation-snapshot"],
      ["DELETE", "/api/sessions/delete%2Fid"],
    ]);
    expect(requests[1].url.searchParams.get("request_id")).not.toBe(
      requests[3].url.searchParams.get("request_id"),
    );
  });

  it("uses detail counters when an older revision-aware server lacks the snapshot route", async () => {
    snapshotStatus = 404;
    await remoteDeleteSession({ remoteUrl, apiKey: "test" }, "delete/id");
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET", "DELETE"]);
    expect(requests[2].url.searchParams.get("expected_revision")).toBe("7");
  });

  it("supports a legacy server only after verifying the exact detail identity", async () => {
    snapshotStatus = 404;
    detail = { id: "delete/id" };
    await remoteDeleteSession({ remoteUrl, apiKey: "test" }, "delete/id");
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET", "DELETE"]);
    expect(requests[2].url.search).toBe("");
  });

  it("does not downgrade a malformed modern detail to legacy deletion", async () => {
    snapshotStatus = 404;
    detail.runtime_revision = null;
    await expect(
      remoteDeleteSession({ remoteUrl, apiKey: "test" }, "delete/id"),
    ).rejects.toThrow("not deleted");
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET"]);
  });

  it("keeps preparation and deletion on the owning profile", async () => {
    await remoteDeleteSession(
      { remoteUrl, apiKey: "test", profile: "research" },
      "delete/id",
    );
    expect(
      requests.every((r) => r.url.searchParams.get("profile") === "research"),
    ).toBe(true);
  });

  it("does not mutate an already absent session", async () => {
    snapshot.exists = false;
    await remoteDeleteSession({ remoteUrl, apiKey: "test" }, "delete/id");
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
  });

  it.each([401, 403, 409, 500])(
    "never falls back after snapshot refusal %s",
    async (status) => {
      snapshotStatus = status;
      await expect(
        remoteDeleteSession({ remoteUrl, apiKey: "test" }, "delete/id"),
      ).rejects.toThrow(String(status));
      expect(requests.map((r) => r.method)).toEqual(["GET"]);
    },
  );

  it.each([
    { runtime_revision: -1 },
    { runtime_revision: "7" },
    { runtime_revision: 1.5 },
    { runtime_generation: -1 },
    { session_id: "another-session" },
    { exists: null },
  ])("refuses invalid snapshot %j before deleting", async (invalid) => {
    Object.assign(snapshot, invalid);
    await expect(
      remoteDeleteSession({ remoteUrl, apiKey: "test" }, "delete/id"),
    ).rejects.toThrow(/not deleted/);
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
  });

  it("surfaces a conflict without retrying or dropping the revision fence", async () => {
    refusal = 409;
    await expect(
      remoteDeleteSession({ remoteUrl, apiKey: "test" }, "delete/id"),
    ).rejects.toThrow("revision_conflict");
    expect(requests.map((r) => r.method)).toEqual(["GET", "DELETE"]);
  });

  it("reports each confirmed bulk deletion before a later preparation failure", async () => {
    const confirmed = vi.fn();
    await expect(
      remoteDeleteSessions(
        { remoteUrl, apiKey: "test" },
        ["delete/id", "untouched"],
        confirmed,
      ),
    ).rejects.toThrow("identity mismatch");
    expect(confirmed).toHaveBeenCalledExactlyOnceWith("delete/id");
  });

  it("stops bulk deletion at a refused session instead of reporting success", async () => {
    refusal = 403;
    await expect(
      remoteDeleteSessions({ remoteUrl, apiKey: "test" }, [
        "delete/id",
        "untouched",
      ]),
    ).rejects.toThrow("403");
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => !r.url.pathname.includes("untouched"))).toBe(
      true,
    );
  });
});
