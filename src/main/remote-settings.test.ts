import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors remote-api.test.ts: the HTTP boundary (remote-api / remote-sessions /
// remote-metadata) is mocked; what we assert is WHICH routes the settings
// remotes call and how they normalize responses — the IPC contract the
// register.ts remote branches rely on (issue #51).

const { remoteDashboardRequestJson, remoteGetHermesHome } = vi.hoisted(() => ({
  remoteDashboardRequestJson: vi.fn(),
  remoteGetHermesHome: vi.fn(),
}));

vi.mock("./remote-api", () => ({ remoteDashboardRequestJson }));
vi.mock("./remote-sessions", () => ({ remoteRequestJson: vi.fn() }));
vi.mock("./remote-metadata", () => ({ remoteGetHermesHome }));

import type { ConnectionConfig } from "./config";
import {
  remoteReadMemory,
  remoteAddMemoryEntry,
  remoteReadSoul,
  remoteResetSoul,
  remoteGetToolsets,
  remoteSetToolsetEnabled,
  remoteReadLogs,
  remoteGatewayStatus,
  remoteListProfiles,
  remoteGetConfigValue,
  remoteReadEnv,
  remoteDiscoverMemoryProviders,
  remoteInvalidateSettingsCaches,
} from "./remote-settings";

function remoteConnection(): ConnectionConfig {
  return {
    mode: "remote",
    remoteUrl: "http://remote.example:9119",
    apiKey: "token",
    remoteAuthMode: "token",
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
  };
}

const HOME = "/home/hermes/.hermes";

function fsText(url: string, text: string): void {
  remoteDashboardRequestJson.mockImplementation(
    async (_conn: unknown, path: string) => {
      if (path.startsWith("/api/fs/read-text")) {
        expect(path).toContain(encodeURIComponent(url));
        return { text };
      }
      throw new Error(`unexpected route in fs mock: ${path}`);
    },
  );
}

beforeEach(() => {
  remoteDashboardRequestJson.mockReset();
  remoteGetHermesHome.mockReset();
  remoteGetHermesHome.mockResolvedValue(HOME);
  remoteInvalidateSettingsCaches();
});

describe("remote memory", () => {
  it("reads MEMORY.md/USER.md/config.yaml from the server's home", async () => {
    remoteDashboardRequestJson.mockImplementation(
      async (_c: unknown, path: string) => {
        if (path === "/api/status") return { active_sessions: 7 };
        if (path.startsWith("/api/fs/read-text")) {
          if (path.includes(encodeURIComponent(`${HOME}/memories/MEMORY.md`)))
            return { text: "entry one\n§\nentry two" };
          if (path.includes(encodeURIComponent(`${HOME}/memories/USER.md`)))
            return { text: "user profile" };
          if (path.includes(encodeURIComponent(`${HOME}/config.yaml`)))
            return { text: "memory:\n  char_limit: 5000\n" };
          throw new Error(`unexpected: ${path}`);
        }
        throw new Error(`unexpected: ${path}`);
      },
    );

    const info = await remoteReadMemory(remoteConnection());
    expect(info.memory.entries.map((e) => e.content)).toEqual([
      "entry one",
      "entry two",
    ]);
    expect(info.user.content).toBe("user profile");
    expect(info.stats.totalSessions).toBe(7);
  });

  it("treats a missing USER.md as empty, not an error", async () => {
    remoteDashboardRequestJson.mockImplementation(
      async (_c: unknown, path: string) => {
        if (path === "/api/status") return { active_sessions: 0 };
        if (path.startsWith("/api/fs/read-text")) {
          if (path.includes("MEMORY.md"))
            return { text: "only memory entry" };
          if (path.includes("USER.md"))
            throw new Error("404: File not found");
          if (path.includes("config.yaml")) return { text: "" };
          throw new Error(`unexpected: ${path}`);
        }
        throw new Error(`unexpected: ${path}`);
      },
    );
    const info = await remoteReadMemory(remoteConnection());
    expect(info.memory.entries.map((e) => e.content)).toEqual([
      "only memory entry",
    ]);
    expect(info.user.exists).toBe(false);
    expect(info.user.content).toBe("");
  });

  it("round-trips an added entry through write-text", async () => {
    const writes: string[] = [];
    remoteDashboardRequestJson.mockImplementation(
      async (_c: unknown, path: string, options?: { body?: { content?: string } }) => {
        if (path.startsWith("/api/fs/read-text")) {
          if (path.includes("MEMORY.md")) return { text: "existing" };
          if (path.includes("config.yaml")) return { text: "" };
          throw new Error(`unexpected: ${path}`);
        }
        if (path === "/api/fs/write-text") {
          writes.push(options?.body?.content ?? "");
          return {};
        }
        throw new Error(`unexpected: ${path}`);
      },
    );

    const result = await remoteAddMemoryEntry(
      remoteConnection(),
      "  new entry  ",
    );
    expect(result.success).toBe(true);
    expect(writes).toEqual(["existing\n§\nnew entry"]);
  });
});

describe("remote soul", () => {
  it("prefers the profile soul route over raw fs", async () => {
    remoteDashboardRequestJson.mockResolvedValue({ content: "SOUL TEXT" });
    await expect(remoteReadSoul(remoteConnection())).resolves.toBe("SOUL TEXT");
    expect(remoteDashboardRequestJson).toHaveBeenCalledWith(
      expect.anything(),
      "/api/profiles/default/soul",
      {},
      undefined,
    );
  });

  it("falls back to fs read when the soul route is unavailable", async () => {
    remoteDashboardRequestJson.mockImplementation(
      async (_c: unknown, path: string) => {
        if (path.includes("/soul")) throw new Error("404");
        if (path.startsWith("/api/fs/read-text"))
          return { text: "FILE SOUL" };
        throw new Error(`unexpected: ${path}`);
      },
    );
    await expect(remoteReadSoul(remoteConnection())).resolves.toBe("FILE SOUL");
  });

  it("reset restores the shipped default", async () => {
    const puts: string[] = [];
    remoteDashboardRequestJson.mockImplementation(
      async (_c: unknown, path: string, options?: { body?: { content?: string } }) => {
        if (path.endsWith("/soul")) {
          puts.push(options?.body?.content ?? "");
          return {};
        }
        throw new Error(`unexpected: ${path}`);
      },
    );
    const content = await remoteResetSoul(remoteConnection());
    expect(content).toContain("You are Hermes");
    expect(puts[0]).toBe(content);
  });
});

describe("remote toolsets", () => {
  it("maps dashboard toolset rows onto ToolsetInfo", async () => {
    remoteDashboardRequestJson.mockResolvedValue([
      { name: "browser", label: "Browser", description: "d", enabled: true },
      { name: "media", label: "Media", description: "", available: false },
    ]);
    const toolsets = await remoteGetToolsets(remoteConnection());
    expect(toolsets).toEqual([
      { key: "browser", label: "Browser", description: "d", enabled: true },
      { key: "media", label: "Media", description: "", enabled: false },
    ]);
  });

  it("toggles via PUT /api/tools/toolsets/{name}", async () => {
    remoteDashboardRequestJson.mockResolvedValue({ ok: true });
    await expect(
      remoteSetToolsetEnabled(remoteConnection(), "browser", false),
    ).resolves.toBe(true);
    expect(remoteDashboardRequestJson).toHaveBeenCalledWith(
      expect.anything(),
      "/api/tools/toolsets/browser",
      { method: "PUT", body: { enabled: false } },
      undefined,
    );
  });
});

describe("remote logs", () => {
  it("joins the dashboard's line rows", async () => {
    remoteDashboardRequestJson.mockResolvedValue({
      file: "agent",
      lines: ["line1", "line2"],
    });
    const result = await remoteReadLogs(remoteConnection(), "agent", 50);
    expect(result.content).toBe("line1\nline2");
    expect(result.path).toBe("remote:agent");
  });
});

describe("remote gateway", () => {
  it("maps /api/status gateway_running to a boolean", async () => {
    remoteDashboardRequestJson.mockResolvedValue({ gateway_running: true });
    await expect(remoteGatewayStatus(remoteConnection())).resolves.toBe(true);
  });
});

describe("remote profiles", () => {
  it("maps the dashboard profile payload", async () => {
    remoteDashboardRequestJson.mockResolvedValue({
      profiles: [
        {
          name: "default",
          path: HOME,
          is_default: true,
          model: "glm-5.3",
          provider: "zai",
          has_env: true,
          skill_count: 3,
          gateway_running: true,
        },
      ],
    });
    const profiles = await remoteListProfiles(remoteConnection());
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      id: "default",
      isDefault: true,
      model: "glm-5.3",
      gatewayRunning: true,
    });
  });
});

describe("remote config/env", () => {
  it("reads a dotted key from the raw config.yaml", async () => {
    fsText(
      `${HOME}/config.yaml`,
      "model:\n  provider: zai\n  default: glm-5.3\n",
    );
    await expect(
      remoteGetConfigValue(remoteConnection(), "model.provider"),
    ).resolves.toBe("zai");
  });

  it("parses the remote .env like the local reader", async () => {
    fsText(`${HOME}/.env`, '# comment\nZAI_API_KEY="sk-test"\nEMPTY=');
    const env = await remoteReadEnv(remoteConnection());
    expect(env.ZAI_API_KEY).toBe("sk-test");
    expect(env.EMPTY).toBeUndefined();
  });
});

describe("remote memory providers", () => {
  it("maps /api/memory statuses with the active flag", async () => {
    remoteDashboardRequestJson.mockResolvedValue({
      active: "builtin",
      providers: {
        statuses: [
          { name: "builtin", available: true },
          { name: "honcho", status: "unavailable" },
        ],
      },
    });
    const providers = await remoteDiscoverMemoryProviders(
      remoteConnection(),
    );
    expect(providers.map((p) => [p.name, p.active])).toEqual([
      ["builtin", true],
      ["honcho", false],
    ]);
  });
});
