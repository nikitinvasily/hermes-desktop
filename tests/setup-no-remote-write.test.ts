import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateHermesHome } from "../src/main/installer";

// Issue #49: onboarding an isolated/test HERMES_HOME must never rewrite the
// remote agent's global model config. The guard lives in the ssh legacy branch
// of the set-model-config handler: an invalid local HERMES_HOME (the fake
// agent install a test instance boots with) skips the remote write entirely.

const ROOT = join(__dirname, "..");
const handlerSrc = readFileSync(
  join(ROOT, "src/main/ipc/register.ts"),
  "utf-8",
);

describe("set-model-config ssh legacy fallback is gated on a real agent home", () => {
  it("handler guards the legacy remote write with validateHermesHome(HERMES_HOME)", () => {
    const sshBranch = handlerSrc.slice(
      handlerSrc.indexOf('"set-model-config"'),
    );
    expect(sshBranch).toContain("sshSetModelConfig");
    const guardIdx = sshBranch.indexOf(
      "if (!validateHermesHome(HERMES_HOME)) return true;",
    );
    const writeIdx = sshBranch.indexOf("await sshSetModelConfig(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    // The guard must fire BEFORE the remote write, inside the same fallback.
    expect(guardIdx).toBeLessThan(writeIdx);
  });
});

describe("validateHermesHome distinguishes a real install from the test-instance fake", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "validate-home-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a home with the expected venv layout", () => {
    const home = join(dir, "real");
    mkdirSync(join(home, "hermes-agent/venv/bin"), { recursive: true });
    writeFileSync(join(home, "hermes-agent/venv/bin/python"), "#!/bin/sh\n");
    writeFileSync(join(home, "hermes-agent/hermes"), "#!/bin/sh\n");
    expect(validateHermesHome(home)).toBe(true);
  });

  it("rejects the isolated test home (empty fake binaries, no layout)", () => {
    const home = join(dir, "fake");
    mkdirSync(join(home, "hermes-agent/venv/bin"), { recursive: true });
    // Zero-byte touch-files, exactly what the CDP test procedure creates.
    writeFileSync(join(home, "hermes-agent/venv/bin/python"), "");
    writeFileSync(join(home, "hermes-agent/hermes"), "");
    expect(validateHermesHome(home)).toBe(false);
  });

  it("rejects a missing home", () => {
    expect(validateHermesHome(join(dir, "does-not-exist"))).toBe(false);
    expect(validateHermesHome("")).toBe(false);
  });
});
