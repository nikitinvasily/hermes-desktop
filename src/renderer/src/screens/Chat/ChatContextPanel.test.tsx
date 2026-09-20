import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
        ?.querySelector(".sidebar-recent-session-spinner"),
    ).toBeNull();
    expect(
      doneRow.closest("button")?.querySelector(".sidebar-recent-session-dot"),
    ).not.toBeNull();
    expect(
      screen
        .getByText("Review configs")
        .closest("button")
        ?.querySelector(".sidebar-recent-session-spinner"),
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

  it("collapses and expands via the section toggle", async () => {
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
    expect(
      document.querySelector(".sidebar-recent-collapse")?.className,
    ).toContain("expanded");
    fireEvent.click(toggle);
    expect(
      document.querySelector(".sidebar-recent-collapse")?.className,
    ).not.toContain("expanded");
    fireEvent.click(toggle);
    expect(
      document.querySelector(".sidebar-recent-collapse")?.className,
    ).toContain("expanded");
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
