// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import { tmpdir } from "os";
import { runInNewContext } from "vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";

function updaterFixture(): {
  emit: (progress: unknown) => void;
  send: ReturnType<typeof vi.fn>;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "hermes-updater-progress-"));
  const events = new Map<string, (value: unknown) => void>();
  const send = vi.fn();
  const updater = {
    on: (name: string, listener: (value: unknown) => void) =>
      events.set(name, listener),
  };
  const load = (file: string): Record<string, unknown> => {
    const output = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const exports: Record<string, unknown> = {};
    runInNewContext(output, {
      exports,
      process: { env: {} },
      setTimeout: vi.fn(),
      require: (name: string) => {
        if (name === "electron")
          return {
            app: { isPackaged: true, getPath: () => dir },
            ipcMain: { handle: vi.fn() },
          };
        if (name === "electron-updater") return { autoUpdater: updater };
        if (name === "fs") return fs;
        if (name === "path") return path;
        if (name === "../updater-log") return { updaterLogger: {} };
        if (name.startsWith("."))
          return load(path.resolve(path.dirname(file), name + ".ts"));
        throw new Error(`Unexpected require: ${name}`);
      },
    });
    return exports;
  };
  const { setupUpdater } = load(
    path.resolve(__dirname, "../src/main/app/updater.ts"),
  );
  (setupUpdater as (deps: unknown) => void)({
    getMainWindow: () => ({ webContents: { send } }),
  });
  return {
    emit: (progress) => events.get("download-progress")?.(progress),
    send,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// @lat: [[desktop-updates#Progress evidence#Measured download events]]
it("forwards actual updater byte, speed and fractional percent evidence", () => {
  const f = updaterFixture();
  try {
    f.emit({
      percent: 42.125,
      transferred: 421250,
      total: 1000000,
      bytesPerSecond: 12345,
    });
    expect(f.send).toHaveBeenLastCalledWith("update-download-progress", {
      percent: 42.125,
      transferred: 421250,
      total: 1000000,
      bytesPerSecond: 12345,
    });
  } finally {
    f.cleanup();
  }
});

// @lat: [[desktop-updates#Progress evidence#Unknown totals do not imply completion]]
it("does not present invalid or unknown download totals as measured percent", () => {
  const f = updaterFixture();
  try {
    f.emit({
      percent: Infinity,
      transferred: 4096,
      total: 0,
      bytesPerSecond: NaN,
    });
    expect(f.send).toHaveBeenLastCalledWith("update-download-progress", {
      percent: null,
      transferred: 4096,
    });
  } finally {
    f.cleanup();
  }
});

// @lat: [[desktop-updates#Progress evidence#Invalid percent remains unknown]]
it("does not turn an out-of-range percent into completed download evidence", () => {
  const f = updaterFixture();
  try {
    f.emit({ percent: 200, transferred: 25, total: 100, bytesPerSecond: NaN });
    expect(f.send).toHaveBeenLastCalledWith("update-download-progress", {
      percent: null,
      transferred: 25,
      total: 100,
    });
  } finally {
    f.cleanup();
  }
});

it.each([
  [
    { percent: 0, transferred: 0, total: 100, bytesPerSecond: 0 },
    { percent: 0, transferred: 0, total: 100, bytesPerSecond: 0 },
  ],
  [
    { percent: 100, transferred: 100, total: 100 },
    { percent: 100, transferred: 100, total: 100 },
  ],
  [
    { percent: 50, transferred: 50 },
    { percent: null, transferred: 50 },
  ],
  [
    { percent: 0, total: -1, transferred: -1, bytesPerSecond: -1 },
    { percent: null },
  ],
  [
    { percent: -1, total: 100, transferred: NaN, bytesPerSecond: Infinity },
    { percent: null, total: 100 },
  ],
  [
    { percent: NaN, total: 100 },
    { percent: null, total: 100 },
  ],
  [{ percent: 50, total: Infinity }, { percent: null }],
  [{ percent: 50, total: NaN }, { percent: null }],
  [{ total: 100 }, { percent: null, total: 100 }],
  [{}, { percent: null }],
])(
  "sanitizes measured download evidence without invented values: %j",
  (input, expected) => {
    const f = updaterFixture();
    try {
      f.emit(input);
      expect(f.send).toHaveBeenLastCalledWith(
        "update-download-progress",
        expected,
      );
    } finally {
      f.cleanup();
    }
  },
);

it("does not carry a previous sample's speed into a later missing-speed event", () => {
  const f = updaterFixture();
  try {
    f.emit({ percent: 10, total: 100, transferred: 10, bytesPerSecond: 500 });
    f.emit({ percent: 20, total: 100, transferred: 20 });
    expect(f.send).toHaveBeenLastCalledWith("update-download-progress", {
      percent: 20,
      total: 100,
      transferred: 20,
    });
  } finally {
    f.cleanup();
  }
});
