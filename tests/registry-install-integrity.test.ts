// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join, basename } from "path";
import { tmpdir } from "os";

const stores = vi.hoisted(() => ({
  write: vi.fn(),
  create: vi.fn(() => ({ success: true })),
  soul: vi.fn(() => true),
}));
vi.mock("../src/main/utils", () => ({
  profileHome: () => "/fixture/profile",
  safeWriteFile: stores.write,
}));
vi.mock("../src/main/skills", () => ({
  installSkill: vi.fn(),
  listInstalledSkills: () => [],
}));
vi.mock("../src/main/profiles", () => ({ createProfile: stores.create }));
vi.mock("../src/main/soul", () => ({ writeSoul: stores.soul }));
vi.mock("../src/main/installer", () => ({ listMcpServers: () => [] }));
afterEach(() => {
  vi.doUnmock("../src/main/registry-integrity");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  stores.write.mockReset();
  vi.resetModules();
});

it("does not expose catalog entries before authenticating the recursive tree", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0]) =>
      String(input).includes("api.github.com")
        ? Response.json({ truncated: true, tree: [] })
        : Response.json({
            entries: [{ id: "unverified", type: "agent", name: "Unverified" }],
          }),
    ),
  );
  const { fetchRegistry } = await import("../src/main/registry");
  const result = await fetchRegistry(true);
  expect(result.agents).toEqual([]);
  expect(result.error).toContain("incomplete");
  expect(stores.write).not.toHaveBeenCalled();
});

async function fixture(
  corruptPath?: string,
  unavailablePath?: string,
  manifest = '{"entry":"AGENT.md","command":"safe"}',
  persona = "Reviewed persona\n",
): Promise<{
  registry: typeof import("../src/main/registry");
  payloads: Map<string, Buffer>;
  request: ReturnType<typeof vi.fn<typeof fetch>>;
}> {
  const integrity = await import("../src/main/registry-integrity");
  const payloads = new Map<string, Buffer>([
    ["entry/AGENT.md", Buffer.from(persona)],
    ["entry/manifest.json", Buffer.from(manifest)],
    ["entry/z.bin", Buffer.from([0, 255, 128, 13, 10, 195, 40])],
  ]);
  const blobs = [...payloads].map(([path, bytes]) => ({
    path,
    type: "blob",
    mode: "100644",
    sha: integrity.gitObjectHash("blob", bytes),
  }));
  const folder = integrity.gitObjectHash(
    "tree",
    Buffer.concat(
      blobs.map((e) =>
        Buffer.concat([
          Buffer.from(`100644 ${e.path.slice(6)}\0`),
          Buffer.from(e.sha, "hex"),
        ]),
      ),
    ),
  );
  const root = integrity.gitObjectHash(
    "tree",
    Buffer.concat([Buffer.from("40000 entry\0"), Buffer.from(folder, "hex")]),
  );
  const request = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("api.github.com"))
      return Response.json({
        truncated: false,
        tree: [
          { path: "entry", type: "tree", mode: "040000", sha: folder },
          ...blobs,
        ],
      });
    const path = "entry/" + url.split("/").at(-1);
    if (path === unavailablePath)
      return new Response("Unavailable", { status: 503 });
    return new Response(
      new Uint8Array(
        path === corruptPath
          ? Buffer.from("modified")
          : (payloads.get(path) ?? []),
      ),
    );
  });
  vi.stubGlobal("fetch", request);
  const snapshot = new integrity.VerifiedRegistrySnapshot(
    "a".repeat(40),
    root,
    request,
  );
  vi.doMock("../src/main/registry-integrity", () => ({
    ...integrity,
    registrySnapshot: snapshot,
  }));
  return { registry: await import("../src/main/registry"), payloads, request };
}

it("authenticates every workflow payload before the first local write", async () => {
  const { registry } = await fixture("entry/z.bin");
  const result = await registry.installRegistryItem(
    "workflows",
    { id: "fixture", name: "Fixture", description: "", path: "entry" },
    "target",
  );
  expect(result.success).toBe(false);
  expect(result.error).toContain("checksum mismatch");
  expect(stores.write).not.toHaveBeenCalled();
});

it.each(["entry/manifest.json", "entry/AGENT.md"])(
  "does not create an agent profile before verifying %s",
  async (path) => {
    const { registry } = await fixture(path);
    const result = await registry.installRegistryItem("agents", {
      id: "fixture",
      name: "Fixture",
      description: "",
      path: "entry",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("checksum mismatch");
    expect(stores.create).not.toHaveBeenCalled();
    expect(stores.soul).not.toHaveBeenCalled();
  },
);

it("never displays corrupted agent documentation", async () => {
  const { registry } = await fixture("entry/AGENT.md");
  await expect(
    registry.fetchRegistryDetail("agents", {
      id: "fixture",
      name: "Fixture",
      description: "",
      path: "entry",
    }),
  ).rejects.toThrow("checksum mismatch");
});

it("does not expose model providers before authenticating their bytes", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0]) =>
      String(input).includes("api.github.com")
        ? Response.json({ truncated: true, tree: [] })
        : Response.json({ providers: [{ id: "unverified" }] }),
    ),
  );
  const { fetchModelRegistry } = await import("../src/main/registry");
  const result = await fetchModelRegistry(true);
  expect(result.providers).toEqual([]);
  expect(result.error).toContain("incomplete");
});

it.each(["null", "[]", "42", '{"entry":42}', '{"args":"unsafe"}'])(
  "rejects a present but invalid manifest %s instead of treating it as absence",
  async (manifest) => {
    const { registry } = await fixture(undefined, undefined, manifest);
    await expect(registry.fetchManifest("entry")).rejects.toThrow(
      "Invalid registry manifest",
    );
  },
);

it("exports verified folder bytes and text for the remote registry adapter", async () => {
  const { registry, payloads } = await fixture();
  expect(registry.readVerifiedRegistryFolder).toBeTypeOf("function");
  expect(registry.readVerifiedRegistryText).toBeTypeOf("function");
  const files = await registry.readVerifiedRegistryFolder("entry");
  expect(files.find((f) => f.relativePath === "z.bin")?.bytes).toEqual(
    payloads.get("entry/z.bin"),
  );
  expect(await registry.readVerifiedRegistryText("entry/AGENT.md")).toBe(
    "Reviewed persona\n",
  );
});

it.each(["skills", "workflows"] as const)(
  "preserves binary payload bytes through the real local %s writer",
  async (kind) => {
    const { registry, payloads, request } = await fixture();
    const { safeWriteFile } =
      await vi.importActual<typeof import("../src/main/utils")>(
        "../src/main/utils",
      );
    const dir = mkdtempSync(join(tmpdir(), "registry-binary-"));
    stores.write.mockImplementation((path: string, bytes: Buffer) =>
      safeWriteFile(join(dir, basename(path)), bytes),
    );
    try {
      const result = await registry.installRegistryItem(
        kind,
        {
          id: "fixture",
          category: "category",
          name: "Fixture",
          description: "",
          path: "entry",
        },
        "named",
      );
      expect(result).toEqual({ success: true });
      expect(readFileSync(join(dir, "z.bin"))).toEqual(
        payloads.get("entry/z.bin"),
      );
      expect(stores.write).toHaveBeenCalledTimes(3);
      expect(
        request.mock.calls.every(([url]) =>
          String(url).includes("a".repeat(40)),
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it.each(["entry/manifest.json", "entry/AGENT.md"])(
  "does not create a profile if %s is unavailable",
  async (path) => {
    const { registry } = await fixture(undefined, path);
    expect(
      (
        await registry.installRegistryItem("agents", {
          id: "fixture",
          name: "Fixture",
          description: "",
          path: "entry",
        })
      ).success,
    ).toBe(false);
    expect(stores.create).not.toHaveBeenCalled();
  },
);

it("propagates a manifest network failure instead of returning null", async () => {
  const { registry } = await fixture(undefined, "entry/manifest.json");
  await expect(registry.fetchManifest("entry")).rejects.toThrow("503");
});

it("returns null for a manifest only when the verified tree proves absence", async () => {
  const { registry, request } = await fixture();
  expect(await registry.fetchManifest("missing")).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});

it("preserves cloning and persona behavior for a verified agent", async () => {
  const { registry } = await fixture();
  expect(
    (
      await registry.installRegistryItem("agents", {
        id: "fixture",
        name: "Fixture",
        description: "",
        path: "entry",
      })
    ).success,
  ).toBe(true);
  expect(stores.create).toHaveBeenCalledWith("fixture", "default");
  expect(stores.soul).toHaveBeenCalledWith("Reviewed persona\n", "fixture");
});

it("never writes MCP config from a corrupt manifest", async () => {
  const { registry } = await fixture("entry/manifest.json");
  expect(
    (
      await registry.installRegistryItem("mcps", {
        id: "fixture",
        name: "Fixture",
        description: "",
        path: "entry",
      })
    ).success,
  ).toBe(false);
  expect(stores.write).not.toHaveBeenCalled();
});

it("refuses an agent without a reviewed source path before cloning", async () => {
  const { registry } = await fixture();
  expect(
    await registry.installRegistryItem("agents", {
      id: "fixture",
      name: "Fixture",
      description: "",
    }),
  ).toEqual({ success: false, error: "Agent entry has no path" });
  expect(stores.create).not.toHaveBeenCalled();
});

it.each(["", " \n\t"])(
  "refuses an empty verified agent persona %j before cloning",
  async (persona) => {
    const { registry } = await fixture(
      undefined,
      undefined,
      undefined,
      persona,
    );
    expect(
      await registry.installRegistryItem("agents", {
        id: "fixture",
        name: "Fixture",
        description: "",
        path: "entry",
      }),
    ).toEqual({ success: false, error: "Agent persona is empty" });
    expect(stores.create).not.toHaveBeenCalled();
  },
);
