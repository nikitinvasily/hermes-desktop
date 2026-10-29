import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  utimes,
  symlink,
  rename,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  home: "",
  activeId: "one",
  activeProfile: "work",
  connection: {
    mode: "local",
    remoteUrl: "",
    apiKey: "",
    remoteAuthMode: "token",
  },
}));
vi.mock("./utils", () => ({
  profileHome: (profile?: string) =>
    profile && profile !== "default"
      ? join(state.home, "profiles", profile)
      : state.home,
  getActiveProfileNameSync: () => state.activeProfile,
}));
vi.mock("./installer", () => ({
  HERMES_HOME: "unused",
  HERMES_PYTHON: "unused",
  hermesCliArgs: () => [],
}));
vi.mock("./config", () => ({
  getConnectionConfig: () => state.connection,
  getActiveConnection: () => ({ connectionId: state.activeId }),
}));
vi.mock("./hermes", () => ({
  isRemoteMode: () => state.connection.mode !== "local",
  isRemoteOnlyMode: () => state.connection.mode === "remote",
}));
vi.mock("./remote-oauth", () => ({
  probeRemoteAuthMode: vi.fn(async () => ({ authMode: "token" })),
}));
vi.mock("./sessions", () => ({ expandRowsToHistory: vi.fn() }));
vi.mock("./remote-api", () => ({ remoteDashboardRequestJson: vi.fn() }));
vi.mock("./ssh-remote", () => ({ sshRunCron: vi.fn() }));
const fileHooks = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock("fs/promises", async (original) => {
  const actual = await original<typeof import("fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      await fileHooks.beforeOpen?.(String(args[0]));
      return actual.open(...args);
    },
  };
});
const bridge = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  invoke: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  webUtils: {},
  ipcRenderer: { invoke: (...args: unknown[]) => bridge.invoke(...args) },
}));
import * as cron from "./cronjobs";
const list = cron.listCronRuns;
const output = cron.getCronRunOutput;

beforeEach(async () => {
  fileHooks.beforeOpen = undefined;
  state.home = await mkdtemp(join(tmpdir(), "cron-history-"));
  state.connection.mode = "local";
  state.connection.apiKey = "test-token";
  state.connection.remoteUrl = "http://example.test/nested/api";
  state.connection.remoteAuthMode = "token";
  state.activeId = "one";
  state.activeProfile = "work";
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(state.home, { recursive: true, force: true });
});

it("lists only selected-profile markdown outputs newest first and returns their text read-only", async () => {
  const dir = join(state.home, "profiles", "work", "cron", "output", "job1");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "older.md"), "older output");
  await writeFile(join(dir, "newer.md"), "newer output");
  await utimes(join(dir, "older.md"), 1, 1);
  await utimes(join(dir, "newer.md"), 2, 2);
  await writeFile(join(dir, "ignored.txt"), "ignored");
  const result = await list("job1", 1, "work");
  expect(result).toMatchObject({
    success: true,
    runs: [
      {
        id: "file:newer.md",
        source: "cron_output",
        preview: "newer output",
        started_at: 2,
      },
    ],
  });
  expect(result.runs).toHaveLength(1);
  expect(await output("job1", result.runs[0].id, "work")).toMatchObject({
    success: true,
    output: "newer output",
    truncated: false,
  });
  expect(await list("job1", 20, "default")).toEqual({
    success: true,
    runs: [],
  });
});

it.each(["cron", "output", "job1"])(
  "refuses a symlinked %s directory rather than leaking another scope",
  async (segment) => {
    const outside = join(state.home, "outside");
    const profile = join(state.home, "profiles", "work");
    const parts = ["cron", "output", "job1"];
    const i = parts.indexOf(segment);
    await mkdir(join(profile, ...parts.slice(0, i)), { recursive: true });
    await mkdir(join(outside, ...parts.slice(i + 1)), { recursive: true });
    await writeFile(
      join(outside, ...parts.slice(i + 1), "secret.md"),
      "private outside scope",
    );
    await symlink(outside, join(profile, ...parts.slice(0, i + 1)));
    expect(await list("job1", 20, "work")).toMatchObject({
      success: false,
      runs: [],
    });
    expect(await output("job1", "file:secret.md", "work")).toMatchObject({
      success: false,
      output: "",
    });
  },
);

it("reports SSH unsupported without falling back to local output or launching commands", async () => {
  const dir = join(state.home, "cron", "output", "job1");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "run.md"), "local must stay private");
  state.connection.mode = "ssh";
  expect(await list("job1")).toMatchObject({
    success: false,
    unsupported: true,
    runs: [],
  });
  expect(await output("job1", "file:run.md")).toMatchObject({
    success: false,
    unsupported: true,
    output: "",
  });
  const { sshRunCron } = await import("./ssh-remote");
  expect(sshRunCron).not.toHaveBeenCalled();
});

it("uses the selected remote profile history and verifies membership before reading session messages", async () => {
  state.connection.mode = "remote";
  const { remoteDashboardRequestJson } = await import("./remote-api");
  const request = vi.mocked(remoteDashboardRequestJson).mockReset();
  request.mockResolvedValueOnce({
    runs: [{ id: "cron_job1_123", source: "cron", message_count: 3 }],
  });
  expect(await list("job1", 3, "work")).toMatchObject({
    success: true,
    runs: [{ id: "cron_job1_123", message_count: 3 }],
  });
  expect(request).toHaveBeenLastCalledWith(
    expect.objectContaining({ mode: "remote" }),
    "/api/cron/jobs/job1/runs?limit=3&profile=work",
    {},
    "work",
  );
  request.mockResolvedValueOnce({
    runs: [{ id: "cron_job1_123", source: "cron" }],
  });
  request.mockResolvedValueOnce({
    messages: [
      { role: "system", content: "private", display_kind: "hidden" },
      { role: "assistant", content: "raw", display_content: "visible answer" },
    ],
  });
  expect(await output("job1", "cron_job1_123", "work")).toMatchObject({
    success: true,
    output: "[assistant]\nvisible answer",
    partial: false,
    truncated: false,
  });
  expect(request).toHaveBeenLastCalledWith(
    expect.any(Object),
    "/api/sessions/cron_job1_123/messages?order=oldest&limit=500&profile=work",
    {},
    "work",
  );
  request.mockClear().mockResolvedValueOnce({ runs: [] });
  expect(await output("job1", "another_session", "work")).toMatchObject({
    success: false,
    output: "",
  });
  expect(request).toHaveBeenCalledTimes(1);
});

it("bounds remote script previews and labels them partial without fetching session messages", async () => {
  state.connection.mode = "remote";
  const { remoteDashboardRequestJson } = await import("./remote-api");
  const request = vi
    .mocked(remoteDashboardRequestJson)
    .mockReset()
    .mockResolvedValue({
      runs: [
        {
          id: "cron_output:job1:123",
          source: "cron_output",
          preview: "x".repeat(200001),
        },
      ],
    });
  const result = await output("job1", "cron_output:job1:123");
  expect(result).toMatchObject({
    success: true,
    partial: true,
    truncated: true,
  });
  expect(result.output).toHaveLength(200000);
  expect(request).toHaveBeenCalledTimes(1);
});
it.each([404, 405])(
  "reports HTTP %s as unsupported without fallback",
  async (statusCode) => {
    state.connection.mode = "remote";
    const { remoteDashboardRequestJson } = await import("./remote-api");
    vi.mocked(remoteDashboardRequestJson)
      .mockReset()
      .mockRejectedValue(
        Object.assign(new Error("history unavailable"), { statusCode }),
      );
    expect(await list("job1")).toMatchObject({
      success: false,
      runs: [],
      unsupported: true,
    });
    expect(await output("job1", "cron_job1_123")).toMatchObject({
      success: false,
      output: "",
      unsupported: true,
    });
  },
);

it.each(["connection", "token"])(
  "discards remote history completed after the %s identity changes",
  async (change) => {
    state.connection.mode = "remote";
    const { remoteDashboardRequestJson } = await import("./remote-api");
    vi.mocked(remoteDashboardRequestJson)
      .mockReset()
      .mockImplementationOnce(async () => {
        if (change === "connection") state.activeId = "two";
        else state.connection.apiKey = "replacement";
        return {
          runs: [{ id: "cron_job1_123", preview: "stale private result" }],
        };
      });
    expect(await list("job1", 20, "work")).toMatchObject({
      success: false,
      runs: [],
    });
  },
);
it("rejects a captured target from another profile or changed configuration", async () => {
  const target = cron.captureProfileEditorTarget("work", "one");
  expect(await list("job1", 20, "another", target)).toMatchObject({
    success: false,
    runs: [],
  });
  state.connection.apiKey = "changed";
  expect(await list("job1", 20, "work", target)).toMatchObject({
    success: false,
    runs: [],
  });
});

it("discards responses and invalidates captured targets across a same-config auth transition", async () => {
  state.connection.mode = "remote";
  const target = cron.captureProfileEditorTarget("work", "one");
  const { remoteDashboardRequestJson } = await import("./remote-api");
  const transition = cron.withCronHistoryAuthChange;
  vi.mocked(remoteDashboardRequestJson)
    .mockReset()
    .mockImplementationOnce(async () => {
      await transition(async () => {});
      return { runs: [{ id: "cron_job1_123", preview: "old principal" }] };
    });
  expect(await list("job1", 20, "work", target)).toMatchObject({
    success: false,
    runs: [],
  });
  expect(await list("job1", 20, "work", target)).toMatchObject({
    success: false,
    runs: [],
  });
  await transition(async () => {
    expect(await list("job1", 20, "work")).toMatchObject({
      success: false,
      runs: [],
    });
  });
});

it("round-trips captured profile, run limit and output from preload through the real IPC callback", async () => {
  // Evaluate only the exact history registration statements, avoiding unrelated
  // Electron startup side effects while exercising the shipped callback bodies.
  const source = readFileSync(
    join(process.cwd(), "src/main/ipc/register.ts"),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "register.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  bridge.handlers.clear();
  const names = [
    "list-cron-runs",
    "get-cron-run-output",
    "get-profile-editor-target",
  ];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "ipcMain.handle" &&
      ts.isStringLiteral(node.arguments[0]) &&
      names.includes(node.arguments[0].text)
    ) {
      const js = ts.transpile(node.getText(ast), {
        target: ts.ScriptTarget.ES2022,
      });
      new Function(
        "ipcMain",
        "listCronRuns",
        "getCronRunOutput",
        "captureProfileEditorTarget",
        js,
      )(
        {
          handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
            bridge.handlers.set(channel, fn),
        },
        cron.listCronRuns,
        cron.getCronRunOutput,
        cron.captureProfileEditorTarget,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  bridge.invoke.mockImplementation(
    async (channel: string, ...args: unknown[]) =>
      bridge.handlers.get(channel)?.({}, ...args) ?? {
        success: true,
        runs: [],
        output: "",
      },
  );
  await import("../preload/index");
  const api = (
    window as unknown as {
      hermesAPI: {
        getProfileEditorTarget: (
          profile?: string,
          connectionId?: string,
        ) => Promise<cron.ProfileEditorTarget>;
        listCronRuns: typeof cron.listCronRuns;
        getCronRunOutput: typeof cron.getCronRunOutput;
      };
    }
  ).hermesAPI;
  const dir = join(state.home, "profiles", "work", "cron", "output", "job1");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "run.md"), "bridge output");
  const target = await api.getProfileEditorTarget?.("work", "one");
  const result = (await api.listCronRuns?.("job1", 1, "work", target)) ?? {
    success: true,
    runs: [],
  };
  expect(result).toMatchObject({
    success: true,
    runs: [{ id: "file:run.md", preview: "bridge output" }],
  });
  expect(
    await api.getCronRunOutput("job1", "file:run.md", "work", target),
  ).toMatchObject({ success: true, output: "bridge output" });
  expect(bridge.invoke).toHaveBeenCalledWith(
    "list-cron-runs",
    "job1",
    1,
    "work",
    target,
  );
  expect(target).toMatchObject({
    connectionId: "one",
    profile: "work",
    mode: "local",
    scopeToken: expect.any(String),
  });
});

it.each([false, true])(
  "registers IPC safely with app ready=%s and observes cookies before the first window",
  async (initiallyReady) => {
    state.connection.mode = "remote";
    let ready = initiallyReady;
    const app = Object.assign(new EventEmitter(), { isReady: () => ready });
    const cookies = new EventEmitter();
    const fromPartition = vi.fn(() => {
      if (!ready)
        throw new TypeError("Session can only be received when app is ready");
      return { cookies };
    });
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const scope = {
      app,
      session: { fromPartition },
      REMOTE_OAUTH_PARTITION: "fixture-oauth",
      observeCronHistoryCookies: cron.observeCronHistoryCookies,
      captureProfileEditorTarget: cron.captureProfileEditorTarget,
      listCronRuns: cron.listCronRuns,
      getCronRunOutput: cron.getCronRunOutput,
      ipcMain: {
        handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
          handlers.set(channel, fn),
        on: vi.fn(),
      },
      context: { getMainWindow: () => null },
    };
    const source = readFileSync(
      join(process.cwd(), "src/main/ipc/register.ts"),
      "utf8",
    );
    const ast = ts.createSourceFile(
      "register.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const registration = ast.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) &&
        node.name?.text === "registerIpcHandlers",
    );
    // Execute the complete registration body, not a copied observer snippet.
    const register = new Function(
      ...Object.keys(scope),
      ts.transpile(registration!.body!.getText(ast), {
        target: ts.ScriptTarget.ES2022,
      }),
    );
    expect(() => register(...Object.values(scope))).not.toThrow();
    expect(handlers.has("get-profile-editor-target")).toBe(true);
    expect(handlers.has("list-cron-runs")).toBe(true);
    expect(handlers.has("get-cron-run-output")).toBe(true);
    expect(fromPartition).toHaveBeenCalledTimes(initiallyReady ? 1 : 0);

    // startMainProcess registers IPC before its ready-time window creation.
    app.once("ready", () => {
      expect(cookies.listenerCount("changed")).toBe(1);
    });
    ready = true;
    app.emit("ready");
    expect(fromPartition).toHaveBeenCalledExactlyOnceWith("fixture-oauth");
    expect(cookies.listenerCount("changed")).toBe(1);
    const target = handlers.get("get-profile-editor-target")!(
      {},
      "work",
      "one",
    );
    cookies.emit("changed", {}, { name: "first-window-cookie" });
    const { remoteDashboardRequestJson } = await import("./remote-api");
    const request = vi
      .mocked(remoteDashboardRequestJson)
      .mockReset()
      .mockResolvedValue({ runs: [] });
    expect(
      await handlers.get("list-cron-runs")!({}, "job1", 1, "work", target),
    ).toMatchObject({ success: false, runs: [] });
    expect(
      await handlers.get("get-cron-run-output")!(
        {},
        "job1",
        "cron_job1_1",
        "work",
        target,
      ),
    ).toMatchObject({ success: false, output: "" });
    expect(request).not.toHaveBeenCalled();
  },
);

it("invalidates a remote target when the OAuth cookie store changes without config changes", async () => {
  state.connection.mode = "remote";
  const target = cron.captureProfileEditorTarget("work", "one");
  const cookies = new EventEmitter();
  cron.observeCronHistoryCookies(cookies as unknown as Electron.Cookies);
  cron.observeCronHistoryCookies(cookies as unknown as Electron.Cookies);
  expect(cookies.listenerCount("changed")).toBe(1);
  cookies.emit("changed", {}, { name: "fixture-session-cookie" });
  const { remoteDashboardRequestJson } = await import("./remote-api");
  const request = vi
    .mocked(remoteDashboardRequestJson)
    .mockReset()
    .mockResolvedValue({ runs: [] });
  expect(await list("job1", 20, "work", target)).toMatchObject({
    success: false,
    runs: [],
  });
  expect(request).not.toHaveBeenCalled();
});

it.each(["token", "auto"])(
  "reads keyless %s history using the existing URL semantics and URL Basic auth",
  async (mode) => {
    state.connection.mode = "remote";
    state.connection.remoteAuthMode = mode;
    state.connection.apiKey = "";
    state.connection.remoteUrl =
      "http://reader:fixture-password@example.test/nested/api?discard=1#discard";
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ runs: [{ id: "cron_job1_1" }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await list("job1", 1, "work")).toMatchObject({
      success: true,
      runs: [{ id: "cron_job1_1" }],
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://example.test/api/cron/jobs/job1/runs?limit=1&profile=work",
      expect.objectContaining({
        headers: {
          Authorization: `Basic ${Buffer.from("reader:fixture-password").toString("base64")}`,
        },
      }),
    );
  },
);

it("bounds session messages even if a server ignores the requested page size", async () => {
  state.connection.mode = "remote";
  const { remoteDashboardRequestJson } = await import("./remote-api");
  const request = vi.mocked(remoteDashboardRequestJson).mockReset();
  request.mockResolvedValueOnce({
    runs: [{ id: "cron_job1_1", source: "cron" }],
  });
  request.mockResolvedValueOnce({
    messages: Array.from({ length: 501 }, (_, i) => ({
      role: "assistant",
      content: `message-${i}`,
    })),
  });
  const result = await output("job1", "cron_job1_1");
  expect(result).toMatchObject({ success: true, partial: true });
  expect(result.output).toContain("message-499");
  expect(result.output).not.toContain("message-500");
});

it("keeps local reads bounded, skips unsafe entries, and leaves the stored bytes unchanged", async () => {
  const dir = join(state.home, "profiles", "work", "cron", "output", "job1");
  await mkdir(dir, { recursive: true });
  const content = "😀".repeat(150000);
  await writeFile(join(dir, "large.md"), content);
  await writeFile(join(state.home, "outside.md"), "outside secret");
  await symlink(join(state.home, "outside.md"), join(dir, "link.md"));
  await mkdir(join(dir, "directory.md"));
  const result = await list("job1", 100, "work");
  expect(result).toMatchObject({
    success: true,
    runs: [{ id: "file:large.md" }],
  });
  expect(result.runs[0].preview).toHaveLength(300);
  const text = await output("job1", "file:large.md", "work");
  expect(text).toMatchObject({ success: true, truncated: true });
  expect(text.output).toHaveLength(200000);
  expect(await output("job1", "file:link.md", "work")).toMatchObject({
    success: false,
    output: "",
  });
  expect(await output("job1", "file:directory.md", "work")).toMatchObject({
    success: false,
    output: "",
  });
  expect(readFileSync(join(dir, "large.md"), "utf8")).toBe(content);
});
it.each(["../job1", "..", "/absolute", "a/b", "a\\b", "%2e%2e%2f", ""])(
  "rejects traversal/invalid job ID %j on both boundaries",
  async (id) => {
    expect(await list(id)).toMatchObject({ success: false, runs: [] });
    expect(await output(id, "file:run.md")).toMatchObject({
      success: false,
      output: "",
    });
  },
);
it.each([
  "file:../secret.md",
  "file:/secret.md",
  "file:a\\b.md",
  "file:..",
  "file:run.txt",
])("rejects invalid local output ID %j", async (id) => {
  expect(await output("job1", id, "work")).toMatchObject({
    success: false,
    output: "",
  });
});
it.each([NaN, Infinity, -4, 1000, 1.9])(
  "clamps remote run limit %s and explicitly scopes the default profile",
  async (limit) => {
    state.connection.mode = "remote";
    const { remoteDashboardRequestJson } = await import("./remote-api");
    const request = vi
      .mocked(remoteDashboardRequestJson)
      .mockReset()
      .mockResolvedValue({ runs: [] });
    expect(await list("job1", limit)).toMatchObject({
      success: true,
      runs: [],
    });
    const expected = Number.isFinite(limit)
      ? Math.max(1, Math.min(100, Math.floor(limit)))
      : 20;
    expect(request).toHaveBeenLastCalledWith(
      expect.any(Object),
      `/api/cron/jobs/job1/runs?limit=${expected}&profile=default`,
      {},
      "default",
    );
  },
);
it.each([
  null,
  {},
  { runs: null },
  { runs: [null] },
  { runs: [{ id: "../outside" }] },
])("rejects malformed remote history %j", async (payload) => {
  state.connection.mode = "remote";
  const { remoteDashboardRequestJson } = await import("./remote-api");
  vi.mocked(remoteDashboardRequestJson).mockReset().mockResolvedValue(payload);
  expect(await list("job1")).toMatchObject({ success: false, runs: [] });
});
it.each([401, 403, 500])(
  "keeps HTTP %s an explicit non-unsupported failure",
  async (statusCode) => {
    state.connection.mode = "remote";
    const { remoteDashboardRequestJson } = await import("./remote-api");
    vi.mocked(remoteDashboardRequestJson)
      .mockReset()
      .mockRejectedValue(
        Object.assign(new Error("request denied"), { statusCode }),
      );
    expect(await list("job1")).toMatchObject({
      success: false,
      runs: [],
      unsupported: false,
    });
  },
);
it.each(["profile", "connection", "token", "cookie"])(
  "discards session output completed after a %s change",
  async (change) => {
    state.connection.mode = "remote";
    const { remoteDashboardRequestJson } = await import("./remote-api");
    const request = vi.mocked(remoteDashboardRequestJson).mockReset();
    request.mockResolvedValueOnce({
      runs: [{ id: "cron_job1_1", source: "cron" }],
    });
    request.mockImplementationOnce(async () => {
      if (change === "profile") state.activeProfile = "other";
      if (change === "connection") state.activeId = "two";
      if (change === "token") state.connection.apiKey = "new-token";
      if (change === "cookie") cron.invalidateCronHistoryAuth();
      return { messages: [{ role: "assistant", content: "stale secret" }] };
    });
    expect(await output("job1", "cron_job1_1", "work")).toMatchObject({
      success: false,
      output: "",
    });
  },
);

it("uses the profile bound in a target when the redundant profile argument is omitted", async () => {
  state.connection.mode = "remote";
  const target = cron.captureProfileEditorTarget("work", "one");
  const { remoteDashboardRequestJson } = await import("./remote-api");
  const request = vi
    .mocked(remoteDashboardRequestJson)
    .mockReset()
    .mockResolvedValue({ runs: [{ id: "cron_job1_1" }] });
  expect(await list("job1", 1, undefined, target)).toMatchObject({
    success: true,
    runs: [{ id: "cron_job1_1" }],
  });
  expect(request).toHaveBeenLastCalledWith(
    expect.any(Object),
    "/api/cron/jobs/job1/runs?limit=1&profile=work",
    {},
    "work",
  );
});
it.each([undefined, null, 123])(
  "rejects a non-string job ID %j rather than coercing it to a path segment",
  async (id) => {
    expect(await list(id as unknown as string)).toMatchObject({
      success: false,
      runs: [],
    });
  },
);

it.each(["list", "output"])(
  "discards %s data if its job directory becomes a symlink during the read",
  async (operation) => {
    const dir = join(state.home, "profiles", "work", "cron", "output", "job1");
    const outside = join(state.home, "outside");
    await mkdir(dir, { recursive: true });
    await mkdir(outside);
    await writeFile(join(dir, "run.md"), "selected profile output");
    await writeFile(join(outside, "run.md"), "outside private output");
    fileHooks.beforeOpen = async () => {
      fileHooks.beforeOpen = undefined;
      await rename(dir, `${dir}-parked`);
      await symlink(outside, dir);
    };
    if (operation === "list")
      expect(await list("job1", 1, "work")).toMatchObject({
        success: false,
        runs: [],
      });
    else
      expect(await output("job1", "file:run.md", "work")).toMatchObject({
        success: false,
        output: "",
      });
  },
);

it.each(["list", "output"])(
  "rechecks the captured identity at the final %s return boundary",
  async (operation) => {
    state.connection.mode = "remote";
    const { remoteDashboardRequestJson } = await import("./remote-api");
    const request = vi.mocked(remoteDashboardRequestJson).mockReset();
    if (operation === "output")
      request.mockResolvedValueOnce({
        runs: [{ id: "cron_job1_1", source: "cron" }],
      });
    request.mockImplementationOnce(async () => {
      queueMicrotask(() =>
        queueMicrotask(() => {
          state.activeId = "two";
        }),
      );
      return operation === "list"
        ? { runs: [{ id: "cron_job1_1", preview: "stale" }] }
        : { messages: [{ role: "assistant", content: "stale" }] };
    });
    if (operation === "list")
      expect(await list("job1", 1, "work")).toMatchObject({
        success: false,
        runs: [],
      });
    else
      expect(await output("job1", "cron_job1_1", "work")).toMatchObject({
        success: false,
        output: "",
      });
  },
);
it("returns an explicit failure even if the transport rejects with null", async () => {
  state.connection.mode = "remote";
  const { remoteDashboardRequestJson } = await import("./remote-api");
  vi.mocked(remoteDashboardRequestJson).mockReset().mockRejectedValue(null);
  expect(await list("job1")).toMatchObject({ success: false, runs: [] });
});

it("fences the actual login/logout IPC callbacks while their authentication action runs", async () => {
  state.connection.mode = "remote";
  const { remoteDashboardRequestJson } = await import("./remote-api");
  vi.mocked(remoteDashboardRequestJson)
    .mockReset()
    .mockResolvedValue({ runs: [] });
  const source = readFileSync(
    join(process.cwd(), "src/main/ipc/register.ts"),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "register.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const handlers = new Map<string, () => Promise<unknown>>();
  const authAction = vi.fn(async () => {
    expect(await list("job1", 1, "work")).toMatchObject({
      success: false,
      runs: [],
    });
    return { signedIn: true };
  });
  const scope = {
    ipcMain: {
      handle: (channel: string, fn: () => Promise<unknown>) =>
        handlers.set(channel, fn),
    },
    getConnectionConfig: () => state.connection,
    withCronHistoryAuthChange: cron.withCronHistoryAuthChange,
    openRemoteOAuthLogin: authAction,
    clearRemoteOAuthSession: authAction,
    context: { getMainWindow: () => null },
    setConnectionConfig: vi.fn(),
    connectionConfigAfterRemoteOAuthLogin: () => state.connection,
    notifyConnectionConfigChanged: vi.fn(),
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "ipcMain.handle" &&
      ts.isStringLiteral(node.arguments[0]) &&
      ["remote-oauth-login", "remote-oauth-logout"].includes(
        node.arguments[0].text,
      )
    ) {
      new Function(
        ...Object.keys(scope),
        ts.transpile(node.getText(ast), { target: ts.ScriptTarget.ES2022 }),
      )(...Object.values(scope));
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const channel of ["remote-oauth-login", "remote-oauth-logout"]) {
    const target = cron.captureProfileEditorTarget("work", "one");
    expect(handlers.has(channel)).toBe(true);
    await handlers.get(channel)!();
    expect(await list("job1", 1, "work", target)).toMatchObject({
      success: false,
      runs: [],
    });
  }
  expect(authAction).toHaveBeenCalledTimes(2);
});

// Run the actual IPC registration and preload subscription with only the Electron
// transport substituted. Notifications below originate in auth/cookie producers.
function registerAuthProducer(
  action: () => Promise<unknown>,
  initiallyReady = true,
): {
  handlers: Map<string, (...args: unknown[]) => unknown>;
  cookies: EventEmitter;
  notify: Mock<() => boolean>;
  subscribe: (callback: () => void) => () => void;
  fromPartition: Mock<() => { cookies: EventEmitter }>;
  becomeReady: () => void;
} {
  const renderer = new EventEmitter();
  const cookies = new EventEmitter();
  let ready = initiallyReady;
  const app = Object.assign(new EventEmitter(), { isReady: () => ready });
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const notify = vi.fn(() =>
    renderer.emit("connection-config-changed", {}, {}),
  );
  const fromPartition = vi.fn(() => {
    if (!ready) throw new Error("Session used before ready");
    return { cookies };
  });
  const scope = {
    app,
    session: { fromPartition },
    REMOTE_OAUTH_PARTITION: "fixture-oauth",
    observeCronHistoryCookies: cron.observeCronHistoryCookies,
    withCronHistoryAuthChange: cron.withCronHistoryAuthChange,
    captureProfileEditorTarget: cron.captureProfileEditorTarget,
    listCronRuns: cron.listCronRuns,
    getCronRunOutput: cron.getCronRunOutput,
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
        handlers.set(channel, fn),
      on: vi.fn(),
    },
    context: {
      getMainWindow: () => null,
      notifyConnectionConfigChanged: notify,
    },
    getConnectionConfig: () => state.connection,
    openRemoteOAuthLogin: action,
    clearRemoteOAuthSession: action,
    probeRemoteAuthMode: vi.fn(async () => ({ authMode: "oauth" })),
    setConnectionConfig: vi.fn(),
    resolveConnectionApiKeyUpdate: () => state.connection.apiKey,
    resetSshDashboardAvailability: vi.fn(),
    clearAgentCapabilityEvidence: vi.fn(),
    getActiveConnection: () => ({ connectionId: state.activeId }),
    connectionConfigAfterRemoteOAuthLogin: () => state.connection,
  };
  const source = readFileSync(
    join(process.cwd(), "src/main/ipc/register.ts"),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "register.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const registration = ast.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "registerIpcHandlers",
  );
  new Function(
    ...Object.keys(scope),
    ts.transpile(registration!.body!.getText(ast), {
      target: ts.ScriptTarget.ES2022,
    }),
  )(...Object.values(scope));
  const preloadSource = readFileSync(
    join(process.cwd(), "src/preload/index.ts"),
    "utf8",
  );
  const preload = ts.createSourceFile(
    "preload.ts",
    preloadSource,
    ts.ScriptTarget.Latest,
    true,
  );
  let subscription: ts.PropertyAssignment | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(preload) === "onConnectionConfigChanged"
    )
      subscription = node;
    ts.forEachChild(node, visit);
  };
  visit(preload);
  const subscribe = new Function(
    "ipcRenderer",
    ts.transpile(`return (${subscription!.initializer.getText(preload)});`, {
      target: ts.ScriptTarget.ES2022,
    }),
  )(renderer) as (callback: () => void) => () => void;
  return {
    handlers,
    cookies,
    notify,
    subscribe,
    fromPartition,
    becomeReady: () => {
      ready = true;
      app.emit("ready");
    },
  };
}

it.each(["success", "cancelled"])(
  "notifies the actual connect subscriber during pending and %s OAuth without cookie events",
  async (outcome) => {
    state.connection.mode = "remote";
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const failure = new Error("fixture OAuth cancelled");
    const producer = registerAuthProducer(
      () =>
        new Promise<void>((resolve, reject) => {
          finish = () => (outcome === "success" ? resolve() : reject(failure));
          started();
        }),
    );
    const before = cron.captureProfileEditorTarget("work", "one");
    let mountedOutput = "private output";
    const observations: string[] = [];
    const listener = vi.fn(() => {
      mountedOutput = "";
      try {
        observations.push(
          cron.captureProfileEditorTarget("work", "one").scopeToken,
        );
      } catch (error) {
        observations.push((error as Error).message);
      }
    });
    const unsubscribe = producer.subscribe(listener);
    const pending = producer.handlers.get("connect-remote-gateway")!(
      {},
      state.connection.remoteUrl,
    ) as Promise<unknown>;
    await entered;
    const pendingCalls = listener.mock.calls.length;
    const pendingOutput = mountedOutput;
    const fenced = await list("job1", 1, "work", before);
    finish();
    if (outcome === "success")
      await expect(pending).resolves.toEqual({
        connected: true,
        authMode: "oauth",
      });
    else await expect(pending).rejects.toBe(failure);
    const after = cron.captureProfileEditorTarget("work", "one");
    const revoked = await list("job1", 1, "work", before);
    unsubscribe();

    expect(pendingCalls).toBe(1);
    expect(pendingOutput).toBe("");
    expect(fenced).toMatchObject({ success: false, runs: [] });
    expect(revoked).toMatchObject({ success: false, runs: [] });
    expect(after.scopeToken).not.toBe(before.scopeToken);
    expect(listener).toHaveBeenCalledTimes(outcome === "success" ? 3 : 2);
    expect(observations[0]).toMatch(/sign-in is changing/);
    expect(observations[1]).toBe(after.scopeToken);
    expect(producer.notify).toHaveBeenCalledTimes(
      outcome === "success" ? 3 : 2,
    );
  },
);

it.each(["success", "cancelled"])(
  "preserves connect OAuth %s when begin/end renderer notifications throw",
  async (outcome) => {
    state.connection.mode = "remote";
    const failure = new Error("fixture OAuth cancelled");
    const action = vi.fn(async () => {
      if (outcome === "cancelled") throw failure;
      return { signedIn: true, fixture: "ignored OAuth result" };
    });
    const producer = registerAuthProducer(action);
    const listener = vi.fn();
    const unsubscribe = producer.subscribe(listener);
    const before = cron.captureProfileEditorTarget("work", "one");
    // Keep the existing final config notification intact; only auth-transition
    // delivery fails, as it can when its renderer window has been destroyed.
    producer.notify
      .mockImplementationOnce(() => {
        throw new Error("begin window destroyed");
      })
      .mockImplementationOnce(() => {
        throw new Error("end window destroyed");
      });
    const pending = producer.handlers.get("connect-remote-gateway")!(
      {},
      `  ${state.connection.remoteUrl}  `,
    );
    if (outcome === "success")
      await expect(pending).resolves.toEqual({
        connected: true,
        authMode: "oauth",
      });
    else await expect(pending).rejects.toBe(failure);
    expect(action).toHaveBeenCalledExactlyOnceWith(
      state.connection.remoteUrl,
      null,
    );
    expect(producer.notify).toHaveBeenCalledTimes(
      outcome === "success" ? 3 : 2,
    );
    expect(listener).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
    expect(cron.captureProfileEditorTarget("work", "one").scopeToken).not.toBe(
      before.scopeToken,
    );
    expect(await list("job1", 1, "work", before)).toMatchObject({
      success: false,
      runs: [],
    });
    unsubscribe();
  },
);

it("retires subscribed private history at actual logout begin and end, and revokes main targets", async () => {
  state.connection.mode = "remote";
  let finish!: () => void;
  const producer = registerAuthProducer(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const before = cron.captureProfileEditorTarget("work", "one");
  let mountedOutput = "private output";
  const listener = vi.fn(() => {
    mountedOutput = "";
  });
  const unsubscribe = producer.subscribe(listener);
  const pending = producer.handlers.get("remote-oauth-logout")!();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(mountedOutput).toBe("");
  expect(() => cron.captureProfileEditorTarget("work", "one")).toThrow(
    /sign-in is changing/,
  );
  finish();
  await expect(pending).resolves.toEqual({ signedIn: false });
  expect(listener).toHaveBeenCalledTimes(2);
  expect(cron.captureProfileEditorTarget("work", "one").scopeToken).not.toBe(
    before.scopeToken,
  );
  unsubscribe();
  producer.cookies.emit("changed");
  expect(listener).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "delivers cookie invalidation through the registered subscription with ready=%s",
  async (initiallyReady) => {
    state.connection.mode = "remote";
    const producer = registerAuthProducer(
      async () => undefined,
      initiallyReady,
    );
    const listener = vi.fn();
    const unsubscribe = producer.subscribe(listener);
    expect(producer.fromPartition).toHaveBeenCalledTimes(
      initiallyReady ? 1 : 0,
    );
    producer.becomeReady();
    expect(producer.fromPartition).toHaveBeenCalledTimes(1);
    expect(producer.cookies.listenerCount("changed")).toBe(1);
    const before = cron.captureProfileEditorTarget("work", "one");
    producer.cookies.emit("changed", {}, { name: "fixture-cookie" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({});
    expect(cron.captureProfileEditorTarget("work", "one").scopeToken).not.toBe(
      before.scopeToken,
    );
    producer.notify.mockImplementation(() => {
      throw new Error("window destroyed");
    });
    const next = cron.captureProfileEditorTarget("work", "one");
    expect(() =>
      producer.cookies.emit("changed", {}, { name: "fixture-cookie" }),
    ).not.toThrow();
    expect(cron.captureProfileEditorTarget("work", "one").scopeToken).not.toBe(
      next.scopeToken,
    );
    unsubscribe();
  },
);

it("notifies the actual login subscriber before and after sign-in while preserving its result", async () => {
  state.connection.mode = "remote";
  let finish!: (value: unknown) => void;
  const result = { signedIn: true, fixture: "return-value" };
  const producer = registerAuthProducer(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const before = cron.captureProfileEditorTarget("work", "one");
  const listener = vi.fn();
  const unsubscribe = producer.subscribe(listener);
  const pending = producer.handlers.get("remote-oauth-login")!();
  expect(listener).toHaveBeenCalledTimes(1);
  finish(result);
  await expect(pending).resolves.toBe(result);
  expect(listener).toHaveBeenCalledTimes(2);
  expect(cron.captureProfileEditorTarget("work", "one").scopeToken).not.toBe(
    before.scopeToken,
  );
  unsubscribe();
});

it.each(["remote-oauth-login", "remote-oauth-logout"])(
  "keeps %s results and original errors when UI delivery throws and no window exists",
  async (channel) => {
    state.connection.mode = "remote";
    const result = { signedIn: true };
    const failure = new Error("fixture auth failure");
    const action = vi
      .fn()
      .mockResolvedValueOnce(result)
      .mockRejectedValueOnce(failure);
    const producer = registerAuthProducer(action);
    producer.notify.mockImplementation(() => {
      throw new Error("window destroyed");
    });
    await expect(producer.handlers.get(channel)!()).resolves.toEqual(
      channel === "remote-oauth-login" ? result : { signedIn: false },
    );
    const target = cron.captureProfileEditorTarget("work", "one");
    await expect(producer.handlers.get(channel)!()).rejects.toBe(failure);
    expect(action).toHaveBeenCalledTimes(2);
    expect(producer.notify).toHaveBeenCalledTimes(4);
    expect(cron.captureProfileEditorTarget("work", "one").scopeToken).not.toBe(
      target.scopeToken,
    );
  },
);
