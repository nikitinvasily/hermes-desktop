import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/useI18n", () => {
  const t = (key: string): string => key;
  return { useI18n: () => ({ t, locale: "en", setLocale: () => {} }) };
});

import Kanban from "./Kanban";

type Task = {
  id: string;
  title: string;
  status: string;
  priority: number;
  created_at: number | null;
  skills: string[];
};

function task(
  id: string,
  createdAt: number | null,
  priority = 0,
  status = "todo",
): Task {
  return { id, title: id, status, priority, created_at: createdAt, skills: [] };
}

function setup(
  initial: Task[],
  hq = false,
): {
  replace: (tasks: Task[]) => void;
  listTasks: ReturnType<typeof vi.fn>;
} {
  let tasks = initial;
  const listTasks = vi.fn(async (options: { includeArchived: boolean }) => ({
    success: true,
    data: tasks.filter(
      (row): boolean => options.includeArchived || row.status !== "archived",
    ),
  }));
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: {
      kanbanListBoards: vi.fn(async () => ({
        success: true,
        data: [
          {
            slug: "fixture",
            name: "Fixture",
            is_current: true,
            total: 0,
            counts: {},
          },
        ],
      })),
      kanbanListTasks: listTasks,
      kanbanListClaw3dHqTasks: vi.fn(async () => ({
        success: hq,
        data: tasks,
      })),
      getConnectionConfig: vi.fn(async () => ({
        connectionId: "local",
        mode: "local",
        remoteUrl: "",
      })),
      onConnectionConfigChanged: vi.fn(() => (): void => {}),
    },
  });
  return {
    replace: (next: Task[]): void => {
      tasks = next;
    },
    listTasks,
  };
}

function order(status = "todo"): string[] {
  const column = screen
    .getByText(`kanban.status.${status}`)
    .closest(".kanban-column");
  return Array.from(
    column!.querySelectorAll(".kanban-card-id"),
    (node): string => node.textContent!,
  );
}

function selectSort(value: string): void {
  fireEvent.change(screen.getByRole("combobox", { name: "kanban.sortLabel" }), {
    target: { value },
  });
}

async function mount(visible = false): Promise<ReturnType<typeof render>> {
  const view = render(<Kanban profile="default" visible={visible} />);
  await screen.findByText("kanban.title");
  return view;
}

describe("Kanban sorting", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("defaults to priority then oldest and can show newest regardless of priority", async () => {
    setup([
      task("low-new", 30),
      task("high-new", 20, 5),
      task("high-old", 10, 5),
    ]);
    await mount();
    expect(order()).toEqual(["high-old", "high-new", "low-new"]);
    expect(
      screen.getByRole("combobox", { name: "kanban.sortLabel" }),
    ).toHaveProperty("value", "priority");
    selectSort("newest");
    expect(order()).toEqual(["low-new", "high-new", "high-old"]);
    selectSort("priority");
    expect(order()).toEqual(["high-old", "high-new", "low-new"]);
  });

  it("keeps equal dates deterministic across server reorder and puts missing dates last", async () => {
    const rows = [
      task("z", 20),
      task("missing", null),
      task("a", 20),
      task("old", 10),
    ];
    const { replace } = setup(rows);
    await mount();
    selectSort("newest");
    expect(order()).toEqual(["a", "z", "old", "missing"]);
    replace([...rows].reverse());
    fireEvent.click(screen.getByRole("button", { name: "kanban.refresh" }));
    await screen.findByText("kanban.title");
    expect(order()).toEqual(["a", "z", "old", "missing"]);
  });

  it("remembers the chosen order after unmounting and reopening the board", async () => {
    setup([task("old", 10, 10), task("new", 30)]);
    const first = await mount();
    selectSort("newest");
    first.unmount();
    await mount();
    expect(
      screen.getByRole("combobox", { name: "kanban.sortLabel" }),
    ).toHaveProperty("value", "newest");
    expect(order()).toEqual(["new", "old"]);
  });

  it("sorts poll updates by creation time after insertion, editing and moving a card", async () => {
    const { replace } = setup([task("old", 10, 10), task("new", 30)]);
    const view = await mount();
    selectSort("newest");
    vi.useFakeTimers();
    view.rerender(<Kanban profile="default" visible />);
    replace([
      task("fresh", 40),
      { ...task("old", 10, 10, "ready"), title: "Edited old" },
      task("new", 30),
      task("ready-new", 20, 0, "ready"),
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(order()).toEqual(["fresh", "new"]);
    expect(order("ready")).toEqual(["ready-new", "old"]);
    expect(screen.getByText("Edited old")).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "kanban.sortLabel" }),
    ).toHaveProperty("value", "newest");
  });

  it("keeps sorting when showing archived cards and refreshing", async () => {
    setup([
      task("old", 10),
      task("new", 30),
      task("archived-old", 5, 10, "archived"),
      task("archived-new", 20, 0, "archived"),
    ]);
    await mount();
    selectSort("newest");
    fireEvent.click(
      screen.getByRole("button", { name: "kanban.showArchived" }),
    );
    await screen.findAllByText("archived-new");
    expect(order("archived")).toEqual(["archived-new", "archived-old"]);
    fireEvent.click(screen.getByRole("button", { name: "kanban.refresh" }));
    await screen.findByText("kanban.title");
    expect(order()).toEqual(["new", "old"]);
    expect(order("archived")).toEqual(["archived-new", "archived-old"]);
    expect(
      screen.getByRole("combobox", { name: "kanban.sortLabel" }),
    ).toHaveProperty("value", "newest");
  });

  it("sorts the read-only HQ mirror too", async () => {
    setup([task("old", 10, 10), task("new", 30)], true);
    await mount();
    selectSort("newest");
    expect(order()).toEqual(["new", "old"]);
    expect(screen.queryByRole("button", { name: "kanban.newTask" })).toBeNull();
  });

  it("falls back on an invalid stored value and tolerates unavailable storage", async () => {
    window.localStorage.setItem("hermes:kanban:sort-order", "invalid");
    setup([task("old", 10, 10), task("new", 30)]);
    const view = await mount();
    expect(order()).toEqual(["old", "new"]);
    view.unmount();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation((): never => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((): never => {
      throw new Error("blocked");
    });
    await mount();
    selectSort("newest");
    expect(order()).toEqual(["new", "old"]);
  });
});
