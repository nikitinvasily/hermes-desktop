import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "../src/main/config";
import {
  remoteGetModelConfig,
  remoteListModels,
} from "../src/main/remote-models";
import { RemoteOAuthError } from "../src/main/remote-oauth";

const transport = vi.hoisted(() => ({
  probe: vi.fn(),
  oauth: vi.fn(),
  token: vi.fn(),
}));

vi.mock("../src/main/remote-oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/remote-oauth")>()),
  probeRemoteAuthMode: transport.probe,
  requestRemoteOAuthJson: transport.oauth,
}));
vi.mock("../src/main/remote-sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/remote-sessions")>()),
  remoteRequestJson: transport.token,
}));
vi.mock("../src/main/remote-health", () => ({
  reportRemoteHealth: vi.fn(),
  reportRemoteHealthOk: vi.fn(),
}));

function connection(
  remoteAuthMode: ConnectionConfig["remoteAuthMode"],
): ConnectionConfig & { profile: string } {
  return {
    mode: "remote",
    remoteUrl: "https://models.example/v1",
    apiKey: "",
    remoteAuthMode,
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
    profile: "research team",
  };
}

const active = {
  id: "remote:active:custom:marker-model",
  name: "Marker",
  provider: "custom",
  model: "marker-model",
  baseUrl: "https://inference.example/v1",
  contextLength: 123456,
  createdAt: 0,
};

beforeEach(() => {
  vi.resetAllMocks();
  transport.probe.mockResolvedValue({ authMode: "oauth" });
  transport.token.mockRejectedValue(
    new Error("token transport cannot authenticate"),
  );
});

describe.each(["auto", "oauth"] as const)("direct %s model reads", (mode) => {
  it("reads the profiled current model from the authenticated library", async () => {
    transport.oauth.mockResolvedValue({ models: [active] });
    await expect(remoteGetModelConfig(connection(mode))).resolves.toEqual({
      provider: active.provider,
      model: active.model,
      baseUrl: active.baseUrl,
      contextLength: active.contextLength,
    });
    expect(transport.oauth).toHaveBeenCalledExactlyOnceWith(
      "https://models.example/api/model/library?profile=research+team",
      { timeoutMs: 20_000 },
    );
    expect(transport.token).not.toHaveBeenCalled();
    if (mode === "auto") {
      expect(transport.probe).toHaveBeenCalledWith("https://models.example/v1");
    } else {
      expect(transport.probe).not.toHaveBeenCalled();
    }
  });

  it("lists the profiled authenticated library without flattening options", async () => {
    transport.oauth.mockResolvedValue({ models: [active] });
    await expect(remoteListModels(connection(mode))).resolves.toEqual([active]);
    expect(transport.oauth).toHaveBeenCalledExactlyOnceWith(
      "https://models.example/api/model/library?profile=research+team",
      { timeoutMs: 20_000 },
    );
    expect(transport.token).not.toHaveBeenCalled();
  });

  it("keeps profile and authentication on legacy options fallback", async () => {
    transport.oauth.mockRejectedValueOnce(new Error("404: missing library"));
    transport.oauth.mockResolvedValue({
      provider: "custom",
      model: "legacy-marker",
      providers: [{ slug: "custom", api_url: "https://legacy.example/v1" }],
    });
    await expect(remoteGetModelConfig(connection(mode))).resolves.toEqual({
      provider: "custom",
      model: "legacy-marker",
      baseUrl: "https://legacy.example/v1",
    });
    expect(transport.oauth).toHaveBeenLastCalledWith(
      "https://models.example/api/model/options?profile=research+team",
      { timeoutMs: 60_000 },
    );
    expect(transport.token).not.toHaveBeenCalled();
  });

  it.each([
    ["current config", remoteGetModelConfig],
    ["library", remoteListModels],
  ] as const)("preserves OAuth login errors for %s", async (_label, read) => {
    const error = new RemoteOAuthError(
      "Sign in again",
      "oauth_login_required",
      401,
    );
    transport.oauth.mockRejectedValue(error);
    await expect(read(connection(mode))).rejects.toBe(error);
    expect(transport.token).not.toHaveBeenCalled();
  });
});

it("preserves direct auto-token profile on both library and options", async () => {
  transport.probe.mockResolvedValue({ authMode: "token" });
  transport.token.mockRejectedValueOnce(new Error("404: missing library"));
  transport.token.mockResolvedValue({ provider: "zai", model: "token-marker" });
  const config = { ...connection("auto"), apiKey: "test-token" };
  await expect(remoteGetModelConfig(config)).resolves.toEqual({
    provider: "zai",
    model: "token-marker",
    baseUrl: "",
  });
  for (const path of ["/api/model/library", "/api/model/options"]) {
    expect(transport.token).toHaveBeenCalledWith(
      {
        remoteUrl: config.remoteUrl,
        apiKey: config.apiKey,
        profile: config.profile,
      },
      path,
      { timeoutMs: path.endsWith("library") ? 20_000 : 60_000 },
    );
  }
  expect(transport.oauth).not.toHaveBeenCalled();
});

it("keeps SSH session configs on token transport with profile intact", async () => {
  transport.token.mockResolvedValue({ models: [active] });
  const config = {
    remoteUrl: "http://127.0.0.1:9119",
    apiKey: "ssh-token",
    profile: "ssh-profile",
  };
  await expect(remoteListModels(config)).resolves.toEqual([active]);
  expect(transport.token).toHaveBeenCalledExactlyOnceWith(
    config,
    "/api/model/library",
    { timeoutMs: 20_000 },
  );
  expect(transport.probe).not.toHaveBeenCalled();
  expect(transport.oauth).not.toHaveBeenCalled();
});
