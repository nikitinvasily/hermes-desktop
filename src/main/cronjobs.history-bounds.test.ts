import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  rename,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  home: "",
  fixture: "",
  connection: {
    mode: "local",
    remoteUrl: "http://example.test",
    apiKey: "fixture-token",
    remoteAuthMode: "token",
  },
}));
// Use the real profileHome resolver: default is HERMES_HOME, named profiles
// are HERMES_HOME/profiles/<name>. Never touch the user's Hermes installation.
vi.mock("./installer", () => ({
  get HERMES_HOME() {
    return state.home;
  },
  HERMES_PYTHON: "unused",
  hermesCliArgs: () => [],
}));
vi.mock("./utils", async (original) => ({
  ...(await original<typeof import("./utils")>()),
  getActiveProfileNameSync: () => "work",
}));
vi.mock("./config", () => ({
  getConnectionConfig: () => state.connection,
  getActiveConnection: () => ({ connectionId: "fixture" }),
}));
vi.mock("./hermes", () => ({
  isRemoteMode: () => state.connection.mode !== "local",
  isRemoteOnlyMode: () => state.connection.mode === "remote",
}));
vi.mock("./remote-oauth", () => ({
  probeRemoteAuthMode: vi.fn(async () => ({ authMode: "token" })),
}));
vi.mock("./remote-api", () => ({ remoteDashboardRequestJson: vi.fn() }));
vi.mock("./remote-sessions", () => ({ dashboardApiUrl: vi.fn() }));
vi.mock("./ssh-remote", () => ({ sshRunCron: vi.fn() }));
const fileHooks = vi.hoisted(() => ({
  afterLstat: undefined as undefined | ((path: string) => Promise<void>),
  afterRead: undefined as undefined | (() => Promise<void>),
  afterOpen: undefined as undefined | (() => Promise<void>),
}));
// Only schedule the adversary at deterministic boundaries. All stats, opens,
// descriptor reads and rename/symlink operations use the actual filesystem.
vi.mock("fs/promises", async (original) => {
  const actual = await original<typeof import("fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stat = await actual.lstat(...args);
      await fileHooks.afterLstat?.(String(args[0]));
      return stat;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      await fileHooks.afterOpen?.();
      const read = handle.read.bind(handle);
      handle.read = (async (...args: Parameters<typeof handle.read>) => {
        const result = await read(...args);
        await fileHooks.afterRead?.();
        return result;
      }) as typeof handle.read;
      return handle;
    },
  };
});
import { listCronRuns, getCronRunOutput } from "./cronjobs";
import { profileHome } from "./utils";
import { remoteDashboardRequestJson } from "./remote-api";

beforeEach(async () => {
  state.fixture = await mkdtemp(join(tmpdir(), "cron-history-bounds-"));
  state.home = join(state.fixture, "trusted-home");
  await mkdir(state.home);
  state.connection.mode = "local";
  vi.mocked(remoteDashboardRequestJson).mockReset();
});
afterEach(async () => {
  fileHooks.afterLstat = undefined;
  fileHooks.afterRead = undefined;
  fileHooks.afterOpen = undefined;
  await rm(state.fixture, { recursive: true, force: true });
});

async function storedOutput(home: string, text: string): Promise<string> {
  const dir = join(home, "cron", "output", "job1");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "private.md");
  await writeFile(file, text);
  return file;
}

it.each([
  ["output", "afterRead"],
  ["listing", "afterRead"],
  ["output", "afterOpen"],
  ["listing", "afterOpen"],
] as const)(
  "does not release %s after a real ancestor swap and restore %s",
  async (operation, restoreAt) => {
    const selectedFile = await storedOutput(
      profileHome("work"),
      "selected-only",
    );
    const foreignFile = await storedOutput(
      join(state.fixture, "foreign"),
      "outside-private-output",
    );
    const selectedDir = join(profileHome("work"), "cron", "output", "job1");
    const parkedDir = `${selectedDir}-parked`;
    let swapped = false;
    let restored = false;
    let opened = 0;
    const restore = async (): Promise<void> => {
      if (!swapped || restored) return;
      await unlink(selectedDir);
      await rename(parkedDir, selectedDir);
      restored = true;
    };
    fileHooks.afterLstat = async (path) => {
      if (path !== selectedDir || swapped) return;
      swapped = true;
      await rename(selectedDir, parkedDir);
      await symlink(
        join(state.fixture, "foreign", "cron", "output", "job1"),
        selectedDir,
      );
    };
    fileHooks[restoreAt] = restore;
    fileHooks.afterOpen = async () => {
      opened++;
      if (restoreAt === "afterOpen") await restore();
    };
    try {
      const result =
        operation === "output"
          ? await getCronRunOutput("job1", "file:private.md", "work")
          : await listCronRuns("job1", 20, "work");
      // Prior code returns outside-private-output after a REAL descriptor read,
      // even though the selected directory has been restored before it returns.
      expect
        .soft(result)
        .toMatchObject(
          operation === "output"
            ? { success: false, output: "" }
            : { success: false, runs: [] },
        );
      expect(swapped).toBe(true);
      // An ancestry mismatch already visible before open must fail closed
      // without even acquiring a descriptor from the foreign tree.
      expect(opened).toBe(0);
    } finally {
      await restore();
    }
    expect(await readFile(selectedFile, "utf8")).toBe("selected-only");
    expect(await readFile(foreignFile, "utf8")).toBe("outside-private-output");
  },
);

it.each(["default", "other"])(
  "rejects a selected named profile root symlink into %s for listing and output",
  async (otherProfile) => {
    const file = await storedOutput(
      profileHome(otherProfile),
      "other-private-output",
    );
    await mkdir(join(state.home, "profiles"), { recursive: true });
    await symlink(profileHome(otherProfile), profileHome("work"));
    expect(await listCronRuns("job1", 20, "work")).toMatchObject({
      success: false,
      runs: [],
    });
    expect(
      await getCronRunOutput("job1", "file:private.md", "work"),
    ).toMatchObject({ success: false, output: "" });
    expect(await readFile(file, "utf8")).toBe("other-private-output");
  },
);

it("rejects a profiles-container symlink that aliases another profile's tree", async () => {
  const other = join(state.home, "profiles-other");
  const file = await storedOutput(
    join(other, "work"),
    "other-profile-private-output",
  );
  await symlink(other, join(state.home, "profiles"));
  expect(await listCronRuns("job1", 20, "work")).toMatchObject({
    success: false,
    runs: [],
  });
  expect(
    await getCronRunOutput("job1", "file:private.md", "work"),
  ).toMatchObject({ success: false, output: "" });
  expect(await readFile(file, "utf8")).toBe("other-profile-private-output");
});

it.each(["normal", "root-symlink", "ancestor-symlink"])(
  "keeps default and named reads isolated with a legitimate %s trusted home relocation",
  async (relocation) => {
    if (relocation === "root-symlink") {
      const configured = join(state.fixture, "configured-home");
      await symlink(state.home, configured);
      state.home = configured;
    } else if (relocation === "ancestor-symlink") {
      const configured = join(state.fixture, "configured-parent");
      await symlink(state.fixture, configured);
      state.home = join(configured, "trusted-home");
    }
    const files = await Promise.all([
      storedOutput(profileHome("default"), "default-only"),
      storedOutput(profileHome("work"), "work-only"),
    ]);
    for (const [profile, text] of [
      ["default", "default-only"],
      ["work", "work-only"],
    ]) {
      expect(await listCronRuns("job1", 1, profile)).toMatchObject({
        success: true,
        runs: [{ id: "file:private.md", preview: text }],
      });
      expect(
        await getCronRunOutput("job1", "file:private.md", profile),
      ).toMatchObject({
        success: true,
        output: text,
        truncated: false,
      });
    }
    expect(
      await Promise.all(files.map((file) => readFile(file, "utf8"))),
    ).toEqual(["default-only", "work-only"]);
  },
);

it("enforces an ignored server limit for rows and the output membership window", async () => {
  state.connection.mode = "remote";
  const request = vi.mocked(remoteDashboardRequestJson);
  // This fixture deliberately ignores limit=1 and limit=100, just like the
  // independent review's actual failing response. Row 101 is a valid session.
  request.mockImplementation(async (_conn, path) =>
    path.includes("/messages")
      ? { messages: [{ role: "assistant", content: "outside-window-secret" }] }
      : {
          runs: Array.from({ length: 101 }, (_, i) => ({
            id: `run-${i + 1}`,
            source: "cron",
          })),
        },
  );
  const listed = await listCronRuns("job1", 1, "work");
  expect.soft(listed.success).toBe(true);
  expect.soft(listed.runs).toHaveLength(1);
  expect.soft(listed.runs[0]?.id).toBe("run-1");
  request.mockClear();
  expect.soft(await getCronRunOutput("job1", "run-101", "work")).toMatchObject({
    success: false,
    output: "",
    error: "Run not found in this job's history.",
  });
  expect.soft(request).toHaveBeenCalledTimes(1);
  expect
    .soft(request.mock.calls.some(([, path]) => path.includes("/messages")))
    .toBe(false);
  expect(request).toHaveBeenCalledWith(
    expect.any(Object),
    "/api/cron/jobs/job1/runs?limit=100&profile=work",
    {},
    "work",
  );
});

it("bounds remote preview metadata without reducing the script output read budget", async () => {
  state.connection.mode = "remote";
  const preview = "x".repeat(200_002);
  const request = vi.mocked(remoteDashboardRequestJson).mockResolvedValue({
    runs: [
      {
        id: "cron_output:job1:123",
        source: "cron_output",
        title: "t".repeat(301),
        preview,
      },
    ],
  });
  const listed = await listCronRuns("job1", 1, "work");
  expect(listed.success).toBe(true);
  expect.soft(listed.runs[0].preview).toHaveLength(300);
  expect.soft(listed.runs[0].title).toHaveLength(300);
  expect(
    await getCronRunOutput("job1", "cron_output:job1:123", "work"),
  ).toMatchObject({
    success: true,
    output: preview.slice(0, 200_000),
    partial: true,
    truncated: true,
  });
  expect(request).toHaveBeenCalledTimes(2);
});
