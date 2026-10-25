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
  slug: "default",
  name: "Default",
  is_current: true,
  total: 2,
  counts: {},
};
const fixtureTask = (status: string, id: string): Record<string, unknown> => ({
  id,
  title: `Fixture ${id}`,
  status,
  priority: 0,
  created_at: 1,
  skills: [],
});

function setup(status = "ready"): {
  block: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  archive: ReturnType<typeof vi.fn>;
  schedule: ReturnType<typeof vi.fn>;
  listTasks: ReturnType<typeof vi.fn>;
} {
  let current = [fixtureTask(status, "t_fixture")];
  const block = vi.fn(
    async (): Promise<{ success: boolean; error?: string }> => {
      current = [fixtureTask("blocked", "t_fixture")];
      return { success: true };
    },
  );
  const complete = vi.fn(async (): Promise<{ success: boolean }> => {
    current = [fixtureTask("done", "t_fixture")];
    return { success: true };
  });
  const archive = vi.fn(async (): Promise<{ success: boolean }> => {
    current = [fixtureTask("archived", "t_fixture")];
    return { success: true };
  });
  const schedule = vi.fn(async (): Promise<{ success: boolean }> => {
    current = [fixtureTask("scheduled", "t_fixture")];
    return { success: true };
  });
  const listTasks = vi.fn(async () => ({ success: true, data: current }));
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: {
      kanbanListBoards: vi.fn(async () => ({ success: true, data: [board] })),
      kanbanListTasks: listTasks,
      kanbanListClaw3dHqTasks: vi.fn(async () => ({ success: false })),
      getConnectionConfig: vi.fn(async () => ({
        connectionId: "local",
        mode: "local",
        remoteUrl: "",
      })),
      onConnectionConfigChanged: vi.fn(() => () => {}),
      kanbanBlockTask: block,
      kanbanCompleteTask: complete,
      kanbanArchiveTask: archive,
      kanbanScheduleTask: schedule,
    },
  });
  return { block, complete, archive, schedule, listTasks };
}

async function dragTo(targetStatus: string): Promise<void> {
  const card = document.querySelector(".kanban-card");
  const column = [...document.querySelectorAll(".kanban-column")].find(
    (el) =>
      el.querySelector(".kanban-column-title")?.textContent ===
      `kanban.status.${targetStatus}`,
  );
  if (!card || !column) throw new Error("Missing drag fixture");
  await act(async () => {
    fireEvent.dragStart(card, {
      dataTransfer: { effectAllowed: "move", setData: vi.fn() },
    });
  });
  await act(async () => {
    fireEvent.dragOver(column, { dataTransfer: { dropEffect: "move" } });
  });
  await act(async () => {
    fireEvent.drop(column, { dataTransfer: { dropEffect: "move" } });
  });
}

describe("Kanban drag transitions", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("asks for a block reason in an app dialog before moving a ready card", async () => {
    const { block } = setup();
    const nativePrompt = vi.spyOn(window, "prompt").mockReturnValue(null);
    render(<Kanban profile="default" visible={false} />);
    await screen.findByText("Fixture t_fixture");
    await dragTo("blocked");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(block).not.toHaveBeenCalled();
    expect(nativePrompt).not.toHaveBeenCalled();
  });

  it("moves a card only after the block reason is submitted and reloads the saved status", async () => {
    const { block } = setup();
    render(<Kanban profile="default" visible={false} />);
    await screen.findByText("Fixture t_fixture");
    await dragTo("blocked");
    fireEvent.change(
      screen.getByRole("textbox", { name: "kanban.blockReasonPrompt" }),
      {
        target: { value: "waiting on review" },
      },
    );
    fireEvent.click(screen.getByRole("dialog").querySelector(".btn-primary")!);
    await waitFor(() =>
      expect(block).toHaveBeenCalledWith(
        "t_fixture",
        "waiting on review",
        "default",
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByText("Fixture t_fixture").closest(".kanban-column")
          ?.textContent,
      ).toContain("kanban.status.blocked"),
    );
  });

  it("keeps the card in place and shows a backend rejection", async () => {
    const { block } = setup();
    block.mockImplementationOnce(async () => ({
      success: false,
      error: "Move rejected",
    }));
    render(<Kanban profile="default" visible={false} />);
    await screen.findByText("Fixture t_fixture");
    await dragTo("blocked");
    fireEvent.click(screen.getByRole("dialog").querySelector(".btn-primary")!);
    await screen.findByText("Move rejected");
    expect(
      screen.getByText("Fixture t_fixture").closest(".kanban-column")
        ?.textContent,
    ).toContain("kanban.status.ready");
  });

  it("asks for confirmation inside the app before marking a card done", async () => {
    const { complete } = setup();
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Kanban profile="default" visible={false} />);
    await screen.findByText("Fixture t_fixture");
    await dragTo("done");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(complete).not.toHaveBeenCalled();
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it("commits a confirmed done drop and keeps it after refresh", async () => {
    const { complete } = setup();
    render(<Kanban profile="default" visible={false} />);
    await screen.findByText("Fixture t_fixture");
    await dragTo("done");
    fireEvent.click(screen.getByRole("dialog").querySelector(".btn-primary")!);
    await waitFor(() =>
      expect(complete).toHaveBeenCalledWith("t_fixture", undefined, "default"),
    );
    await waitFor(() =>
      expect(
        screen.getByText("Fixture t_fixture").closest(".kanban-column")
          ?.textContent,
      ).toContain("kanban.status.done"),
    );
    fireEvent.click(screen.getByText("kanban.refresh"));
    await waitFor(() =>
      expect(
        screen.getByText("Fixture t_fixture").closest(".kanban-column")
          ?.textContent,
      ).toContain("kanban.status.done"),
    );
  });

  it("does not archive a card when the confirmation is cancelled", async () => {
    const { archive } = setup();
    render(<Kanban profile="default" visible={false} />);
    await screen.findByText("Fixture t_fixture");
    fireEvent.click(screen.getByTitle("kanban.cardArchive"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole("button", { name: "common.cancel" })[0],
    );
    expect(archive).not.toHaveBeenCalled();
  });

  it("shows why a triage card cannot be dropped into todo", async () => {
    setup("triage");
    render(<Kanban profile="default" visible={false} />);
    await screen.findByText("Fixture t_fixture");
    await dragTo("todo");
    await waitFor(() =>
      expect(screen.getByText(/kanban.moveNotAllowed/)).toBeTruthy(),
    );
    expect(
      screen.getByText("Fixture t_fixture").closest(".kanban-column")
        ?.textContent,
    ).toContain("kanban.status.triage");
  });

  it("keeps an invalid-move error visible across a silent background refresh", async () => {
    setup("triage");
    render(<Kanban profile="default" visible />);
    await screen.findByText("Fixture t_fixture");
    await dragTo("todo");
    expect(screen.getByText(/kanban.moveNotAllowed/)).toBeTruthy();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByText(/kanban.moveNotAllowed/)).toBeTruthy();
  });

  it("does not send a second move for the same card while the first is pending", async () => {
    const { block } = setup();
    let resolveBlock: ((value: { success: boolean }) => void) | undefined;
    block.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBlock = resolve;
        }),
    );
    render(<Kanban profile="default" visible={false} />);
    await screen.findByText("Fixture t_fixture");
    await dragTo("blocked");
    fireEvent.click(screen.getByRole("dialog").querySelector(".btn-primary")!);
    expect(block).toHaveBeenCalledTimes(1);
    await dragTo("blocked");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(block).toHaveBeenCalledTimes(1);
    resolveBlock?.({ success: true });
    await waitFor(() =>
      expect(
        screen
          .getByText("Fixture t_fixture")
          .closest(".kanban-card")
          ?.getAttribute("draggable"),
      ).toBe("true"),
    );
  });

  it("moves ready to scheduled without a dialog", async () => {
    const { schedule } = setup();
    render(<Kanban profile="default" visible={false} />);
    await screen.findByText("Fixture t_fixture");
    await dragTo("scheduled");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(schedule).toHaveBeenCalledWith("t_fixture", undefined, "default"),
    );
    await waitFor(() =>
      expect(
        screen.getByText("Fixture t_fixture").closest(".kanban-column")
          ?.textContent,
      ).toContain("kanban.status.scheduled"),
    );
  });

  it("shows a rejected move without a dialog or a false status change", async () => {
    const { schedule } = setup();
    schedule.mockImplementationOnce(async () => ({
      success: false,
      error: "Schedule rejected",
    }));
    render(<Kanban profile="default" visible={false} />);
    await screen.findByText("Fixture t_fixture");
    await dragTo("scheduled");
    await screen.findByText("Schedule rejected");
    expect(
      screen.getByText("Fixture t_fixture").closest(".kanban-column")
        ?.textContent,
    ).toContain("kanban.status.ready");
  });

  it("shows an IPC rejection without leaving the board busy", async () => {
    const { schedule } = setup();
    schedule.mockRejectedValueOnce(new Error("Connection lost"));
    render(<Kanban profile="default" visible={false} />);
    await screen.findByText("Fixture t_fixture");
    await dragTo("scheduled");
    await screen.findByText("Connection lost");
    expect(
      screen.getByText("Fixture t_fixture").closest(".kanban-column")
        ?.textContent,
    ).toContain("kanban.status.ready");
  });

  it("ignores a stale poll response that arrives after a successful move", async () => {
    const { listTasks } = setup();
    render(<Kanban profile="default" visible />);
    await screen.findByText("Fixture t_fixture");
    let finishOldPoll:
      | ((result: { success: boolean; data: unknown[] }) => void)
      | undefined;
    listTasks.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldPoll = resolve;
        }),
    );
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(finishOldPoll).toBeDefined());
    await dragTo("scheduled");
    await waitFor(() =>
      expect(
        screen.getByText("Fixture t_fixture").closest(".kanban-column")
          ?.textContent,
      ).toContain("kanban.status.scheduled"),
    );
    await act(async () => {
      finishOldPoll?.({
        success: true,
        data: [fixtureTask("ready", "t_fixture")],
      });
    });
    expect(
      screen.getByText("Fixture t_fixture").closest(".kanban-column")
        ?.textContent,
    ).toContain("kanban.status.scheduled");
  });

  it("applies a slow poll while the next poll is still pending", async () => {
    const { listTasks } = setup();
    render(<Kanban profile="default" visible />);
    await screen.findByText("Fixture t_fixture");
    const resolvers: Array<
      (result: { success: boolean; data: unknown[] }) => void
    > = [];
    listTasks.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    listTasks.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(resolvers).toHaveLength(2);
    await act(async () => {
      resolvers[0]({
        success: true,
        data: [fixtureTask("scheduled", "t_fixture")],
      });
    });
    expect(
      screen.getByText("Fixture t_fixture").closest(".kanban-column")
        ?.textContent,
    ).toContain("kanban.status.scheduled");
    await act(async () => {
      resolvers[1]({
        success: true,
        data: [fixtureTask("scheduled", "t_fixture")],
      });
    });
  });
});
