import { beforeEach, describe, expect, it, vi } from "vitest";

const { probeResults, restartCalls } = vi.hoisted(() => ({
  // Queue of probe outcomes served to restartGatewayWhenIdle calls.
  probeResults: [] as Array<"busy" | "idle" | "unknown">,
  restartCalls: [] as Array<string | undefined>,
}));

vi.mock("../src/main/hermes", () => ({
  profileKey: (p?: string) => p ?? "default",
  probeGatewayLiveWork: vi.fn(async () => probeResults.shift() ?? "idle"),
  restartGateway: vi.fn(async (profile?: string) => {
    restartCalls.push(profile);
    return true;
  }),
}));

import {
  hasPendingDeferredRestart,
  restartGatewayWhenIdle,
} from "../src/main/gateway-restart-gate";

describe("restartGatewayWhenIdle (issue #128)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    probeResults.length = 0;
    restartCalls.length = 0;
  });

  it("restarts immediately when the gateway is idle", async () => {
    probeResults.push("idle");
    const outcome = await restartGatewayWhenIdle("work", "model → x");
    expect(outcome).toBe("restarted");
    expect(restartCalls).toEqual(["work"]);
    expect(hasPendingDeferredRestart("work")).toBe(false);
  });

  it("restarts immediately when the probe fails (fail open, legacy behavior)", async () => {
    probeResults.push("unknown");
    const outcome = await restartGatewayWhenIdle(undefined, "credential K");
    expect(outcome).toBe("restarted");
    expect(restartCalls).toEqual([undefined]);
  });

  it("defers the restart while work is in flight (no immediate kill)", async () => {
    probeResults.push("busy");
    const outcome = await restartGatewayWhenIdle("work", "model → x");
    expect(outcome).toBe("deferred");
    expect(restartCalls).toEqual([]);
    expect(hasPendingDeferredRestart("work")).toBe(true);
  });

  it("a second config change while waiting stays deferred without a second restart", async () => {
    probeResults.push("busy");
    await restartGatewayWhenIdle("work", "model → x");
    probeResults.push("busy");
    expect(await restartGatewayWhenIdle("work", "credential K")).toBe(
      "deferred",
    );
    expect(restartCalls).toEqual([]);
    expect(hasPendingDeferredRestart("work")).toBe(true);
  });

  it("defers per profile — another profile's restart is not blocked", async () => {
    probeResults.push("busy");
    await restartGatewayWhenIdle("work", "model → x");
    probeResults.push("idle");
    expect(await restartGatewayWhenIdle("home", "model → y")).toBe("restarted");
    expect(restartCalls).toEqual(["home"]);
    expect(hasPendingDeferredRestart("work")).toBe(true);
  });
});
