import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

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

type Row = {
  id: string;
  startedAt: number;
  endedAt: number | null;
  title: string;
  model: string | null;
  messageCount: number;
};

type PanelWindow = Window & {
  hermesAPI: { listSubagentSessions: ReturnType<typeof vi.fn> };
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

describe("ChatContextPanel (issue #122)", () => {
  it("renders null when the chat has no subagents", async () => {
    setApi([]);
    const { container } = render(<ChatContextPanel {...baseProps} />);
    await waitFor(() =>
      expect(
        (window as unknown as PanelWindow).hermesAPI.listSubagentSessions,
      ).toHaveBeenCalled(),
    );
    expect(container.querySelector(".chat-context-panel")).toBeNull();
  });

  it("renders null for a scratch chat (no session id yet)", () => {
    setApi([]);
    const { container } = render(
      <ChatContextPanel {...baseProps} sessionId={null} />,
    );
    expect(container.querySelector(".chat-context-panel")).toBeNull();
    expect(
      (window as unknown as PanelWindow).hermesAPI.listSubagentSessions,
    ).not.toHaveBeenCalled();
  });

  it("lists subagent rows with done dot vs running spinner", async () => {
    setApi([
      {
        id: "child-a",
        startedAt: 1,
        endedAt: 2,
        title: "Audit the tests",
        model: null,
        messageCount: 5,
      },
      {
        id: "child-b",
        startedAt: 3,
        endedAt: null,
        title: "Review configs",
        model: null,
        messageCount: 2,
      },
    ]);
    render(<ChatContextPanel {...baseProps} />);
    const doneRow = await screen.findByText("Audit the tests");
    expect(screen.getByText("Review configs")).toBeTruthy();
    expect(
      doneRow
        .closest("button")
        ?.querySelector(".sidebar-recent-session-waiting-subagents"),
    ).toBeNull();
    expect(
      doneRow.closest("button")?.querySelector(".sidebar-recent-session-dot"),
    ).not.toBeNull();
    expect(
      screen
        .getByText("Review configs")
        .closest("button")
        ?.querySelector(".sidebar-recent-session-waiting-subagents"),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: /subagents/i })).toBeTruthy();
  });

  it("opens the subagent transcript on row click", async () => {
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
    const onOpenSession = vi.fn();
    render(<ChatContextPanel {...baseProps} onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByText("Audit the tests"));
    expect(onOpenSession).toHaveBeenCalledWith("child-a");
  });

  it("subagents section starts collapsed and expands via the toggle", async () => {
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
    render(<ChatContextPanel {...baseProps} />);
    const toggle = await screen.findByRole("button", {
      name: /subagents/i,
    });
    // Collapsed by default since the TODO section landed above (issue #126).
    expect(
      document.querySelector(".sidebar-recent-collapse")?.className,
    ).not.toContain("expanded");
    fireEvent.click(toggle);
    expect(
      document.querySelector(".sidebar-recent-collapse")?.className,
    ).toContain("expanded");
    fireEvent.click(toggle);
    expect(
      document.querySelector(".sidebar-recent-collapse")?.className,
    ).not.toContain("expanded");
  });

  it("sorts unordered launches newest first before the five-row cap", async () => {
    setApi(
      [2, 7, 1, 5, 6, 3, 4].map(
        (startedAt): Row => ({
          id: `child-${startedAt}`,
          startedAt,
          endedAt: 10,
          title: `Launch ${startedAt}`,
          model: null,
          messageCount: 1,
        }),
      ),
    );
    const { container } = render(<ChatContextPanel {...baseProps} />);
    await screen.findByText("Launch 7");
    expect(
      Array.from(
        container.querySelectorAll(".chat-context-panel-row-title"),
        (el) => el.textContent,
      ),
    ).toEqual(["Launch 7", "Launch 6", "Launch 5", "Launch 4", "Launch 3"]);
  });

  it("uses the sidebar dotted ring for running children", async () => {
    setApi([
      {
        id: "running",
        startedAt: 1,
        endedAt: null,
        title: "Working child",
        model: null,
        messageCount: 1,
      },
    ]);
    render(<ChatContextPanel {...baseProps} />);
    const row = (await screen.findByText("Working child")).closest("button");
    expect(
      row?.querySelector(".sidebar-recent-session-waiting-subagents"),
    ).not.toBeNull();
    expect(row?.querySelector(".sidebar-recent-session-spinner")).toBeNull();
  });

  it("caps the newest-first list before revealing older children and opens the selected row", async () => {
    const rows: Row[] = Array.from(
      { length: 7 },
      (_, i): Row => ({
        id: `child-${7 - i}`,
        startedAt: 7 - i,
        endedAt: i === 0 ? null : 10,
        title: `Goal ${7 - i}`,
        model: null,
        messageCount: 1,
      }),
    );
    setApi(rows);
    const onOpenSession = vi.fn();
    const { container, rerender } = render(
      <ChatContextPanel {...baseProps} onOpenSession={onOpenSession} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /subagents/i }));
    const titles = (): (string | null)[] =>
      Array.from(
        container.querySelectorAll(".chat-context-panel-row-title"),
        (el) => el.textContent,
      );
    expect(titles()).toEqual([
      "Goal 7",
      "Goal 6",
      "Goal 5",
      "Goal 4",
      "Goal 3",
    ]);
    expect(screen.queryByText("Goal 2")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "navigation.showMoreCount" }),
    );
    expect(titles()).toEqual(rows.map((r) => r.title));
    fireEvent.click(screen.getByText("Goal 2"));
    expect(onOpenSession).toHaveBeenCalledWith("child-2");
    const newest: Row = {
      ...rows[0],
      id: "child-8",
      startedAt: 8,
      title: "Goal 8",
    };
    setApi([newest, ...rows]);
    rerender(
      <ChatContextPanel
        {...baseProps}
        refreshKey={1}
        onOpenSession={onOpenSession}
      />,
    );
    await waitFor(() =>
      expect(titles()).toEqual(["Goal 8", ...rows.map((r) => r.title)]),
    );
    fireEvent.click(screen.getByRole("button", { name: /subagents/i }));
    fireEvent.click(screen.getByRole("button", { name: /subagents/i }));
    expect(titles()).toEqual([
      "Goal 8",
      "Goal 7",
      "Goal 6",
      "Goal 5",
      "Goal 4",
    ]);
  });

  it.each([
    { connectionId: "conn-2", profile: "default", sessionId: "parent-1" },
    { connectionId: "conn-1", profile: "other", sessionId: "parent-1" },
    { connectionId: "conn-1", profile: "default", sessionId: "parent-2" },
  ])(
    "hides the previous scope's rows immediately on switch to %j",
    async (next) => {
      setApi([
        {
          id: "old",
          startedAt: 1,
          endedAt: 2,
          title: "Previous scope",
          model: null,
          messageCount: 1,
        },
      ]);
      const { rerender } = render(<ChatContextPanel {...baseProps} />);
      await screen.findByText("Previous scope");
      const api = (window as unknown as PanelWindow).hermesAPI
        .listSubagentSessions;
      api.mockReturnValueOnce(new Promise<Row[]>(() => {}));
      rerender(<ChatContextPanel {...baseProps} {...next} />);
      expect(screen.queryByText("Previous scope")).toBeNull();
    },
  );

  it("orders same-time launches by id without changing source rows", async () => {
    const rows = ["z", "Z", "a"].map(
      (id): Row => ({
        id,
        startedAt: 1,
        endedAt: 2,
        title: id,
        model: null,
        messageCount: 1,
      }),
    );
    setApi(rows);
    const { container } = render(<ChatContextPanel {...baseProps} />);
    await screen.findByText("a");
    expect(
      Array.from(
        container.querySelectorAll(".chat-context-panel-row-title"),
        (el) => el.textContent,
      ),
    ).toEqual(["Z", "a", "z"]);
    expect(rows.map((row) => row.id)).toEqual(["z", "Z", "a"]);
  });

  it("does not paint a delayed old parent's result after switching chats", async () => {
    let resolveOld!: (rows: Row[]) => void;
    const oldRows = new Promise<Row[]>((resolve) => {
      resolveOld = resolve;
    });
    setApi([]);
    const api = (window as unknown as PanelWindow).hermesAPI
      .listSubagentSessions;
    api.mockReturnValueOnce(oldRows).mockResolvedValue([]);
    const { rerender } = render(<ChatContextPanel {...baseProps} />);
    rerender(<ChatContextPanel {...baseProps} sessionId="parent-2" />);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("parent-2", "conn-1", "default"),
    );
    await act(async () =>
      resolveOld([
        {
          id: "old",
          startedAt: 1,
          endedAt: 2,
          title: "Old parent child",
          model: null,
          messageCount: 1,
        },
      ]),
    );
    expect(screen.queryByText("Old parent child")).toBeNull();
  });

  it("refreshes children while the parent turn is still running without overlapping reads", async () => {
    vi.useFakeTimers();
    try {
      setApi([]);
      const api = (window as unknown as PanelWindow).hermesAPI
        .listSubagentSessions;
      let resolveFirst!: (rows: Row[]) => void;
      api.mockReturnValueOnce(
        new Promise<Row[]>((resolve) => {
          resolveFirst = resolve;
        }),
      );
      render(<ChatContextPanel {...baseProps} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(api).toHaveBeenCalledTimes(1);
      await act(async () => resolveFirst([]));
      api.mockResolvedValue([
        {
          id: "new",
          startedAt: 2,
          endedAt: null,
          title: "New live child",
          model: null,
          messageCount: 1,
        },
      ]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(screen.queryByText("New live child")).not.toBeNull();
      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart polling when an unmounted read settles", async () => {
    vi.useFakeTimers();
    try {
      setApi([]);
      const api = (window as unknown as PanelWindow).hermesAPI
        .listSubagentSessions;
      let finish!: (rows: Row[]) => void;
      api.mockReturnValueOnce(
        new Promise<Row[]>((resolve) => {
          finish = resolve;
        }),
      );
      const { unmount } = render(<ChatContextPanel {...baseProps} />);
      unmount();
      await act(async () => {
        finish([]);
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(api).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains current rows on a temporary read failure and retries", async () => {
    vi.useFakeTimers();
    try {
      setApi([
        {
          id: "child",
          startedAt: 1,
          endedAt: null,
          title: "Kept child",
          model: null,
          messageCount: 1,
        },
      ]);
      const api = (window as unknown as PanelWindow).hermesAPI
        .listSubagentSessions;
      render(<ChatContextPanel {...baseProps} />);
      await act(async () => {});
      api.mockRejectedValueOnce(new Error("Network unavailable"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(screen.queryByText("Kept child")).not.toBeNull();
      api.mockResolvedValue([]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(screen.queryByText("Kept child")).toBeNull();
      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-fetches when refreshKey changes (turn finished)", async () => {
    setApi([]);
    const { rerender } = render(
      <ChatContextPanel {...baseProps} refreshKey={0} />,
    );
    await waitFor(() =>
      expect(
        (window as unknown as PanelWindow).hermesAPI.listSubagentSessions,
      ).toHaveBeenCalledTimes(1),
    );
    setApi([
      {
        id: "child-late",
        startedAt: 1,
        endedAt: null,
        title: "Spawned mid-turn",
        model: null,
        messageCount: 0,
      },
    ]);
    rerender(<ChatContextPanel {...baseProps} refreshKey={1} />);
    await screen.findByText("Spawned mid-turn");
  });
});
