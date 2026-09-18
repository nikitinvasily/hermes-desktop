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
  ) =>
    [] as Array<{ id: string; title: string; contextFolder?: string | null }>,
);
const syncSessionCache = vi.fn(
  async () => [] as Array<Record<string, unknown>>,
);

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
      listProjectFolderNames: vi.fn(async () => ({})),
      listProjectGroupSessions: vi.fn(async () => ({})),
      // One project owning /tmp/proj so the shared fixtures group there;
      // issue-#68 tests override this per-test.
      listProjects: vi.fn(async () => [
        {
          id: "p-proj",
          slug: "proj",
          name: "Project",
          primaryPath: "/tmp/proj",
          folders: [{ path: "/tmp/proj", label: null, isPrimary: true }],
        },
      ]),
      projectMutate: vi.fn(async () => undefined),
      getConnectionRegistry: vi.fn(async () => ({
        version: 1 as const,
        activeConnectionId: "connection-main",
        connections: [
          {
            connectionId: "connection-main",
            name: "Local",
            mode: "local" as const,
            remoteUrl: "",
            remoteAuthMode: "auto" as const,
            remoteChatTransport: "auto" as const,
            sshChatTransport: "auto" as const,
            hasApiKey: false,
            apiKeyLength: 0,
            ssh: {
              host: "",
              port: 22,
              username: "",
              keyPath: "",
              remotePort: 0,
              localPort: 0,
            },
          },
        ],
      })),
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
  // The component guards all localStorage access in try/catch, so the
  // default (open) disclosure state applies in tests.
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
      name: "New chat in Project",
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

describe("SidebarRecentSessions projects-only groups (issue #68)", () => {
  const listProjects = vi.fn();

  function renderSidebarProjects(
    projects: Array<{
      id: string;
      slug: string;
      name: string;
      primaryPath: string | null;
      folders: Array<{ path: string; label?: string | null }>;
    }> | null,
  ): void {
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      writable: true,
      value: {
        ...(window.hermesAPI as unknown as Record<string, unknown>),
        listProjects,
      },
    });
    listProjects.mockImplementation(async () => projects);
    render(
      <SidebarRecentSessions
        open
        connectionId="connection-main"
        activeProfile="default"
        currentSessionId={null}
        loadingSessionIds={new Set()}
        resumingSessionId={null}
        onSelect={vi.fn()}
        onNewChatInProject={vi.fn()}
        onSessionDeleted={vi.fn()}
        scrollRootRef={{ current: null }}
      />,
    );
  }

  function renderSidebarProjectsFailed(): void {
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      writable: true,
      value: {
        ...(window.hermesAPI as unknown as Record<string, unknown>),
        listProjects: vi.fn(async () => {
          throw new Error("401 session_expired");
        }),
      },
    });
    render(
      <SidebarRecentSessions
        open
        connectionId="connection-main"
        activeProfile="default"
        currentSessionId={null}
        loadingSessionIds={new Set()}
        resumingSessionId={null}
        onSelect={vi.fn()}
        onNewChatInProject={vi.fn()}
        onSessionDeleted={vi.fn()}
        scrollRootRef={{ current: null }}
      />,
    );
  }

  it("demotes sessions in a folder with no project record to Chats", async () => {
    listCachedSessions.mockImplementation(
      async (): Promise<
        Array<{ id: string; title: string; contextFolder?: string | null }>
      > => [
        {
          id: "session-proj",
          title: "Project chat",
          contextFolder: "/tmp/proj",
        },
        { id: "session-loose", title: "Loose chat", contextFolder: null },
        { id: "session-misc", title: "Misc chat", contextFolder: "/tmp/misc" },
      ],
    );
    syncSessionCache.mockImplementation(
      async (): Promise<
        Array<{ id: string; title: string; contextFolder?: string | null }>
      > => [
        {
          id: "session-proj",
          title: "Project chat",
          contextFolder: "/tmp/proj",
        },
        { id: "session-loose", title: "Loose chat", contextFolder: null },
        { id: "session-misc", title: "Misc chat", contextFolder: "/tmp/misc" },
      ],
    );
    renderSidebarProjects([
      {
        id: "p1",
        slug: "proj",
        name: "Project",
        primaryPath: "/tmp/proj",
        folders: [{ path: "/tmp/proj" }],
      },
    ]);

    // Wait for the project group to paint, then assert the misc chat is NOT
    // in a group of its own: its title appears under Chats (flat list).
    await screen.findByText("Project chat");
    expect(screen.getByText("Misc chat")).toBeTruthy();
    // The misc folder group heading must not render as a project group.
    const headings = screen
      .queryAllByText("misc")
      .filter((el) => el.textContent?.trim() === "misc");
    expect(headings).toHaveLength(0);
  });

  it("keeps pseudo-groups while the project list failed to load (401 fallback)", async () => {
    renderSidebarProjectsFailed();
    await screen.findByText("Project chat");
    // The /tmp/proj group still renders (fallback behavior).
    expect(
      await screen.findByRole("button", { name: "New chat in proj" }),
    ).toBeTruthy();
  });
});
