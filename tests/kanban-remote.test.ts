import { beforeEach, describe, expect, it, vi } from "vitest";

// Remote (direct HTTP) Kanban: kanban.ts must route every IPC through the
// dashboard kanban plugin adapter (kanban-remote.ts) instead of returning the
// unsupportedInRemote stub, and a 404 from a plugin-less server must come back
// as `unsupportedMode` so the renderer shows its "update the agent" notice.

const { connectionRef, requestSpy, requestImpl } = vi.hoisted(() => {
  return {
    connectionRef: {
      value: {
        mode: "remote" as "ssh" | "remote",
        remoteUrl: "http://127.0.0.1:9339",
        apiKey: "parity-test-token",
      },
    },
    requestSpy: vi.fn(),
    requestImpl: { value: async (..._args: unknown[]) => ({}) as unknown },
  };
});

vi.mock("../src/main/config", () => ({
  getConnectionConfig: () => connectionRef.value,
  readDesktopConfig: () => ({}),
}));

vi.mock("../src/main/hermes", () => ({
  isRemoteOnlyMode: () => connectionRef.value.mode === "remote",
}));

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: "/tmp/hermes-test",
  HERMES_PYTHON: "/tmp/hermes-test/venv/bin/python",
  hermesCliArgs: (args: string[] = []) => ["-m", "hermes_cli.main", ...args],
  getEnhancedPath: () => "",
}));

vi.mock("../src/main/ssh-remote", () => ({
  sshRunKanban: vi.fn(),
  sshListClaw3dHqTasks: vi.fn(),
}));

vi.mock("../src/main/remote-api", () => ({
  RemoteDashboardApiError: class RemoteDashboardApiError extends Error {
    readonly statusCode?: number;
    constructor(message: string, statusCode?: number) {
      super(message);
      this.name = "RemoteDashboardApiError";
      this.statusCode = statusCode;
    }
  },
  remoteDashboardRequestJson: async (...args: unknown[]) => {
    requestSpy(...args);
    return requestImpl.value(...args);
  },
}));

import { RemoteDashboardApiError } from "../src/main/remote-api";
import {
  listBoards,
  currentBoard,
  switchBoard,
  createBoard,
  removeBoard,
  listTasks,
  getTask,
  createTask,
  assignTask,
  completeTask,
  blockTask,
  unblockTask,
  archiveTask,
  promoteTask,
  scheduleTask,
  specifyTask,
  reclaimTask,
  commentTask,
  dispatchOnce,
  unsupportedInRemote,
} from "../src/main/kanban";

// @lat: [[kanban#Remote plugin transport tests#Routes every verb to the plugin API]]
beforeEach(() => {
  requestSpy.mockReset();
  vi.clearAllMocks();
});

function stubRequest(value: unknown): void {
  requestImpl.value = async () => value;
}

function stubRequestError(err: unknown): void {
  requestImpl.value = async () => {
    throw err;
  };
}

function lastCall(): {
  path: string;
  opts: { method?: string; body?: unknown };
} {
  // remoteDashboardRequestJson(connection, path, options, profile)
  const [path, opts] = (requestSpy.mock.calls.at(-1) as unknown[]).slice(1);
  return {
    path: path as string,
    opts: (opts ?? {}) as { method?: string; body?: unknown },
  };
}

describe("remote kanban routing", () => {
  it("routes listBoards through the dashboard plugin", async () => {
    stubRequest({
      boards: [
        {
          slug: "default",
          name: "Default",
          is_current: true,
          total: 2,
          counts: { todo: 1, done: 1 },
        },
      ],
      current: "default",
    });
    const res = await listBoards(false);
    expect(res.success).toBe(true);
    expect(lastCall().path).toBe("/api/plugins/kanban/boards");
    expect(res.data?.[0]).toMatchObject({
      slug: "default",
      name: "Default",
      is_current: true,
      total: 2,
    });
  });

  it("derives currentBoard from the boards payload", async () => {
    stubRequest({ boards: [], current: "ops" });
    const res = await currentBoard();
    expect(res).toEqual({ success: true, data: "ops" });
  });

  it("switches and creates/removes boards via plugin routes", async () => {
    stubRequest({ current: "ops" });
    await switchBoard("ops");
    expect(lastCall()).toEqual({
      path: "/api/plugins/kanban/boards/ops/switch",
      opts: { method: "POST" },
    });
    await createBoard("lab", "Lab", true);
    expect(lastCall().path).toBe("/api/plugins/kanban/boards");
    expect(lastCall().opts).toEqual({
      method: "POST",
      body: { slug: "lab", name: "Lab", switch: true },
    });
    await removeBoard("lab", true);
    expect(lastCall()).toEqual({
      path: "/api/plugins/kanban/boards/lab?delete=true",
      opts: { method: "DELETE" },
    });
  });

  it("flattens the /board column view and applies list filters", async () => {
    stubRequest({
      columns: [
        { name: "todo", tasks: [{ id: "t1", title: "A", status: "todo" }] },
        { name: "done", tasks: [{ id: "t2", title: "B", status: "done" }] },
      ],
    });
    const res = await listTasks({});
    expect(res.success).toBe(true);
    expect(res.data?.map((t) => t.id)).toEqual(["t1", "t2"]);
    const filtered = await listTasks({ status: "done" });
    expect(filtered.data?.map((t) => t.id)).toEqual(["t2"]);
  });

  it("adapts the task detail payload to the CLI shape", async () => {
    stubRequest({
      task: {
        id: "t1",
        title: "A",
        status: "todo",
        priority: 3,
        latest_summary: "sum",
      },
      comments: [
        { id: 5, task_id: "t1", author: "me", body: "hi", created_at: 1 },
      ],
      events: [
        {
          id: 9,
          task_id: "t1",
          kind: "status",
          payload: { status: "todo" },
          created_at: 2,
        },
      ],
      runs: [{ id: 1, task_id: "t1", status: "reclaimed", started_at: 3 }],
      links: { parents: ["p1"], children: ["c1"] },
    });
    const res = await getTask("t1");
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({
      parents: ["p1"],
      children: ["c1"],
      latest_summary: "sum",
    });
    expect(res.data?.task.id).toBe("t1");
    expect(res.data?.comments[0].body).toBe("hi");
    expect(res.data?.runs[0].status).toBe("reclaimed");
  });

  it("creates tasks with CLI workspace syntax mapped to plugin fields", async () => {
    stubRequest({ task: { id: "new1" } });
    const res = await createTask({
      title: "T",
      body: "B",
      workspace: "dir:/tmp/x",
      priority: 2,
    });
    expect(res.success).toBe(true);
    expect(res.data?.id).toBe("new1");
    expect(lastCall().opts.body).toMatchObject({
      title: "T",
      workspace_kind: "dir",
      workspace_path: "/tmp/x",
      priority: 2,
    });
  });

  it("maps every status verb onto the plugin PATCH route", async () => {
    stubRequest({ task: { id: "t1" } });
    await completeTask("t1", "done text");
    expect(lastCall().opts).toEqual({
      method: "PATCH",
      body: { status: "done", result: "done text" },
    });
    await blockTask("t1", "waiting");
    expect(lastCall().opts.body).toEqual({
      status: "blocked",
      block_reason: "waiting",
    });
    await unblockTask("t1");
    expect(lastCall().opts.body).toEqual({ status: "ready" });
    await promoteTask("t1");
    expect(lastCall().opts.body).toEqual({ status: "ready" });
    await scheduleTask("t1", "later");
    expect(lastCall().opts.body).toEqual({
      status: "scheduled",
      block_reason: "later",
    });
    await archiveTask("t1");
    expect(lastCall().opts.body).toEqual({ status: "archived" });
    await assignTask("t1", null);
    expect(lastCall().opts.body).toEqual({ assignee: "" });
  });

  it("posts comments to the comments route, not the task body", async () => {
    stubRequest({ ok: true });
    await commentTask("t1", "note");
    expect(lastCall()).toEqual({
      path: "/api/plugins/kanban/tasks/t1/comments",
      opts: { method: "POST", body: { body: "note", author: "desktop" } },
    });
  });

  it("surfaces specify's inline failure reason", async () => {
    stubRequest({ ok: false, reason: "aux client not configured" });
    const res = await specifyTask("t1");
    expect(res.success).toBe(false);
    expect(res.error).toContain("aux client");
  });

  it("dispatches via POST /dispatch", async () => {
    stubRequest({ spawned: 0 });
    const res = await dispatchOnce(false);
    expect(res.success).toBe(true);
    expect(lastCall()).toEqual({
      path: "/api/plugins/kanban/dispatch",
      opts: { method: "POST" },
    });
  });

  it("reclaims via the dedicated reclaim route", async () => {
    stubRequest({ ok: true, task_id: "t1" });
    const res = await reclaimTask("t1", "stale");
    expect(res.success).toBe(true);
    expect(lastCall()).toEqual({
      path: "/api/plugins/kanban/tasks/t1/reclaim",
      opts: { method: "POST", body: { reason: "stale" } },
    });
  });
});

describe("plugin-less server fallback", () => {
  it("maps a 404 RemoteDashboardApiError to unsupportedMode", async () => {
    stubRequestError(new RemoteDashboardApiError("404: Not Found", 404));
    const res = await listBoards(false);
    expect(res.success).toBe(false);
    expect(res.unsupportedMode).toBe(true);
    expect(res.error).toContain("kanban");
  });

  it("keeps a non-404 failure a plain error (not a mode problem)", async () => {
    stubRequestError(new Error("500: boom"));
    const res = await listBoards(false);
    expect(res.success).toBe(false);
    expect(res.unsupportedMode).toBeUndefined();
    expect(res.error).toContain("500");
  });

  it("keeps unsupportedInRemote() as the explicit unsupported-mode signal", () => {
    const res = unsupportedInRemote();
    expect(res.unsupportedMode).toBe(true);
    expect(res.error).toBeTruthy();
  });
});
