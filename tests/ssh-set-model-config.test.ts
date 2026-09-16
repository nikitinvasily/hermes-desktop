import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Issue #39: an SSH model switch must write ONLY the model block. The legacy
// sshSetModelConfig used to force `streaming: true` and disable
// smart_model_routing as a side effect, silently rewriting unrelated user
// settings on the remote on every model pick over SSH.
//
// Functional test: a fake `ssh` shim on PATH stands in for the remote host —
// the desktop's remote file commands read/write a local fixture config.yaml
// (same run-a-real-script approach as the hermes-shim tests in this family).

const itPosix = process.platform === "win32" ? it.skip : it;

const FIXTURE = [
  "model:",
  '  default: "glm-5.3"',
  '  provider: "zai"',
  '  base_url: ""',
  "display:",
  "  streaming: false",
  "  skin: default",
  "smart_model_routing:",
  "  enabled: true",
  "  fallback: keep",
  "",
].join("\n");

describe("sshSetModelConfig writes only the model block", () => {
  let dir: string;
  let configPath: string;
  let binDir: string;
  let prevPath: string | undefined;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ssh-model-set-"));
    configPath = join(dir, "config.yaml");
    binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    const sshShim = join(binDir, "ssh");
    writeFileSync(
      sshShim,
      [
        "#!/usr/bin/env bash",
        // Behave like `ssh host <script>`: the LAST argument is the remote
        // script; stdin passes through. A `cat >` script writes the fixture;
        // anything else answers with the fixture's current content.
        `CFG=${JSON.stringify(configPath)}`,
        'script="${@: -1}"',
        'if [[ "$script" == *"cat >"* ]]; then',
        '  cat > "$CFG"',
        "else",
        '  cat -- "$CFG" 2>/dev/null || true',
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(sshShim, 0o755);
    prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath || ""}`;
  });

  afterAll(() => {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  });

  itPosix("leaves streaming and smart_model_routing untouched", async () => {
    writeFileSync(configPath, FIXTURE);

    const { sshSetModelConfig } = await import("../src/main/ssh-remote");
    await sshSetModelConfig(
      {
        host: "h",
        port: 22,
        username: "u",
        keyPath: "",
        remotePort: 8642,
        localPort: 18642,
      },
      "zai",
      "glm-4.7",
      "",
    );

    const after = readFileSync(configPath, "utf8");
    expect(after).toContain('default: "glm-4.7"');
    expect(after).toContain('provider: "zai"');
    // The side effects are gone (issue #39):
    expect(after).toContain("streaming: false");
    expect(after).toContain("enabled: true");
    expect(after).not.toMatch(/streaming:\s*true/);
    expect(after).toContain("fallback: keep");
  });
});
