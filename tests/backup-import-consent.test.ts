import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import ts from "typescript";
import type { BrowserWindow } from "electron";
import { join } from "path";
import { tmpdir } from "os";

const mocks = vi.hoisted(() => ({
  mode: "local",
  home: "",
  userData: "",
  showMessageBox: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => mocks.userData, setPath: vi.fn() },
  dialog: { showMessageBox: mocks.showMessageBox },
}));
vi.mock("child_process", () => {
  const child = {
    execFile: mocks.execFile,
    execFileSync: () => {
      throw new Error("Real subprocesses are forbidden in import tests");
    },
    spawn: () => {
      throw new Error("Real subprocesses are forbidden in import tests");
    },
  };
  return { ...child, default: child };
});
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  const os = { ...original, homedir: () => mocks.home };
  return { ...os, default: os };
});
vi.mock("../src/main/config", () => ({
  getConnectionConfig: () => ({ mode: mocks.mode }),
}));

let root: string;
let archive: string;
let installer: typeof import("../src/main/installer");

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), "backup-consent-"));
  mocks.home = join(root, "user");
  mocks.userData = join(root, "desktop");
  mocks.mode = "local";
  vi.stubEnv("HERMES_HOME", join(root, "hermes-home"));
  vi.stubEnv("HERMES_DESKTOP_USER_DATA_DIR", mocks.userData);
  mkdirSync(mocks.home, { recursive: true });
  mkdirSync(mocks.userData, { recursive: true });
  installer = await import("../src/main/installer");
  for (const path of [installer.HERMES_PYTHON, installer.HERMES_SCRIPT]) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "non-executable test fixture");
  }
  archive = join(root, "my backup.tar.gz");
  writeFileSync(archive, "synthetic archive; never imported");
  mocks.showMessageBox.mockResolvedValue({ response: 0 });
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
    callback(null, "", "");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

// Evaluate only the actual registration callback, keeping unrelated IPC services out
// of this unit test (the same AST harness used by connection-model-reads tests).
function importHandler(
  getMainWindow: () => BrowserWindow | null,
): (
  event: unknown,
  archivePath: string,
  profile?: string,
) => ReturnType<typeof installer.runHermesImport> {
  const source = readFileSync(
    join(__dirname, "../src/main/ipc/register.ts"),
    "utf8",
  );
  const file = ts.createSourceFile(
    "register.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let expression = "";
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(file) === "ipcMain.handle" &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "run-hermes-import"
    ) {
      expression = node.arguments[1].getText(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(expression).not.toBe("");
  const js = ts.transpileModule(`const handler = ${expression}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(
    "runHermesImport",
    "getMainWindow",
    `${js}; return handler;`,
  )(installer.runHermesImport, getMainWindow);
}

describe("backup import consent", () => {
  it.each([
    {
      stderr: "\u001b[31mstderr failure\u001b[0m",
      stdout: "stdout ignored",
      expected: "stderr failure",
    },
    {
      stderr: "",
      stdout: "\u001b[31mstdout failure\u001b[0m",
      expected: "stdout failure",
    },
    { stderr: "", stdout: "", expected: "process failed" },
    { stderr: "", stdout: "x".repeat(600), expected: "x".repeat(500) },
  ])(
    "returns bounded, ANSI-free diagnostics: $expected",
    async ({ stderr, stdout, expected }) => {
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
        callback(new Error("process failed"), stdout, stderr);
      });
      expect(await installer.runHermesImport(archive, "default")).toEqual({
        success: false,
        error: expected,
      });
      expect(mocks.execFile).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["empty", "missing", "directory", "non-string"])(
    "rejects %s archive before consent",
    async (kind) => {
      const path =
        kind === "empty"
          ? ""
          : kind === "missing"
            ? join(root, "missing.tar.gz")
            : kind === "directory"
              ? root
              : 123;
      const expected =
        kind === "empty" || kind === "non-string"
          ? "Import archive path is required."
          : kind === "missing"
            ? "Import archive does not exist."
            : "Import archive must be a file.";
      expect(await installer.runHermesImport(path as string)).toEqual({
        success: false,
        error: expected,
      });
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
      expect(mocks.execFile).not.toHaveBeenCalled();
    },
  );

  it.each(["HERMES_PYTHON", "HERMES_SCRIPT"] as const)(
    "rejects missing %s before consent",
    async (key) => {
      rmSync(installer[key]);
      expect(await installer.runHermesImport(archive)).toEqual({
        success: false,
        error: "Hermes is not installed.",
      });
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
      expect(mocks.execFile).not.toHaveBeenCalled();
    },
  );

  it.each(["remote", "ssh"])(
    "checks %s fence before archive validation",
    async (mode) => {
      mocks.mode = mode;
      expect(await installer.runHermesImport("")).toEqual({
        success: false,
        error: "Backup import requires a Local connection.",
      });
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
      expect(mocks.execFile).not.toHaveBeenCalled();
    },
  );

  it.each(["live", "destroyed", "missing"])(
    "uses the %s main BrowserWindow from the existing IPC",
    async (state) => {
      const parent =
        state === "missing"
          ? null
          : ({
              isDestroyed: vi.fn(() => state === "destroyed"),
            } as unknown as BrowserWindow);
      const getMainWindow = vi.fn(() => parent);
      const handler = importHandler(getMainWindow);
      expect(await handler({}, archive, "work")).toEqual({
        success: false,
        error: "Backup import cancelled.",
      });
      expect(getMainWindow).toHaveBeenCalledTimes(1);
      if (state === "live") {
        expect(mocks.showMessageBox).toHaveBeenCalledWith(
          parent,
          expect.objectContaining({ type: "warning" }),
        );
      } else {
        expect(mocks.showMessageBox).toHaveBeenCalledWith(
          expect.objectContaining({ type: "warning" }),
        );
      }
      expect(mocks.execFile).not.toHaveBeenCalled();
    },
  );
  it.each([
    { profile: undefined, active: "default", target: "default" },
    { profile: undefined, active: "work", target: "work" },
    { profile: "default", active: "work", target: "default" },
    { profile: "work", active: "default", target: "work" },
    { profile: "", active: "work", target: "work" },
  ])(
    "pins $profile / active $active across consent and invokes captured argv",
    async ({ profile, active, target }) => {
      writeFileSync(join(installer.HERMES_HOME, "active_profile"), active);
      vi.stubEnv("HERMES_PROFILE", "sticky-other-profile");
      vi.stubEnv("BACKUP_CONSENT_TEST", "inherited-env");
      let confirm!: (value: { response: number }) => void;
      mocks.showMessageBox.mockImplementation(
        () =>
          new Promise((resolve) => {
            confirm = resolve;
          }),
      );
      const pending = installer.runHermesImport(archive, profile);
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
      expect(mocks.showMessageBox.mock.calls[0][0].detail).toContain(
        `Local profile: "${target}"`,
      );
      expect(mocks.execFile).not.toHaveBeenCalled();
      writeFileSync(join(installer.HERMES_HOME, "active_profile"), "drifted");
      confirm({ response: 1 });
      expect(await pending).toEqual({ success: true });
      expect(mocks.execFile).toHaveBeenCalledTimes(1);
      expect(mocks.execFile).toHaveBeenCalledWith(
        installer.HERMES_PYTHON,
        installer.hermesCliArgs(["-p", target, "import", archive, "--force"]),
        {
          cwd: installer.HERMES_REPO,
          env: {
            ...process.env,
            PATH: installer.getEnhancedPath(),
            HOME: mocks.home,
            HERMES_HOME: installer.HERMES_HOME,
            TERM: "dumb",
          },
          timeout: 120000,
          windowsHide: true,
        },
        expect.any(Function),
      );
    },
  );

  it.each(["remote", "ssh"])(
    "rechecks Local after consent switches to %s",
    async (mode) => {
      let confirm!: (value: { response: number }) => void;
      mocks.showMessageBox.mockImplementation(
        () =>
          new Promise((resolve) => {
            confirm = resolve;
          }),
      );
      const pending = installer.runHermesImport(archive, "default");
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
      mocks.mode = mode;
      confirm({ response: 1 });
      expect(await pending).toEqual({
        success: false,
        error: "Connection changed; backup import cancelled.",
      });
      expect(mocks.execFile).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 2, undefined, null, "1", true])(
    "does not launch for cancel, close or unexpected response %s",
    async (response) => {
      mocks.showMessageBox.mockResolvedValue({ response });
      expect(await installer.runHermesImport(archive)).toEqual({
        success: false,
        error: "Backup import cancelled.",
      });
      expect(mocks.execFile).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the native dialog rejects", async () => {
    mocks.showMessageBox.mockRejectedValue(new Error("dialog unavailable"));
    expect(await installer.runHermesImport(archive)).toEqual({
      success: false,
      error: "Could not confirm backup import.",
    });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("warns with the archive and captured profile, defaulting to Cancel", async () => {
    writeFileSync(join(installer.HERMES_HOME, "active_profile"), "work");
    await installer.runHermesImport(archive);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    expect(mocks.showMessageBox).toHaveBeenCalledWith({
      type: "warning",
      title: "Restore Hermes backup",
      message: "Restore this Hermes backup?",
      detail: expect.stringContaining(
        'Archive: my backup.tar.gz\nLocal profile: "work"',
      ),
      buttons: ["Cancel", "Restore backup"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    const [options] = mocks.showMessageBox.mock.calls[0];
    expect(options.detail).toMatch(
      /replaces configuration, credentials, sessions/,
    );
    expect(options.detail).toMatch(/Provider backups.*outside this profile/);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it.each([
    "../escape",
    "..",
    "-p",
    "bad/name",
    "bad\\name",
    "UPPER",
    "bad\nname",
    "a".repeat(65),
    123,
  ])("rejects unsafe explicit profile %s before consent", async (profile) => {
    expect(await installer.runHermesImport(archive, profile as string)).toEqual(
      {
        success: false,
        error: (await import("../src/main/utils")).PROFILE_NAME_ERROR,
      },
    );
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("rejects an unsafe implicit active profile before consent", async () => {
    writeFileSync(join(installer.HERMES_HOME, "active_profile"), "../escape");
    expect(await installer.runHermesImport(archive)).toEqual({
      success: false,
      error: (await import("../src/main/utils")).PROFILE_NAME_ERROR,
    });
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it.each(["remote", "ssh"])(
    "rejects %s before dialog or child",
    async (mode) => {
      mocks.mode = mode;
      expect(await installer.runHermesImport(archive)).toEqual({
        success: false,
        error: "Backup import requires a Local connection.",
      });
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
      expect(mocks.execFile).not.toHaveBeenCalled();
    },
  );
});
