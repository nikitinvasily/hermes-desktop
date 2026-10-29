import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Layout from "./Layout";

vi.mock("../../components/useI18n", () => {
  const t = (key: string): string => key;
  return { useI18n: () => ({ t }) };
});
vi.mock("../../components/settings/SettingsModalContext", () => ({
  useSettingsModal: () => ({ openSettings: vi.fn() }),
}));
vi.mock("../Chat/Chat", () => ({ default: () => <div data-testid="chat" /> }));
vi.mock("./SidebarRecentSessions", () => ({ default: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./ProfileSwitcher", () => ({
  default: ({ onSwitch }: { onSwitch: (profile: string) => void }) => (
    <button onClick={() => onSwitch("other")}>Switch profile</button>
  ),
}));
vi.mock("../../components/VerifyWarningBanner", () => ({
  default: () => null,
}));
vi.mock("../Sessions/Sessions", () => ({ default: () => null }));
vi.mock("../Agents/Agents", () => ({ default: () => null }));
vi.mock("../Discover/Discover", () => ({ default: () => null }));
vi.mock("../Skills/Skills", () => ({ default: () => null }));
vi.mock("../Memory/Memory", () => ({ default: () => null }));
vi.mock("../Tools/Tools", () => ({ default: () => null }));
vi.mock("../Gateway/Gateway", () => ({ default: () => null }));
vi.mock("../Office/Office", () => ({ default: () => null }));
vi.mock("../Providers/Providers", () => ({ default: () => null }));
vi.mock("../Kanban/Kanban", () => ({ default: () => null }));

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
      getProfileEditorTarget: vi.fn(
        async (profile: string, connectionId: string) => ({
          connectionId,
          profile,
          mode: "local",
          scopeToken: `${connectionId}/${profile}/principal-a`,
        }),
      ),
      getConnectionConfig: vi.fn(async () => ({
        connectionId: "local",
        mode: "local",
        remoteUrl: "",
      })),
      onConnectionConfigChanged: vi.fn(() => () => {}),
      listCronJobs: vi.fn(async () => [
        {
          id: "job-1",
          name: "Old principal job",
          schedule: "daily",
          state: "active",
          enabled: true,
          deliver: [],
          skills: [],
        },
      ]),
      listCronRuns: vi.fn(async () => ({ success: true, runs: [] })),
      listProfiles: vi.fn(async () => [{ id: "default", isActive: true }]),
      isRemoteOnlyMode: vi.fn(async () => false),
      getConnectionRegistry: vi.fn(async () => ({
        connections: [],
        activeConnectionId: "local",
      })),
      getSessionMessages: vi.fn(async () => []),
      abortChat: vi.fn(),
      markSessionRead: vi.fn(async () => true),
      onMenuNewChat: () => () => {},
      onMenuSearchSessions: () => () => {},
      onRemoteHealthChanged: () => () => {},
      onUpdateAvailable: () => () => {},
      onUpdateDownloadProgress: () => () => {},
      onUpdateDownloaded: () => () => {},
      onUpdateError: () => () => {},
    },
  });
});
afterEach(cleanup);

describe("Schedule identity within the fork Layout", () => {
  it.each(["connection", "profile"])(
    "passes explicit scope and retires expanded history on %s changes without removing navigation",
    async (kind) => {
      const { rerender } = render(<Layout connectionId="local" />);
      await act(async () => {});
      fireEvent(
        window,
        new CustomEvent("navigation:goto", { detail: "schedules" }),
      );
      await screen.findByText("Old principal job");
      fireEvent.click(
        screen.getByRole("button", { name: "schedules.history" }),
      );
      await screen.findByText("schedules.historyEmpty");
      if (kind === "connection") rerender(<Layout connectionId="remote" />);
      else
        fireEvent.click(screen.getByRole("button", { name: "Switch profile" }));
      await act(async () => {});
      await screen.findByText("Old principal job");
      expect(window.hermesAPI.listCronJobs).toHaveBeenLastCalledWith(
        true,
        kind === "profile" ? "other" : "default",
      );
      expect(screen.queryByText("schedules.historyEmpty")).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "navigation.backToChat" }),
      );
      expect(
        screen
          .getAllByTestId("chat")
          .some((chat) => chat.closest("[style*='display: none']") === null),
      ).toBe(true);
    },
  );
  it("retires actual Schedules jobs, drafts and history on private/auth token changes but preserves label-only state", async () => {
    const api = window.hermesAPI;
    let displayName = "Original display label";
    const listeners = new Set<() => void>();
    const notify = (): void => listeners.forEach((listener) => listener());
    vi.mocked(api.onConnectionConfigChanged).mockImplementation((listener) => {
      const callback = (): void =>
        listener({
          connectionId: "local",
          name: displayName,
          mode: "local",
          remoteUrl: "",
        } as never);
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    });
    render(<Layout connectionId="local" />);
    await act(async () => {});
    fireEvent(
      window,
      new CustomEvent("navigation:goto", { detail: "schedules" }),
    );
    await screen.findByText("Old principal job");
    fireEvent.click(screen.getByRole("button", { name: "schedules.history" }));
    await screen.findByText("schedules.historyEmpty");
    fireEvent.click(screen.getByRole("button", { name: "schedules.newTask" }));
    fireEvent.change(screen.getByPlaceholderText("schedules.namePlaceholder"), {
      target: { value: "Private draft" },
    });
    const lists = vi.mocked(api.listCronJobs).mock.calls.length;
    const historyLists = vi.mocked(api.listCronRuns).mock.calls.length;
    displayName = "Renamed display label"; // Same opaque semantic/auth token.
    await act(async () => notify());
    expect(
      screen.getByPlaceholderText("schedules.namePlaceholder"),
    ).toHaveValue("Private draft");
    expect(screen.getByText("schedules.historyEmpty")).toBeVisible();
    expect(api.listCronJobs).toHaveBeenCalledTimes(lists);
    expect(api.listCronRuns).toHaveBeenCalledTimes(historyLists);

    let capture!: (
      target: Awaited<ReturnType<typeof api.getProfileEditorTarget>>,
    ) => void;
    vi.mocked(api.getProfileEditorTarget).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          capture = resolve;
        }),
    );
    act(() => notify());
    expect(screen.queryByText("Old principal job")).not.toBeVisible();
    let nextList!: (jobs: never[]) => void;
    vi.mocked(api.listCronJobs).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          nextList = resolve;
        }),
    );
    await act(async () =>
      capture({
        connectionId: "local",
        profile: "default",
        mode: "local",
        scopeToken: "principal-b",
      }),
    );
    expect(
      screen.queryByPlaceholderText("schedules.namePlaceholder"),
    ).toBeNull();
    expect(screen.queryByText("schedules.historyEmpty")).toBeNull();
    await act(async () => nextList([]));
    await screen.findByText("schedules.empty");
    expect(screen.queryByText("Old principal job")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "schedules.newTask" }));
    expect(
      screen.getByPlaceholderText("schedules.namePlaceholder"),
    ).toHaveValue("");
  });
});
