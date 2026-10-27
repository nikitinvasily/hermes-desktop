import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { ChatContextPanel, type SubagentRow } from "./ChatContextPanel";

vi.mock("../../components/useI18n", () => {
  const t = (key: string): string => key;
  return { useI18n: () => ({ t }) };
});

afterEach(cleanup);

const child: SubagentRow = {
  id: "child",
  startedAt: 1,
  endedAt: null,
  title: "Child task",
  model: null,
  messageCount: 1,
};
const todo = {
  revision: 1,
  items: [{ id: "todo", content: "Parent task", status: "pending" as const }],
};
const props = {
  sessionId: "parent",
  connectionId: "local",
  profile: "default",
  refreshKey: 0,
  onOpenSession: vi.fn(),
};

// @lat: [[sidebar-navigation#Sidebar recent sessions#Whole-panel collapse]]
describe("whole context panel collapse", () => {
  it.each(["todo", "subagents", "both"])(
    "preserves mounted sections across repeated %s collapse cycles",
    async (mode) => {
      Object.defineProperty(window, "hermesAPI", {
        configurable: true,
        value: {
          listSubagentSessions: vi.fn(
            async (): Promise<SubagentRow[]> =>
              mode === "todo" ? [] : [child],
          ),
        },
      });
      const { container } = render(
        <ChatContextPanel
          {...props}
          todo={mode === "subagents" ? null : todo}
        />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      if (mode !== "todo") await screen.findByText("Child task");
      const sections = [
        ...container.querySelectorAll(".sidebar-recent-section"),
      ];
      const toggles = [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".chat-context-panel-toggle",
        ),
      ];
      toggles.forEach((button) => fireEvent.click(button));
      const states = toggles.map((button) =>
        button.getAttribute("aria-expanded"),
      );
      for (let cycle = 0; cycle < 3; cycle++) {
        fireEvent.click(
          screen.getByRole("button", {
            name: "navigation.collapseContextPanel",
          }),
        );
        const panel = container.querySelector(".chat-context-panel");
        expect(panel?.classList.contains("chat-context-panel--collapsed")).toBe(
          true,
        );
        expect(
          sections.every((section) => section.hasAttribute("hidden")),
        ).toBe(true);
        expect(
          screen.queryByRole("button", { name: /navigation.subagents/ }),
        ).toBeNull();
        fireEvent.click(
          screen.getByRole("button", { name: "navigation.expandContextPanel" }),
        );
        expect(
          sections.every((section) => !section.hasAttribute("hidden")),
        ).toBe(true);
        expect([
          ...container.querySelectorAll(".sidebar-recent-section"),
        ]).toEqual(sections);
        expect(
          toggles.map((button) => button.getAttribute("aria-expanded")),
        ).toEqual(states);
      }
    },
  );

  it("keeps polling and receiving TODO updates while collapsed", async () => {
    vi.useFakeTimers();
    let rows = [child];
    const list = vi.fn(async (): Promise<SubagentRow[]> => rows);
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: { listSubagentSessions: list },
    });
    try {
      const view = render(<ChatContextPanel {...props} todo={todo} />);
      await act(async () => {
        await Promise.resolve();
      });
      fireEvent.click(
        screen.getByRole("button", { name: "navigation.subagents" }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "navigation.collapseContextPanel" }),
      );
      rows = [{ ...child, title: "Finished child", endedAt: 4 }];
      view.rerender(
        <ChatContextPanel
          {...props}
          todo={{
            revision: 2,
            items: [{ ...todo.items[0], content: "Updated parent task" }],
          }}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(list).toHaveBeenCalledTimes(2);
      expect(
        view.container.querySelector(
          ".sidebar-recent-session-waiting-subagents",
        ),
      ).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "navigation.expandContextPanel" }),
      );
      expect(screen.getByText("Updated parent task")).toBeTruthy();
      expect(screen.getByText("Finished child")).toBeTruthy();
      expect(
        screen
          .getByRole("button", { name: "navigation.subagents" })
          .getAttribute("aria-expanded"),
      ).toBe("true");
      view.rerender(
        <ChatContextPanel {...props} todo={{ revision: 3, items: [] }} />,
      );
      rows = [];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(view.container.querySelector(".chat-context-panel")).toBeNull();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("retains Show more budgets in both sections", async () => {
    const rows = Array.from(
      { length: 8 },
      (_, index): SubagentRow => ({
        ...child,
        id: `child-${index}`,
        title: `Child ${index}`,
      }),
    );
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        listSubagentSessions: vi.fn(async (): Promise<SubagentRow[]> => rows),
      },
    });
    const tasks = {
      revision: 1,
      items: Array.from({ length: 8 }, (_, index) => ({
        ...todo.items[0],
        id: String(index),
        content: `Task ${index}`,
      })),
    };
    const { container } = render(<ChatContextPanel {...props} todo={tasks} />);
    await screen.findByText("Child 0");
    fireEvent.click(
      screen.getByRole("button", { name: "navigation.subagents" }),
    );
    screen
      .getAllByRole("button", { name: "navigation.showMoreCount" })
      .forEach((button) => fireEvent.click(button));
    expect(container.querySelectorAll(".chat-context-panel-todo").length).toBe(
      8,
    );
    expect(container.querySelectorAll(".chat-context-panel-row").length).toBe(
      8,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "navigation.collapseContextPanel" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "navigation.expandContextPanel" }),
    );
    expect(container.querySelectorAll(".chat-context-panel-todo").length).toBe(
      8,
    );
    expect(container.querySelectorAll(".chat-context-panel-row").length).toBe(
      8,
    );
    expect(
      screen.queryByRole("button", { name: "navigation.showMoreCount" }),
    ).toBeNull();
  });
});
