import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SidebarRecentSessions from "./SidebarRecentSessions";

// The component owns its data fetching; stub the hermesAPI bridge so no
// profile DB is touched and the list stays whatever the tests seed.
const listCachedSessions = vi.fn(
  async (
    _limit: number,
    _offset: number,
    _connectionId: string,
    _profile: string,
  ) => [] as Array<{ id: string; title: string; contextFolder?: string | null }>,
);
const syncSessionCache = vi.fn(async () => [] as Array<Record<string, unknown>>);

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string, opts?: Record<string, unknown>): string =>
      key === "navigation.newChatInProject" && opts?.project
        ? `New chat in ${String(opts.project)}`
        : key,
  }),
}));

vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<object>()),
}));

// window.hermesAPI is injected by preload; provide the subset the sidebar uses.
beforeEach(() => {
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    writable: true,
    value: {
      listCachedSessions,
      syncSessionCache,
      setSessionContextFolder: vi.fn(async () => undefined),
      getSessionContextFolder: vi.fn(async () => null),
      updateSessionTitle: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      selectFolder: vi.fn(async () => null),
      copyToClipboard: vi.fn(async () => undefined),
      onMenuNewChat: vi.fn(() => () => undefined),
      onMenuSearchSessions: vi.fn(() => () => undefined),
    },
  });
  // localStorage is unavailable in this jsdom build; the component guards all
  // access in try/catch, so default (open) disclosure state applies.
  listCachedSessions.mockImplementation(
    async (
      _limit: number,
      _offset: number,
      _connectionId: string,
      _profile: string,
    ) => [
      { id: "session-proj", title: "Project chat", contextFolder: "/tmp/proj" },
      { id: "session-loose", title: "Loose chat", contextFolder: null },
    ],
  );
  syncSessionCache.mockImplementation(async () => [
    { id: "session-proj", title: "Project chat", contextFolder: "/tmp/proj" },
    { id: "session-loose", title: "Loose chat", contextFolder: null },
  ]);
});

function renderSidebar(
  onNewChatInProject: (folder: string | null) => void,
): void {
  render(
    <SidebarRecentSessions
      open
      connectionId="connection-main"
      activeProfile="default"
      currentSessionId={null}
      loadingSessionIds={new Set()}
      resumingSessionId={null}
      onSelect={vi.fn()}
      onNewChatInProject={onNewChatInProject}
      onSessionDeleted={vi.fn()}
      scrollRootRef={{ current: null }}
    />,
  );
}

describe("SidebarRecentSessions new-chat buttons", () => {
  it("renders a + on each project heading and reports the project path", async () => {
    const onNewChatInProject = vi.fn();
    renderSidebar(onNewChatInProject);

    // Wait for the cache read to paint the project group.
    const btn = await screen.findByRole("button", {
      name: "New chat in proj",
    });
    fireEvent.click(btn);

    expect(onNewChatInProject).toHaveBeenCalledWith("/tmp/proj");
  });

  it("renders a + on the Chats header and reports an unbound chat", async () => {
    const onNewChatInProject = vi.fn();
    renderSidebar(onNewChatInProject);

    // Both + buttons exist; the Chats one is labelled with navigation.newChat.
    // The nav "New Chat" lives in Layout, not here; in isolation only the
    // Chats header + carries this label.
    const buttons = await screen.findAllByRole("button", {
      name: "navigation.newChat",
    });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onNewChatInProject).toHaveBeenCalledWith(null);
  });
});
