import { describe, expect, it } from "vitest";
import { stripSecurityScanNoise } from "@shared/chat-approval";

describe("stripSecurityScanNoise", () => {
  it("removes the whole wrapper sentence with a Security scan payload", () => {
    expect(
      stripSecurityScanNoise(
        "Command required approval (Security scan — [HIGH] Nested executable body could not be resolved: Tirith cannot prove the body)",
      ),
    ).toBe("");
    expect(
      stripSecurityScanNoise(
        "Command was flagged (Security scan — [HIGH] Nested executable body could not be parsed)",
      ),
    ).toBe("");
  });

  it("removes a bare leading Security scan payload (live dashboard format)", () => {
    expect(
      stripSecurityScanNoise(
        "Security scan — [HIGH] Nested executable body could not be resolved: The shell will execute a grouped, encoded, or dynamically selected value, but Tirith cannot prove the complete executable body. The command is blocked instead of trusting its benign-looking outer leader. ; script execution via -e/-c flag",
      ),
    ).toBe("");
  });

  it("keeps a genuine description that precedes scanner segments", () => {
    expect(
      stripSecurityScanNoise(
        "Remove generated output; [HIGH] nested command chains could not be resolved",
      ),
    ).toBe("Remove generated output");
    expect(
      stripSecurityScanNoise(
        "Deploy the build; [MEDIUM] encoded payload; [LOW] unquoted path",
      ),
    ).toBe("Deploy the build");
  });

  it("drops a bare leading severity segment", () => {
    expect(
      stripSecurityScanNoise(
        "[HIGH] The shell will execute a grouped command, blocked instead of trusting its benign-looking outer leader.",
      ),
    ).toBe("");
  });

  it("passes through descriptions without scanner noise", () => {
    expect(stripSecurityScanNoise("Remove generated output")).toBe(
      "Remove generated output",
    );
    expect(stripSecurityScanNoise("")).toBe("");
    expect(stripSecurityScanNoise("High memory usage detected")).toBe(
      "High memory usage detected",
    );
  });
});
