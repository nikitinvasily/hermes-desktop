import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { useI18nMock } = vi.hoisted(() => {
  const t = (k: string): string => k;
  return {
    useI18nMock: () => ({ t, locale: "en", setLocale: () => {} }),
  };
});

vi.mock("../../components/useI18n", () => ({
  useI18n: useI18nMock,
}));

import { ChatContextPanel } from "./ChatContextPanel";
import type { TodoSnapshot } from "./todoState";

type Row = {
  id: string;
  startedAt: number;
  endedAt: number | null;
  title: string;
  model: string | null;
  messageCount: number;
};

const TODO: TodoSnapshot = {
  revision: 2,
  items: [
    { id: "1", content: "Issue в форке", status: "completed" },
    { id: "2", content: "Ветка fix/x", status: "in_progress" },
    { id: "3", content: "PR и live-проверка", status: "pending" },
  ],
};

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => cleanup());

function setApi(rows: Row[]): void {
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    writable: true,
    value: {
      listSubagentSessions: vi.fn(async (): Promise<Row[]> => rows),
    },
  });
}

const baseProps = {
  sessionId: "parent-1",
  connectionId: "conn-1",
  profile: "default",
  refreshKey: 0,
  onOpenSession: vi.fn(),
};

describe("ChatContextPanel TODO section (issue #126)", () => {
  it("renders the TODO section above Subagents", async () => {
    setApi([
      {
        id: "child-a",
        startedAt: 1,
        endedAt: 2,
        title: "Audit the tests",
        model: null,
        messageCount: 5,
      },
    ]);
    render(<ChatContextPanel {...baseProps} todo={TODO} />);
    await screen.findByText("Audit the tests");
    const sections = [
      ...document.querySelectorAll(
        ".chat-context-panel > .sidebar-recent-section .sidebar-recent-section-toggle",
      ),
    ].map((b) => b.textContent);
    expect(sections[0]).toContain("navigation.todoTasklist");
    expect(sections[1]).toContain("navigation.subagents");
  });

  it("shows the done/total counter and status markers", async () => {
    setApi([]);
    render(<ChatContextPanel {...baseProps} todo={TODO} />);
    await screen.findByText("Ветка fix/x");
    expect(screen.getByText("1/3")).toBeTruthy();
    expect(
      document.querySelectorAll(".chat-context-panel-todo--completed").length,
    ).toBe(1);
    expect(
      document.querySelectorAll(".chat-context-panel-todo--in_progress").length,
    ).toBe(1);
    expect(
      document.querySelectorAll(".chat-context-panel-todo--pending").length,
    ).toBe(1);
  });

  it("hides the TODO section when nothing is open (all completed/cancelled)", () => {
    setApi([]);
    const done: TodoSnapshot = {
      revision: 5,
      items: [
        { id: "1", content: "Finished", status: "completed" },
        { id: "2", content: "Dropped", status: "cancelled" },
      ],
    };
    const { container } = render(
      <ChatContextPanel {...baseProps} todo={done} />,
    );
    expect(container.querySelector(".chat-context-panel")).toBeNull();
  });

  it("renders the panel with only a TODO (no subagents)", async () => {
    setApi([]);
    render(<ChatContextPanel {...baseProps} todo={TODO} />);
    await screen.findByText("Ветка fix/x");
    expect(screen.queryByRole("button", { name: /subagents/i })).toBeNull();
  });

  it("Subagents section is collapsed by default, TODO expanded", async () => {
    setApi([
      {
        id: "child-a",
        startedAt: 1,
        endedAt: 2,
        title: "Audit the tests",
        model: null,
        messageCount: 5,
      },
    ]);
    render(<ChatContextPanel {...baseProps} todo={TODO} />);
    await screen.findByText("Audit the tests");
    const collapses = [
      ...document.querySelectorAll(".sidebar-recent-collapse"),
    ];
    // First collapse = TODO (expanded), second = Subagents (collapsed).
    expect(collapses[0].className).toContain("expanded");
    expect(collapses[1].className).not.toContain("expanded");
    // Subagent rows exist but the toggle still works.
    const subagentsToggle = screen.getByRole("button", { name: /subagents/i });
    fireEvent.click(subagentsToggle);
    expect(collapses[1].className).toContain("expanded");
  });

  it("null panel without todo and without subagents", async () => {
    setApi([]);
    const { container } = render(
      <ChatContextPanel {...baseProps} todo={null} />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector(".chat-context-panel")).toBeNull();
  });
});
