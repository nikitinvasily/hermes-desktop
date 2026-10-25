import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/useI18n", () => {
  const t = (key: string, options?: Record<string, string>): string =>
    options ? `${key}:${Object.values(options).join("/")}` : key;
  return { useI18n: () => ({ t, locale: "en", setLocale: () => {} }) };
});

import Kanban from "./Kanban";

const board = {
  slug: "fixture",
  name: "Fixture board",
  is_current: true,
  total: 1,
  counts: {},
};

function setup(
  status = "ready",
  initialAssignee: string | null = null,
): {
  assign: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
  listProfiles: ReturnType<typeof vi.fn>;
  getTask: ReturnType<typeof vi.fn>;
  changeConnection: () => void;
} {
  let assignee: string | null = initialAssignee;
  let connectionListener:
    | ((config: {
        connectionId: string;
        mode: string;
        remoteUrl: string;
      }) => void)
    | null = null;
  const task = (): Record<string, unknown> => ({
    id: "t_disposable",
    title: "Disposable task",
    status,
    assignee,
    priority: 0,
    created_at: 1,
    skills: [],
  });
  const assign = vi.fn(
    async (
      _taskId: string,
      next: string | null,
    ): Promise<{ success: boolean; error?: string }> => {
      assignee = next;
      return { success: true };
    },
  );
  const dispatch = vi.fn(async () => ({
    success: true,
    data: {
      spawned: [],
      skipped_unassigned: ["t_disposable"],
    },
  }));
  const listProfiles = vi.fn(async () => [
    { id: "default", name: "Default" },
    { id: "worker", name: "Worker" },
  ]);
  const getTask = vi.fn(async () => ({
    success: true,
    data: { task: task(), comments: [], events: [], runs: [] },
  }));
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: {
      kanbanListBoards: vi.fn(async () => ({ success: true, data: [board] })),
      kanbanListTasks: vi.fn(async () => ({ success: true, data: [task()] })),
      kanbanListClaw3dHqTasks: vi.fn(async () => ({ success: false })),
      getConnectionConfig: vi.fn(async () => ({
        connectionId: "local",
        mode: "local",
        remoteUrl: "",
      })),
      onConnectionConfigChanged: vi.fn((listener) => {
        connectionListener = listener;
        return (): void => {
          connectionListener = null;
        };
      }),
      listProfiles,
      kanbanGetTask: getTask,
      kanbanAssignTask: assign,
      kanbanDispatchOnce: dispatch,
    },
  });
  return {
    assign,
    dispatch,
    listProfiles,
    getTask,
    changeConnection: (): void => {
      connectionListener?.({
        connectionId: "other-agent",
        mode: "remote",
        remoteUrl: "http://127.0.0.1:59999",
      });
    },
  };
}

async function openTask(): Promise<void> {
  fireEvent.click(await screen.findByText("Disposable task"));
  await screen.findByText("kanban.fieldAssignee");
}

describe("Kanban task assignment", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("requires explicit confirmation before assigning a Ready task and does not dispatch on save", async () => {
    const { assign, dispatch } = setup();
    render(<Kanban profile="default" visible={false} />);
    await openTask();
    await screen.findByRole("option", { name: "Default" });
    fireEvent.change(
      screen.getByRole("combobox", { name: "kanban.fieldAssignee" }),
      {
        target: { value: "default" },
      },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "kanban.saveAssignee" }),
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "kanban.assignWarning",
    );
    expect(assign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(assign).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "kanban.saveAssignee" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "kanban.confirmAssign" }),
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "t_disposable",
        "default",
        "default",
        "local",
      ),
    );
    await waitFor(() => expect(screen.getByText("@default")).toBeTruthy());
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("explains an unassigned Dispatch skip and opens the skipped task to assign it", async () => {
    const { assign, dispatch } = setup();
    render(<Kanban profile="default" visible={false} />);
    await screen.findByText("Disposable task");
    fireEvent.click(screen.getByRole("button", { name: "kanban.dispatch" }));
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(false, "default"),
    );
    expect(screen.getByRole("status").textContent).toContain("t_disposable");
    expect(screen.getByRole("status").textContent).toContain(
      "kanban.dispatchSkippedUnassigned",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "kanban.assignSkipped" }),
    );
    await screen.findByRole("combobox", { name: "kanban.fieldAssignee" });
    expect(assign).not.toHaveBeenCalled();
  });

  it("does not announce an assignment on rejection and keeps the selected profile for retry", async () => {
    const { assign } = setup();
    assign.mockResolvedValueOnce({
      success: false,
      error: "Assignment rejected",
    });
    render(<Kanban profile="default" visible={false} />);
    await openTask();
    await screen.findByRole("option", { name: "Worker" });
    fireEvent.change(
      screen.getByRole("combobox", { name: "kanban.fieldAssignee" }),
      {
        target: { value: "worker" },
      },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "kanban.saveAssignee" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "kanban.confirmAssign" }),
    );
    await screen.findByText("Assignment rejected");
    expect(screen.queryByText("@worker")).toBeNull();
    expect(
      (
        screen.getByRole("combobox", {
          name: "kanban.fieldAssignee",
        }) as HTMLSelectElement
      ).value,
    ).toBe("worker");
  });

  it("does not save an unchanged empty assignee", async () => {
    setup("todo");
    render(<Kanban profile="default" visible={false} />);
    await openTask();
    await screen.findByRole("option", { name: "Worker" });
    expect(
      screen.getByRole("combobox", { name: "kanban.fieldAssignee" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "kanban.saveAssignee" }),
    ).toHaveProperty("disabled", true);
  });

  it("does not hide started workers when another card was skipped", async () => {
    const { dispatch } = setup();
    dispatch.mockResolvedValueOnce({
      success: true,
      data: {
        spawned: [{ task_id: "t_another", assignee: "default" }],
        skipped_unassigned: ["t_disposable"],
      },
    });
    render(<Kanban profile="default" visible={false} />);
    await screen.findByText("Disposable task");
    fireEvent.click(screen.getByRole("button", { name: "kanban.dispatch" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "kanban.dispatchStarted",
      ),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "kanban.dispatchSkippedUnassigned",
    );
  });

  it("allows unassigning even if no profiles can be listed", async () => {
    const { assign, listProfiles } = setup("ready", "default");
    listProfiles.mockResolvedValueOnce([]);
    render(<Kanban profile="default" visible={false} />);
    await openTask();
    expect(screen.queryByRole("option", { name: "Default" })).toBeNull();
    fireEvent.change(
      screen.getByRole("combobox", { name: "kanban.fieldAssignee" }),
      { target: { value: "" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "kanban.saveAssignee" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "kanban.confirmAssign" }),
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "t_disposable",
        null,
        "default",
        "local",
      ),
    );
  });

  it("closes the drawer on a connection change instead of assigning a stale card", async () => {
    const { assign, changeConnection } = setup();
    render(<Kanban profile="default" visible={false} />);
    await openTask();
    act(() => changeConnection());
    await waitFor(() =>
      expect(
        screen.queryByRole("combobox", { name: "kanban.fieldAssignee" }),
      ).toBeNull(),
    );
    expect(assign).not.toHaveBeenCalled();
  });
});
