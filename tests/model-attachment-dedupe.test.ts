import { describe, expect, it } from "vitest";
import {
  dedupeAttachmentRows,
  isSameModelAttachment,
} from "../src/shared/model-attachment-dedupe";

/**
 * Picker-facing identity of model attachment rows: for named providers an
 * empty baseUrl is equivalent to the provider's canonical URL, so rows that
 * differ only that way must collapse into one pickable entry (issue #170 —
 * the current model appeared twice in the chat model picker).
 */

// @lat: [[provider-setup#Provider setup#Models live under each provider (OpenCode-style)#Model attachment dedup]]
describe("model attachment dedup", () => {
  it("treats an empty baseUrl as equivalent to the canonical URL", () => {
    expect(
      isSameModelAttachment(
        { provider: "zai", model: "glm-5.3", baseUrl: "" },
        { provider: "zai", model: "glm-5.3", baseUrl: "https://api.z.ai/api/paas/v4" },
      ),
    ).toBe(true);
  });

  it("keeps two distinct explicit endpoints separate", () => {
    expect(
      isSameModelAttachment(
        { provider: "custom", model: "faab-large", baseUrl: "https://faab.ai/v1" },
        { provider: "custom", model: "faab-large", baseUrl: "https://mirror.faab.ai/v1" },
      ),
    ).toBe(false);
  });

  it("compares provider and model case-insensitively", () => {
    expect(
      isSameModelAttachment(
        { provider: "ZAI", model: "GLM-5.3" },
        { provider: "zai", model: "glm-5.3", baseUrl: "https://api.z.ai/api/paas/v4" },
      ),
    ).toBe(true);
  });

  it("collapses duplicate rows and inherits the non-empty baseUrl", () => {
    const rows = [
      { provider: "zai", model: "glm-5.3", baseUrl: "" },
      { provider: "zai", model: "glm-5.3", baseUrl: "https://api.z.ai/api/paas/v4" },
      { provider: "openrouter", model: "openai/gpt-6-luna", baseUrl: "https://openrouter.ai/api/v1" },
      { provider: "openrouter", model: "openai/gpt-6-luna", baseUrl: "" },
      { provider: "anthropic", model: "claude-sonnet-4-20250514", baseUrl: "" },
    ];
    const result = dedupeAttachmentRows(rows);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      provider: "zai",
      model: "glm-5.3",
      baseUrl: "https://api.z.ai/api/paas/v4",
    });
    expect(result[1]).toMatchObject({
      provider: "openrouter",
      model: "openai/gpt-6-luna",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("keeps two explicit custom endpoints for the same model id", () => {
    const rows = [
      { provider: "custom", model: "faab-large", baseUrl: "https://faab.ai/v1" },
      { provider: "custom", model: "faab-large", baseUrl: "https://mirror.faab.ai/v1" },
    ];
    expect(dedupeAttachmentRows(rows)).toHaveLength(2);
  });
});
