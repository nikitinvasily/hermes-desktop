import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    onTitleChange: (id: string, title: string) => void;
    onLoadingChange: (id: string, loading: boolean) => void;
  }): React.JSX.Element => (
    <div data-testid="mounted-chat" data-active={props.active}>
      {props.initialSessionId || "scratch"}
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
    onSelect: (id: string) => void;
  }): React.JSX.Element => (
    <div>
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
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
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

describe("Layout without top session tabs", () => {
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
