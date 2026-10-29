import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "../src/main/config";
import type { RegistryItem } from "../src/shared/registry";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  home: vi.fn(),
  invalidate: vi.fn(),
  folder: vi.fn(),
  text: vi.fn(),
  manifest: vi.fn(),
  list: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("../src/main/remote-api", () => ({
  remoteDashboardRequestJson: mocks.request,
}));
vi.mock("../src/main/remote-settings", () => ({
  remoteHome: mocks.home,
  remoteInvalidateSettingsCaches: mocks.invalidate,
}));
vi.mock("../src/main/registry", () => ({
  readVerifiedRegistryFolder: mocks.folder,
  readVerifiedRegistryText: mocks.text,
  fetchManifest: mocks.manifest,
  listFolderFiles: mocks.list,
  REGISTRY_RAW_BASE: "https://registry.invalid/main",
  renderMcpYaml: (id: string) => `  ${id}:\n    command: checked\n`,
}));
import { remoteInstallRegistryItem } from "../src/main/remote-registry";

const conn = {
  type: "remote",
  host: "https://server.invalid",
} as unknown as ConnectionConfig;
const item: RegistryItem = {
  id: "example",
  name: "Example",
  description: "fixture",
  path: "skills/tools/example",
  category: "tools",
};
function mutations(): typeof mocks.request.mock.calls {
  return mocks.request.mock.calls.filter(
    ([, , options]) => options?.method === "POST",
  );
}
function expectNoMutations(): void {
  expect(mutations()).toEqual([]);
  expect(mocks.invalidate).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.home.mockImplementation(
    async (_conn, profile) => `/server/${profile ?? "default"}`,
  );
  mocks.request.mockResolvedValue({});
  mocks.folder.mockResolvedValue([
    { relativePath: "SKILL.md", bytes: Buffer.from("verified ✓\n") },
  ]);
  mocks.list.mockResolvedValue([
    `${item.path}/SKILL.md`,
    `${item.path}/nested/late.md`,
  ]);
  mocks.fetch.mockResolvedValue({
    ok: true,
    text: async () => "unverified payload",
  });
  mocks.manifest.mockResolvedValue({ entry: "persona.md", command: "checked" });
  mocks.text.mockResolvedValue("verified persona ✓\n");
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("remote registry integrity", () => {
  it("does not write MCP config when manifest verification fails", async () => {
    mocks.manifest.mockRejectedValue(
      new Error("Registry integrity mismatch: manifest.json"),
    );
    expect(await remoteInstallRegistryItem(conn, "mcps", item, "work")).toEqual(
      {
        success: false,
        error: "Registry integrity mismatch: manifest.json",
      },
    );
    expectNoMutations();
    expect(mocks.home).not.toHaveBeenCalled();
  });
  it.each(["skills", "workflows"] as const)(
    "%s waits for the complete verified folder before its first mutation",
    async (kind) => {
      let finish!: (files: { relativePath: string; bytes: Buffer }[]) => void;
      const pending = new Promise<{ relativePath: string; bytes: Buffer }[]>(
        (resolve) => {
          finish = resolve;
        },
      );
      mocks.folder.mockReturnValue(pending);
      const installing = remoteInstallRegistryItem(conn, kind, item, "work");
      await vi.waitFor(() =>
        expect(mocks.folder).toHaveBeenCalledWith(item.path),
      );
      expectNoMutations();
      finish([
        { relativePath: "SKILL.md", bytes: Buffer.from("verified ✓\n") },
        {
          relativePath: "nested/deep/file.txt",
          bytes: Buffer.from("\uFEFF\uFFFD emoji 🚀\r\n"),
        },
        { relativePath: "nested/empty.txt", bytes: Buffer.alloc(0) },
      ]);
      expect(await installing).toEqual({ success: true });
      const base = `/server/work/${kind === "skills" ? "skills/tools" : "workflows"}/example`;
      expect(mutations()).toEqual([
        [
          conn,
          "/api/files/mkdir",
          { method: "POST", body: { path: base } },
          "work",
        ],
        [
          conn,
          "/api/files/mkdir",
          { method: "POST", body: { path: `${base}/nested` } },
          "work",
        ],
        [
          conn,
          "/api/files/mkdir",
          { method: "POST", body: { path: `${base}/nested/deep` } },
          "work",
        ],
        [
          conn,
          "/api/fs/write-text",
          {
            method: "POST",
            body: { path: `${base}/SKILL.md`, content: "verified ✓\n" },
          },
          "work",
        ],
        [
          conn,
          "/api/fs/write-text",
          {
            method: "POST",
            body: {
              path: `${base}/nested/deep/file.txt`,
              content: "\uFEFF\uFFFD emoji 🚀\r\n",
            },
          },
          "work",
        ],
        [
          conn,
          "/api/fs/write-text",
          {
            method: "POST",
            body: { path: `${base}/nested/empty.txt`, content: "" },
          },
          "work",
        ],
      ]);
      expect(mocks.home).toHaveBeenCalledWith(conn, "work");
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
    },
  );
  it("creates the agent globally but writes its verified persona in the new profile", async () => {
    expect(
      await remoteInstallRegistryItem(conn, "agents", item, "work"),
    ).toEqual({ success: true });
    expect(mocks.manifest).toHaveBeenCalledWith(item.path);
    expect(mocks.text).toHaveBeenCalledWith(`${item.path}/persona.md`);
    expect(mutations()).toEqual([
      [
        conn,
        "/api/profiles",
        {
          method: "POST",
          body: { name: "example", clone_from: "default", clone_all: false },
        },
        undefined,
      ],
      [
        conn,
        "/api/fs/write-text",
        {
          method: "POST",
          body: {
            path: "/server/example/SOUL.md",
            content: "verified persona ✓\n",
          },
        },
        "example",
      ],
    ]);
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.home).toHaveBeenCalledWith(conn, "example");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.text.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.request.mock.invocationCallOrder[0],
    );
    expect(mocks.request.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invalidate.mock.invocationCallOrder[0],
    );
  });
  it.each(["manifest", "persona"] as const)(
    "rejects corrupt agent %s before profile creation or settings invalidation",
    async (part) => {
      if (part === "manifest")
        mocks.manifest.mockRejectedValue(
          new Error("Registry integrity mismatch: manifest.json"),
        );
      else
        mocks.text.mockRejectedValue(
          new Error("Registry integrity mismatch: persona.md"),
        );
      const result = await remoteInstallRegistryItem(
        conn,
        "agents",
        item,
        "work",
      );
      expectNoMutations();
      expect(result).toEqual({
        success: false,
        error: `Registry integrity mismatch: ${part === "manifest" ? "manifest.json" : "persona.md"}`,
      });
    },
  );
  it("rejects a late binary file before mkdir or uploading an earlier text file", async () => {
    mocks.folder.mockResolvedValue([
      { relativePath: "SKILL.md", bytes: Buffer.from("safe text") },
      {
        relativePath: "assets/icon.png",
        bytes: Buffer.from([0x89, 0x50, 0xff]),
      },
    ]);
    const result = await remoteInstallRegistryItem(
      conn,
      "skills",
      item,
      "work",
    );
    expectNoMutations();
    expect(result).toEqual({
      success: false,
      error:
        "Remote text API cannot losslessly upload non-UTF-8 file: assets/icon.png",
    });
  });
  it.each(["skills", "workflows"] as const)(
    "%s rejects a late corrupt folder file before any remote mutation",
    async (kind) => {
      mocks.folder.mockRejectedValue(
        new Error("Registry integrity mismatch: nested/late.md"),
      );
      const result = await remoteInstallRegistryItem(conn, kind, item, "work");
      expectNoMutations();
      expect(result).toEqual({
        success: false,
        error: "Registry integrity mismatch: nested/late.md",
      });
    },
  );
});

describe("remote registry result and routing contracts", () => {
  it("keeps bundled skill installation on the profile-scoped hub endpoint", async () => {
    expect(
      await remoteInstallRegistryItem(
        conn,
        "skills",
        { ...item, path: undefined, source: "hub:example" },
        "work",
      ),
    ).toEqual({ success: true });
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
      conn,
      "/api/skills/hub/install",
      {
        method: "POST",
        body: { identifier: "hub:example", profile: "work" },
      },
      "work",
    );
    expect(mocks.folder).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it("returns an empty-folder error without remote mutations", async () => {
    mocks.folder.mockResolvedValue([]);
    expect(
      await remoteInstallRegistryItem(conn, "skills", item, "work"),
    ).toEqual({ success: false, error: "No files found for this entry" });
    expectNoMutations();
  });
  it("preserves profile-scoped MCP config text and appends the verified server", async () => {
    mocks.request.mockResolvedValue({
      text: "model: original\nmcp_servers:\n  existing:\n    command: old\n",
    });
    expect(await remoteInstallRegistryItem(conn, "mcps", item, "work")).toEqual(
      { success: true },
    );
    expect(mocks.request).toHaveBeenCalledWith(
      conn,
      "/api/fs/read-text?path=%2Fserver%2Fwork%2Fconfig.yaml",
      {},
      "work",
    );
    expect(mutations()).toEqual([
      [
        conn,
        "/api/fs/write-text",
        {
          method: "POST",
          body: {
            path: "/server/work/config.yaml",
            content:
              "model: original\nmcp_servers:\n  example:\n    command: checked\n  existing:\n    command: old\n",
          },
        },
        "work",
      ],
    ]);
    expect(mocks.manifest).toHaveBeenCalledWith(item.path);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it("returns Already configured without overwriting MCP config", async () => {
    mocks.request.mockResolvedValue({
      text: "mcp_servers:\n  example:\n    command: existing\n",
    });
    expect(await remoteInstallRegistryItem(conn, "mcps", item, "work")).toEqual(
      { success: false, error: "Already configured" },
    );
    expectNoMutations();
  });
  it("rejects MCP manifests without a connection config", async () => {
    mocks.manifest.mockResolvedValue({});
    expect(await remoteInstallRegistryItem(conn, "mcps", item, "work")).toEqual(
      { success: false, error: "MCP manifest has no connection config" },
    );
    expectNoMutations();
  });
  it("returns remote upload errors unchanged even when mkdir failed", async () => {
    mocks.request.mockRejectedValue(new Error("permission denied"));
    expect(
      await remoteInstallRegistryItem(conn, "skills", item, "work"),
    ).toEqual({ success: false, error: "permission denied" });
    expect(mutations().map((call) => call[1])).toEqual([
      "/api/files/mkdir",
      "/api/fs/write-text",
    ]);
  });
  it("does not invalidate settings after a failed profile creation", async () => {
    mocks.request.mockRejectedValue(new Error("profile already exists"));
    expect(
      await remoteInstallRegistryItem(conn, "agents", item, "work"),
    ).toEqual({ success: false, error: "profile already exists" });
    expect(mutations()).toHaveLength(1);
    expect(mocks.home).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it("keeps settings invalidation after profile creation even if writing SOUL fails", async () => {
    mocks.request.mockImplementation(async (_conn, path) => {
      if (path === "/api/fs/write-text")
        throw new Error("persona write denied");
      return {};
    });
    expect(
      await remoteInstallRegistryItem(conn, "agents", item, "work"),
    ).toEqual({ success: false, error: "persona write denied" });
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });
  it("uses the default agent entry when a verified manifest has no entry", async () => {
    mocks.manifest.mockResolvedValue({});
    expect(
      await remoteInstallRegistryItem(conn, "agents", item, "work"),
    ).toEqual({ success: true });
    expect(mocks.text).toHaveBeenCalledWith(`${item.path}/AGENT.md`);
  });
  it("preserves blank-persona behavior without a SOUL write", async () => {
    mocks.text.mockResolvedValue(" \n");
    expect(
      await remoteInstallRegistryItem(conn, "agents", item, "work"),
    ).toEqual({ success: true });
    expect(mutations().map((call) => call[1])).toEqual(["/api/profiles"]);
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });
  it("preserves pathless agent cloning without registry reads", async () => {
    expect(
      await remoteInstallRegistryItem(
        conn,
        "agents",
        { ...item, path: undefined },
        "work",
      ),
    ).toEqual({ success: true });
    expect(mocks.manifest).not.toHaveBeenCalled();
    expect(mocks.text).not.toHaveBeenCalled();
    expect(mutations().map((call) => call[1])).toEqual(["/api/profiles"]);
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });
});
