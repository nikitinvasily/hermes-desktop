import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "../src/main/config";
import {
  remoteAddModel,
  remoteGetModelConfig,
  remoteListModels,
  remoteRemoveModel,
  remoteUpdateModel,
} from "../src/main/remote-models";

const transport = vi.hoisted(() => ({ dashboard: vi.fn(), token: vi.fn() }));
vi.mock("../src/main/remote-api", () => ({
  remoteDashboardRequestJson: transport.dashboard,
}));
vi.mock("../src/main/remote-sessions", () => ({
  remoteRequestJson: transport.token,
}));

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function connection(): ConnectionConfig & { profile: string } {
  return {
    mode: "remote",
    remoteUrl: "https://models.example",
    apiKey: randomUUID(),
    remoteAuthMode: "oauth",
    remoteChatTransport: "auto",
    sshChatTransport: "auto",
    ssh: {
      host: "",
      port: 22,
      username: "",
      keyPath: "",
      remotePort: 9119,
      localPort: 9119,
    },
    profile: "research",
  };
}

const active = {
  id: "remote:active:custom:marker",
  name: "Marker",
  provider: "custom",
  model: "marker",
  baseUrl: "",
  createdAt: 0,
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("in-flight remote model reads", () => {
  it("shares concurrent library and fallback options reads, then fetches fresh", async () => {
    const config = connection();
    const library = deferred<unknown>();
    const options = deferred<unknown>();
    transport.dashboard.mockImplementation((_config, path: string) =>
      path.endsWith("library") ? library.promise : options.promise,
    );
    const current = remoteGetModelConfig(config);
    const models = remoteListModels({ ...config });
    expect(transport.dashboard).toHaveBeenCalledTimes(1);
    library.reject(new Error("404 missing library"));
    await vi.waitFor(() => {
      expect(transport.dashboard).toHaveBeenCalledTimes(2);
    });
    options.resolve({ provider: "custom", model: "marker" });
    await expect(current).resolves.toMatchObject({ model: "marker" });
    await expect(models).resolves.toHaveLength(1);
    transport.dashboard.mockResolvedValue({
      models: [{ ...active, model: "fresh" }],
    });
    await expect(remoteGetModelConfig(config)).resolves.toMatchObject({
      model: "fresh",
    });
    expect(transport.dashboard).toHaveBeenCalledTimes(3);
  });

  it("shares successful libraries across equivalent configs regardless of key order", async () => {
    const config = connection();
    const response = deferred<unknown>();
    transport.dashboard.mockReturnValue(response.promise);
    const reordered = Object.fromEntries(
      Object.entries(config).reverse(),
    ) as typeof config;
    const current = remoteGetModelConfig(config);
    const models = remoteListModels(reordered);
    expect(transport.dashboard).toHaveBeenCalledTimes(1);
    expect(transport.dashboard).toHaveBeenCalledWith(
      config,
      "/api/model/library",
      { timeoutMs: 20_000 },
      config.profile,
    );
    response.resolve({ models: [active] });
    await expect(current).resolves.toMatchObject({ model: active.model });
    await expect(models).resolves.toEqual([active]);
  });

  it.each([
    "apiKey",
    "profile",
    "remoteUrl",
    "remoteAuthMode",
    "mode",
    "ssh",
  ] as const)("isolates different %s configurations", async (field) => {
    const config = connection();
    const other = { ...config };
    switch (field) {
      case "apiKey":
        other.apiKey = randomUUID();
        break;
      case "profile":
        other.profile = "other";
        break;
      case "remoteUrl":
        other.remoteUrl = "https://other.example";
        break;
      case "remoteAuthMode":
        other.remoteAuthMode = "token";
        break;
      case "mode":
        other.mode = "ssh";
        break;
      case "ssh":
        other.ssh = { ...config.ssh, host: "other.example" };
        break;
    }
    const response = deferred<unknown>();
    transport.dashboard.mockReturnValue(response.promise);
    const reads = [remoteListModels(config), remoteListModels(other)];
    expect(transport.dashboard).toHaveBeenCalledTimes(2);
    response.resolve({ models: [active] });
    await Promise.all(reads);
  });

  it("evicts failed options and library reads without an unhandled cleanup rejection", async () => {
    const config = connection();
    const library = deferred<unknown>();
    const options = deferred<unknown>();
    const error = new Error("read failed");
    transport.dashboard.mockImplementation((_config, path: string) =>
      path.endsWith("library") ? library.promise : options.promise,
    );
    const results = Promise.allSettled([
      remoteGetModelConfig(config),
      remoteListModels(config),
    ]);
    library.reject(error);
    await vi.waitFor(() => {
      expect(transport.dashboard).toHaveBeenCalledTimes(2);
    });
    options.reject(error);
    expect(await results).toEqual([
      { status: "rejected", reason: error },
      { status: "rejected", reason: error },
    ]);
    transport.dashboard.mockImplementation(async (_config, path: string) => {
      if (path.endsWith("library")) throw error;
      return { provider: "custom", model: "recovered" };
    });
    await expect(remoteGetModelConfig(config)).resolves.toMatchObject({
      model: "recovered",
    });
    expect(transport.dashboard).toHaveBeenCalledTimes(4);
  });

  it("keeps legacy SSH token reads separate from dashboard requests", async () => {
    const config = connection();
    const legacy = {
      remoteUrl: config.remoteUrl,
      apiKey: config.apiKey,
      profile: config.profile,
    };
    const response = deferred<unknown>();
    transport.dashboard.mockReturnValue(response.promise);
    transport.token.mockReturnValue(response.promise);
    const reads = [
      remoteListModels(config),
      remoteListModels(legacy),
      remoteGetModelConfig({ ...legacy }),
    ];
    expect(transport.dashboard).toHaveBeenCalledTimes(1);
    expect(transport.token).toHaveBeenCalledExactlyOnceWith(
      legacy,
      "/api/model/library",
      { timeoutMs: 20_000 },
    );
    response.resolve({ models: [active] });
    await Promise.all(reads);
  });

  it("never shares POST, PATCH or DELETE writes, including with a pending GET", async () => {
    const config = connection();
    const response = deferred<unknown>();
    transport.dashboard.mockReturnValue(response.promise);
    const requests = [
      remoteListModels(config),
      remoteAddModel(config, "Marker", "custom", "marker", ""),
      remoteAddModel(config, "Marker", "custom", "marker", ""),
      remoteUpdateModel(config, "row", { name: "changed" }),
      remoteUpdateModel(config, "row", { name: "changed" }),
      remoteRemoveModel(config, "row"),
      remoteRemoveModel(config, "row"),
    ];
    expect(transport.dashboard).toHaveBeenCalledTimes(7);
    response.resolve({ ...active, models: [active], ok: true });
    await Promise.all(requests);
  });
});
