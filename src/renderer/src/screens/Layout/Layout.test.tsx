import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Layout from "./Layout";

vi.mock("../../components/useI18n", () => {
  const t = (key: string): string => key;
  return { useI18n: () => ({ t }) };
});
vi.mock("../../components/settings/SettingsModalContext", () => ({
  useSettingsModal: () => ({ openSettings: vi.fn() }),
}));
vi.mock("../Chat/Chat", () => ({
  default: (props: {
    runId: string;
    initialSessionId: string | null;
    active: boolean;
    connectionId: string;
    profile: string;
    onTitleChange: (id: string, title: string) => void;
    onLoadingChange: (id: string, loading: boolean) => void;
    onOpenSession: (id: string) => void;
  }): React.JSX.Element => (
    <div
      data-testid="mounted-chat"
      data-active={props.active}
      data-connection={props.connectionId}
      data-profile={props.profile}
    >
      {props.initialSessionId || "scratch"}
      <textarea aria-label="Draft" defaultValue="" />
      <button onClick={() => props.onOpenSession("delegate-child")}>
        Open subagent
      </button>
      <button onClick={() => props.onLoadingChange(props.runId, false)}>
        Finish turn
      </button>
      <button
        onClick={() => {
          props.onTitleChange(props.runId, "Working conversation");
          props.onLoadingChange(props.runId, true);
        }}
      >
        Start turn
      </button>
    </div>
  ),
}));
vi.mock("./SidebarRecentSessions", () => ({
  default: (props: {
    currentSessionId: string | null;
    loadingSessionIds: Set<string>;
    onSelect: (id: string) => void;
    pendingSessions: Array<{ id: string; title: string }>;
  }): React.JSX.Element => (
    <div
      data-testid="sidebar"
      data-running={[...props.loadingSessionIds].join(",")}
    >
      {props.pendingSessions.map((row) => (
        <span key={row.id} data-testid="pending-sidebar-row">
          {row.title}
        </span>
      ))}
      {["session-a", "session-b"].map((id) => (
        <button
          key={id}
          aria-current={props.currentSessionId === id}
          onClick={() => props.onSelect(id)}
        >
          {id}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("./StatusBar", () => ({
  StatusBar: () => <div data-testid="StatusBar" />,
}));
vi.mock("./ProfileSwitcher", () => ({
  default: () => <div data-testid="ProfileSwitcher" />,
}));
vi.mock("../../components/VerifyWarningBanner", () => ({
  default: () => <div data-testid="VerifyWarningBanner" />,
}));
vi.mock("../Sessions/Sessions", () => ({
  default: () => <div data-testid="Sessions" />,
}));
vi.mock("../Agents/Agents", () => ({
  default: () => <div data-testid="Agents" />,
}));
vi.mock("../Discover/Discover", () => ({
  default: () => <div data-testid="Discover" />,
}));
vi.mock("../Skills/Skills", () => ({
  default: () => <div data-testid="Skills" />,
}));
vi.mock("../Memory/Memory", () => ({
  default: () => <div data-testid="Memory" />,
}));
vi.mock("../Tools/Tools", () => ({
  default: () => <div data-testid="Tools" />,
}));
vi.mock("../Gateway/Gateway", () => ({
  default: () => <div data-testid="Gateway" />,
}));
vi.mock("../Office/Office", () => ({
  default: () => <div data-testid="Office" />,
}));
vi.mock("../Providers/Providers", () => ({
  default: () => <div data-testid="Providers" />,
}));
vi.mock("../Schedules/Schedules", () => ({
  default: () => <div data-testid="Schedules" />,
}));
vi.mock("../Kanban/Kanban", () => ({
  default: () => <div data-testid="Kanban" />,
}));

const abortChat = vi.fn();
const markSessionRead = vi.fn(async (): Promise<boolean> => true);
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  markSessionRead.mockReset().mockResolvedValue(true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {
        /* jsdom has no layout observer. */
      }
      disconnect(): void {
        /* No native observer to disconnect. */
      }
    },
  );
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: { process: { platform: "darwin" } },
  });
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: {
      listProfiles: vi
        .fn()
        .mockResolvedValue([{ id: "default", isActive: true }]),
      isRemoteOnlyMode: vi.fn().mockResolvedValue(false),
      getConnectionRegistry: vi
        .fn()
        .mockResolvedValue({ connections: [], activeConnectionId: "local" }),
      getSessionMessages: vi.fn().mockResolvedValue([]),
      abortChat,
      markSessionRead,
      onMenuNewChat: () => (): void => {},
      onMenuSearchSessions: () => (): void => {},
      onRemoteHealthChanged: () => (): void => {},
      onUpdateAvailable: () => (): void => {},
      onUpdateDownloadProgress: () => (): void => {},
      onUpdateDownloaded: () => (): void => {},
      onUpdateError: () => (): void => {},
    },
  });
});

function shell(
  props: Partial<ComponentProps<typeof Layout>> = {},
): ReturnType<typeof render> {
  return render(<Layout connectionId="local" {...props} />);
}

function expectNoSessionStrip(container: HTMLElement): void {
  expect(
    container.querySelector(
      ".active-sessions-bar, .active-session-chip, .active-session-new",
    ),
  ).toBeNull();
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.queryByRole("tab")).toBeNull();
}

const utilityViews = [
  "discover",
  "agents",
  "office",
  "providers",
  "skills",
  "memory",
  "tools",
  "schedules",
  "kanban",
  "gateway",
] as const;

describe("utility screen return to chat", () => {
  it.each(utilityViews)(
    "returns from %s to the same empty chat",
    async (view) => {
      const { container } = shell();
      await act(async () => {});
      const chat = screen.getByTestId("mounted-chat");
      expect(
        screen.queryByRole("button", { name: "navigation.backToChat" }),
      ).toBeNull();
      fireEvent(window, new CustomEvent("navigation:goto", { detail: view }));
      expect(chat).not.toBeVisible();
      fireEvent.click(
        screen.getByRole("button", { name: "navigation.backToChat" }),
      );
      expect(screen.getByTestId("mounted-chat")).toBe(chat);
      expect(chat).toBeVisible();
      expect(chat).toHaveTextContent("scratch");
      expect(
        screen.queryByRole("button", { name: "navigation.backToChat" }),
      ).toBeNull();
      expect(
        container.querySelectorAll('[data-testid="mounted-chat"]'),
      ).toHaveLength(1);
      expect(abortChat).not.toHaveBeenCalled();
    },
  );

  it.each(["local", "remote"])(
    "preserves the running chat, draft and scope on %s",
    async (connectionId) => {
      const api = (
        window as unknown as {
          hermesAPI: {
            listProfiles: ReturnType<typeof vi.fn>;
            getSessionMessages: ReturnType<typeof vi.fn>;
          };
        }
      ).hermesAPI;
      api.listProfiles.mockResolvedValue([{ id: "writer", isActive: true }]);
      shell({ connectionId });
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "session-a" }));
      await waitFor(() =>
        expect(screen.getByTestId("mounted-chat")).toHaveTextContent(
          "session-a",
        ),
      );
      const chat = screen.getByTestId("mounted-chat");
      const draft = screen.getByRole("textbox", { name: "Draft" });
      fireEvent.change(draft, {
        target: { value: "Unsent follow-up\nwith Markdown **kept**" },
      });
      fireEvent.click(screen.getByText("Start turn"));
      const historyReads = api.getSessionMessages.mock.calls.length;
      for (const view of utilityViews) {
        fireEvent(window, new CustomEvent("navigation:goto", { detail: view }));
        expect(chat).not.toBeVisible();
        expect(screen.getByTestId("sidebar")).toHaveAttribute(
          "data-running",
          "session-a",
        );
        fireEvent.click(
          screen.getByRole("button", { name: "navigation.backToChat" }),
        );
        expect(screen.getByTestId("mounted-chat")).toBe(chat);
        expect(chat).toBeVisible();
        expect(chat).toHaveAttribute("data-connection", connectionId);
        expect(chat).toHaveAttribute("data-profile", "writer");
        expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
        expect(draft).toHaveValue("Unsent follow-up\nwith Markdown **kept**");
        expect(screen.getByTestId("sidebar")).toHaveAttribute(
          "data-running",
          "session-a",
        );
      }
      expect(api.getSessionMessages).toHaveBeenCalledTimes(historyReads);
      expect(abortChat).not.toHaveBeenCalled();
    },
  );
});

describe("Layout without top session tabs", () => {
  it("opens a child transcript without injecting its title into sidebar pending rows", async () => {
    shell();
    fireEvent.click(screen.getByText("Open subagent"));
    await screen.findByText("delegate-child");
    fireEvent.click(screen.getByText("Start turn"));
    expect(screen.queryByTestId("pending-sidebar-row")).toBeNull();
    expect(screen.getByTestId("mounted-chat")).toHaveTextContent(
      "delegate-child",
    );
  });

  it("keeps send-time sidebar rows for new chats", () => {
    shell();
    fireEvent.click(screen.getByText("Start turn"));
    expect(screen.getByTestId("pending-sidebar-row")).toHaveTextContent(
      "Working conversation",
    );
  });
  it("has no strip for scratch, running, resumed or non-chat screens", async () => {
    const { container } = shell();
    expectNoSessionStrip(container);
    fireEvent.click(screen.getByText("Start turn"));
    expectNoSessionStrip(container);
    fireEvent.click(screen.getByRole("button", { name: "session-a" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "session-a" })).toHaveAttribute(
        "aria-current",
        "true",
      ),
    );
    expectNoSessionStrip(container);
    for (const view of [
      "discover",
      "kanban",
      "schedules",
      "providers",
      "gateway",
      "tools",
      "memory",
    ]) {
      fireEvent.click(
        screen.getByRole("button", { name: `navigation.${view}` }),
      );
      expectNoSessionStrip(container);
    }
  });

  it("preserves sidebar creation, selection, mounted background runs and keyboard switching/close", async () => {
    shell();
    fireEvent.click(screen.getByRole("button", { name: "session-a" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "session-a" })).toHaveAttribute(
        "aria-current",
        "true",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "navigation.newChat" }));
    expect(screen.getAllByTestId("mounted-chat")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "navigation.newChat" }),
    ).toHaveClass("active");
    fireEvent.keyDown(window, { metaKey: true, code: "Digit1" });
    expect(screen.getByRole("button", { name: "session-a" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    fireEvent.keyDown(window, { ctrlKey: true, code: "Tab" });
    expect(
      screen.getByRole("button", { name: "navigation.newChat" }),
    ).toHaveClass("active");
    fireEvent.click(screen.getByRole("button", { name: "session-a" }));
    expect(screen.getAllByTestId("mounted-chat")).toHaveLength(2);
    expect(abortChat).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { metaKey: true, code: "KeyW" });
    expect(abortChat).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("mounted-chat")).toHaveLength(1);
  });
});

describe("sidebar-owned native window dragging", () => {
  it("keeps the macOS drag target inside the resizable and collapsed sidebar", () => {
    localStorage.setItem("hermes.sidebar.width", "320");
    const { container } = shell();
    const sidebar = container.querySelector<HTMLElement>(".sidebar")!;
    expect(sidebar).toHaveStyle({ width: "320px" });
    expect(sidebar.querySelector(".sidebar-drag-region")).not.toBeNull();
    expect(container.querySelector("main .sidebar-drag-region")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "navigation.collapseSidebar" }),
    );
    expect(sidebar.querySelector(".sidebar-drag-region")).not.toBeNull();
    expect(sidebar.style.width).toBe("");
  });

  it("does not add native drag targets on other platforms", () => {
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: { process: { platform: "win32" } },
    });
    const { container } = shell();
    expect(container.querySelector(".sidebar-drag-region")).toBeNull();
  });
});

// @lat: [[sidebar-navigation#Session read lifecycle]]
describe("visible run read lifecycle", () => {
  it("marks mounted chats on shortcut activation and utility return", async () => {
    shell();
    fireEvent.click(screen.getByRole("button", { name: "session-a" }));
    await screen.findByText("session-a", {
      selector: '[data-testid="mounted-chat"]',
    });
    expect(markSessionRead).toHaveBeenCalledWith(
      "session-a",
      "local",
      "default",
    );
    fireEvent.click(screen.getByRole("button", { name: "session-b" }));
    await waitFor(() =>
      expect(screen.getAllByTestId("mounted-chat")).toHaveLength(2),
    );
    markSessionRead.mockClear();
    fireEvent.keyDown(window, { code: "Digit1", metaKey: true });
    await waitFor(() =>
      expect(markSessionRead).toHaveBeenCalledWith(
        "session-a",
        "local",
        "default",
      ),
    );
    fireEvent(
      window,
      new CustomEvent("navigation:goto", { detail: "discover" }),
    );
    markSessionRead.mockClear();
    fireEvent.click(
      screen.getByRole("button", { name: "navigation.backToChat" }),
    );
    await waitFor(() =>
      expect(markSessionRead).toHaveBeenCalledWith(
        "session-a",
        "local",
        "default",
      ),
    );
  });
  it("waits for the visible completion write before requesting list refresh", async () => {
    shell();
    fireEvent.click(screen.getByRole("button", { name: "session-a" }));
    await screen.findByText("session-a", {
      selector: '[data-testid="mounted-chat"]',
    });
    await act(async () => {});
    let resolve!: (ok: boolean) => void;
    markSessionRead.mockImplementationOnce(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const refreshed = vi.fn();
    window.addEventListener("hermes-sessions-maybe-changed", refreshed);
    try {
      fireEvent.click(screen.getByText("Start turn"));
      fireEvent.click(screen.getByText("Finish turn"));
      await act(async () => {});
      expect(refreshed).not.toHaveBeenCalled();
      await act(async () => resolve(true));
      expect(refreshed).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("hermes-sessions-maybe-changed", refreshed);
    }
  });
  it("does not mark a completed chat hidden by a utility pane", async () => {
    shell();
    fireEvent.click(screen.getByRole("button", { name: "session-a" }));
    await screen.findByText("session-a", {
      selector: '[data-testid="mounted-chat"]',
    });
    fireEvent.click(screen.getByText("Start turn"));
    fireEvent(
      window,
      new CustomEvent("navigation:goto", { detail: "discover" }),
    );
    markSessionRead.mockClear();
    fireEvent.click(screen.getByText("Finish turn"));
    await act(async () => {});
    expect(markSessionRead).not.toHaveBeenCalled();
  });
  it("does not reuse an older activation write for a newer completion", async () => {
    let resolve!: (ok: boolean) => void;
    markSessionRead.mockImplementationOnce(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    shell();
    fireEvent.click(screen.getByRole("button", { name: "session-a" }));
    await screen.findByText("session-a", {
      selector: '[data-testid="mounted-chat"]',
    });
    await waitFor(() => expect(markSessionRead).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Start turn"));
    fireEvent.click(screen.getByText("Finish turn"));
    await act(async () => resolve(true));
    await waitFor(() => expect(markSessionRead).toHaveBeenCalledTimes(2));
  });

  it("does not start a queued completion read after the chat becomes hidden", async () => {
    let resolve!: (ok: boolean) => void;
    markSessionRead.mockImplementationOnce(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    shell();
    fireEvent.click(screen.getByRole("button", { name: "session-a" }));
    await screen.findByText("session-a", {
      selector: '[data-testid="mounted-chat"]',
    });
    await waitFor(() => expect(markSessionRead).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Start turn"));
    fireEvent.click(screen.getByText("Finish turn"));
    fireEvent(
      window,
      new CustomEvent("navigation:goto", { detail: "discover" }),
    );
    await act(async () => resolve(true));
    expect(markSessionRead).toHaveBeenCalledTimes(1);
  });
});
