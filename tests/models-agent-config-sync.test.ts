import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Terminal ↔ desktop model-library sync: `custom_providers:` entries in
 * config.yaml must merge into models.json on every renderer-facing read,
 * not only when the library is first seeded. Previously a provider added
 * via the hermes CLI after first run never appeared in the desktop.
 */

let testHome: string;

async function freshModels(): Promise<typeof import("../src/main/models")> {
  vi.resetModules();
  vi.stubEnv("HERMES_HOME", testHome);
  return await import("../src/main/models");
}

function writeCustomProviders(): void {
  writeFileSync(
    join(testHome, "config.yaml"),
    [
      "custom_providers:",
      '  - name: "Faab AI"',
      '    base_url: "https://faab.ai/v1"',
      '    model: "faab-large"',
      '    api_key: "sk-faab"',
      "",
    ].join("\n"),
  );
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "hermes-models-sync-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(testHome, { recursive: true, force: true });
});

// @lat: [[provider-setup#Provider setup#Agent config sync for named providers#Model library merges custom_providers on every read]]
describe("agent-config model sync", () => {
  it("merges custom_providers entries added after first seed", async () => {
    const models = await freshModels();
    // First read seeds the defaults with no custom providers configured.
    expect(models.listModels().some((m) => m.model === "faab-large")).toBe(
      false,
    );

    // The user then adds a provider from the terminal.
    writeCustomProviders();
    const merged = models.listModels();
    const row = merged.find((m) => m.model === "faab-large");
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      provider: "custom",
      baseUrl: "https://faab.ai/v1",
      providerLabel: "Faab AI",
    });
    // Its key is persisted under the desktop's derived env var.
    const env = readFileSync(join(testHome, ".env"), "utf-8");
    expect(env).toContain("CUSTOM_PROVIDER_FAAB_AI_KEY=sk-faab");
  });

  it("is idempotent — repeated reads don't duplicate rows", async () => {
    writeCustomProviders();
    const models = await freshModels();
    models.listModels();
    models.listModels();
    const rows = models.listModels().filter((m) => m.model === "faab-large");
    expect(rows).toHaveLength(1);
  });

  // @lat: [[provider-setup#Provider setup#Models live under each provider (OpenCode-style)#Model attachment dedup]]
  it("does not add a second row when the library already has the model with an empty baseUrl", async () => {
    // Seed the library with a manually-added row that carries no baseUrl
    // (legal for custom endpoints stored from the UI before a URL was kept).
    const models0 = await freshModels();
    models0.addModel("Z.ai GLM", "custom", "glm-5.3", "");

    // The terminal then adds a custom_providers entry for the same model with
    // the explicit endpoint URL. The relaxed identity must see them as one.
    writeFileSync(
      join(testHome, "config.yaml"),
      [
        "custom_providers:",
        '  - name: "Z.ai"',
        '    base_url: "https://api.z.ai/api/paas/v4"',
        '    model: "glm-5.3"',
        '    api_key: "sk-zai"',
        "",
      ].join("\n"),
    );
    const models = await freshModels();
    const rows = models
      .listModels()
      .filter((m) => m.provider === "custom" && m.model === "glm-5.3");
    expect(rows).toHaveLength(1);
    // The surviving row keeps routing metadata: the non-empty baseUrl.
    expect(rows[0].baseUrl).toBe("https://api.z.ai/api/paas/v4");
  });

  // @lat: [[provider-setup#Provider setup#Models live under each provider (OpenCode-style)#Model attachment dedup]]
  it("collapses pre-existing empty-vs-explicit baseUrl duplicates on read", async () => {
    // models.json as it accumulated in the wild: the same model twice,
    // once without and once with the canonical endpoint URL (issue #170).
    const models0 = await freshModels();
    models0.listModels(); // seed defaults so models.json exists
    const raw = JSON.parse(readFileSync(join(testHome, "models.json"), "utf-8"));
    raw.push(
      { id: "dup-a", name: "glm-5.3", provider: "zai", model: "glm-5.3", baseUrl: "", createdAt: 1 },
      {
        id: "dup-b",
        name: "glm-5.3",
        provider: "zai",
        model: "glm-5.3",
        baseUrl: "https://api.z.ai/api/paas/v4",
        createdAt: 2,
      },
    );
    writeFileSync(join(testHome, "models.json"), JSON.stringify(raw));

    const models = await freshModels();
    const rows = models
      .listModels()
      .filter((m) => m.provider === "zai" && m.model === "glm-5.3");
    expect(rows).toHaveLength(1);
    expect(rows[0].baseUrl).toBe("https://api.z.ai/api/paas/v4");
    // And the collapse is persisted — a second process sees one row too.
    const persisted = JSON.parse(
      readFileSync(join(testHome, "models.json"), "utf-8"),
    ).filter((r: { provider: string; model: string }) => r.provider === "zai" && r.model === "glm-5.3");
    expect(persisted).toHaveLength(1);
  });
});
