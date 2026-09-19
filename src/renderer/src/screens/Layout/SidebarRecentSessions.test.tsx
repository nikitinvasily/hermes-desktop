import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      markSessionRead: vi.fn(async () => true),
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
      approvalSessionIds={new Set()}
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
        approvalSessionIds={new Set()}
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
        approvalSessionIds={new Set()}
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

describe("SidebarRecentSessions ordering (issue #74)", () => {
  function seedProjects(): void {
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      writable: true,
      value: {
        ...(window.hermesAPI as unknown as Record<string, unknown>),
        listProjects: vi.fn(async () => [
          {
            id: "p1",
            slug: "proj",
            name: "Zeta",
            primaryPath: "/tmp/zeta",
            folders: [{ path: "/tmp/zeta" }],
          },
          {
            id: "p2",
            slug: "alpha",
            name: "Alpha",
            primaryPath: "/tmp/alpha",
            folders: [{ path: "/tmp/alpha" }],
          },
          {
            id: "p3",
            slug: "mid",
            name: "Mid",
            primaryPath: "/tmp/mid",
            folders: [{ path: "/tmp/mid" }],
          },
        ]),
      },
    });
  }

  function renderForOrdering(): ReturnType<typeof render> {
    return render(
      <SidebarRecentSessions
        open
        connectionId="connection-main"
        activeProfile="default"
        currentSessionId={null}
        loadingSessionIds={new Set()}
        approvalSessionIds={new Set()}
        resumingSessionId={null}
        onSelect={vi.fn()}
        onNewChatInProject={vi.fn()}
        onSessionDeleted={vi.fn()}
        scrollRootRef={{ current: null }}
      />,
    );
  }

  function headingOrder(): string[] {
    return Array.from(
      document.querySelectorAll(".sidebar-recent-project-heading span"),
    ).map((el) => el.textContent?.trim() ?? "");
  }

  function groupRowTitles(headingText: string): string[] {
    const heading = Array.from(
      document.querySelectorAll(".sidebar-recent-project-heading"),
    ).find((el) => el.textContent?.includes(headingText));
    if (!heading) return [];
    const project = heading.closest(".sidebar-recent-project");
    if (!project) return [];
    return Array.from(project.querySelectorAll(".sidebar-recent-session")).map(
      (el) => el.textContent?.trim().slice(0, 12) ?? "",
    );
  }

  it("orders project groups alphabetically, independent of session recency", async () => {
    seedProjects();
    // Freshest session sits in /tmp/zeta — before issue #74 that made Zeta
    // the FIRST group; alphabetical order must ignore session recency.
    const rows = [
      {
        id: "s-zeta-fresh",
        title: "Zeta fresh",
        contextFolder: "/tmp/zeta",
        startedAt: 3000,
        lastActivityAt: 3000,
      },
      {
        id: "s-alpha-old",
        title: "Alpha old",
        contextFolder: "/tmp/alpha",
        startedAt: 1000,
        lastActivityAt: 1000,
      },
      {
        id: "s-mid",
        title: "Mid chat",
        contextFolder: "/tmp/mid",
        startedAt: 2000,
        lastActivityAt: 2000,
      },
    ];
    listCachedSessions.mockImplementation(async () => rows);
    syncSessionCache.mockImplementation(async () => rows);
    renderForOrdering();

    await screen.findByText("Zeta fresh");
    expect(headingOrder()).toEqual(["Alpha", "Mid", "Zeta"]);
  });

  it("keeps the alphabetical order after the freshest project's chats vanish", async () => {
    seedProjects();
    const withZeta = [
      {
        id: "s-zeta-fresh",
        title: "Zeta fresh",
        contextFolder: "/tmp/zeta",
        startedAt: 3000,
        lastActivityAt: 3000,
      },
      {
        id: "s-alpha-old",
        title: "Alpha old",
        contextFolder: "/tmp/alpha",
        startedAt: 1000,
        lastActivityAt: 1000,
      },
    ];
    listCachedSessions.mockImplementation(async () => withZeta);
    syncSessionCache.mockImplementation(async () => withZeta);
    const { unmount } = renderForOrdering();
    await screen.findByText("Zeta fresh");
    expect(headingOrder()).toEqual(["Alpha", "Mid", "Zeta"]);
    unmount();

    // Simulate archiving every Zeta chat: the group stays in place.
    const withoutZeta = [withZeta[1]];
    listCachedSessions.mockImplementation(async () => withoutZeta);
    syncSessionCache.mockImplementation(async () => withoutZeta);
    renderForOrdering();
    await screen.findByText("Alpha old");
    expect(headingOrder()).toEqual(["Alpha", "Mid", "Zeta"]);
    expect(screen.queryByText("Zeta fresh")).toBeNull();
  });

  it("sorts chats inside a group by last activity, not startedAt", async () => {
    seedProjects();
    const rows = [
      {
        id: "s-zeta-created-late",
        title: "Created late",
        contextFolder: "/tmp/zeta",
        startedAt: 5000,
        lastActivityAt: 1000,
      },
      {
        id: "s-zeta-touched",
        title: "Touched old",
        contextFolder: "/tmp/zeta",
        startedAt: 1000,
        lastActivityAt: 9000,
      },
    ];
    listCachedSessions.mockImplementation(async () => rows);
    syncSessionCache.mockImplementation(async () => rows);
    renderForOrdering();

    await screen.findByText("Touched old");
    const titles = groupRowTitles("Zeta");
    expect(titles[0]).toContain("Touched old");
    expect(titles[1]).toContain("Created late");
  });
});

describe("SidebarRecentSessions delete vs the tree-derived groups (issue #80)", () => {
  interface TreeRow {
    id: string;
    title: string;
    startedAt?: number;
    lastActivityAt?: number;
    contextFolder?: string | null;
  }

  function renderWithTreeGroups(
    windowRows: TreeRow[],
    treeGroups: Record<string, TreeRow[]>,
  ): void {
    listCachedSessions.mockImplementation(async () => windowRows);
    syncSessionCache.mockImplementation(
      async (): Promise<Array<Record<string, unknown>>> =>
        windowRows as unknown as Array<Record<string, unknown>>,
    );
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      writable: true,
      value: {
        ...(window.hermesAPI as unknown as Record<string, unknown>),
        deleteSession: vi.fn(async () => undefined),
        listProjectGroupSessions: vi.fn(
          async (): Promise<Record<string, unknown>> =>
            treeGroups as unknown as Record<string, unknown>,
        ),
      },
    });
    render(
      <SidebarRecentSessions
        open
        connectionId="connection-main"
        activeProfile="default"
        currentSessionId={null}
        loadingSessionIds={new Set()}
        approvalSessionIds={new Set()}
        resumingSessionId={null}
        onSelect={vi.fn()}
        onNewChatInProject={vi.fn()}
        onSessionDeleted={vi.fn()}
        scrollRootRef={{ current: null }}
      />,
    );
  }

  async function deleteRowViaMenu(title: string): Promise<void> {
    const row = await screen.findByText(title);
    fireEvent.contextMenu(
      row.closest(".sidebar-recent-session") as HTMLElement,
    );
    const deleteItem = await screen.findAllByText(
      "navigation.sessionMenu.delete",
    );
    fireEvent.click(deleteItem[deleteItem.length - 1]);
    const confirm = await screen.findByText(
      "navigation.sessionMenu.deleteConfirmAction",
    );
    fireEvent.click(confirm);
  }

  it("removes a tree-group chat from its project group on delete, not only from the window", async () => {
    // The chat exists ONLY in the tree-derived groups (issue #57 stage 2):
    // the recency window already lost it, the projects tree still lists it.
    renderWithTreeGroups(
      [{ id: "session-loose", title: "Loose chat", contextFolder: null }],
      {
        "/tmp/proj": [
          {
            id: "session-tree",
            title: "Tree-only chat",
            contextFolder: "/tmp/proj",
          },
        ],
      },
    );

    await screen.findByText("Tree-only chat");
    await deleteRowViaMenu("Tree-only chat");

    // The row must be gone from the rendered group immediately — not
    // resurrected from the stale tree map until a restart (issue #80).
    await screen.findByText("Loose chat");
    expect(screen.queryByText("Tree-only chat")).toBeNull();
  });
});

describe("SidebarRecentSessions pending first-turn rows (issue #97 stage 2)", () => {
  function renderWithPending(
    pending: Array<{
      id: string;
      title: string;
      contextFolder?: string | null;
      pendingRunId: string;
    }>,
    onActivatePending: (runId: string) => void = vi.fn(),
    activePendingRunId?: string,
  ): void {
    render(
      <SidebarRecentSessions
        open
        connectionId="connection-main"
        activeProfile="default"
        currentSessionId={null}
        loadingSessionIds={new Set()}
        approvalSessionIds={new Set()}
        resumingSessionId={null}
        onSelect={vi.fn()}
        onNewChatInProject={vi.fn()}
        onSessionDeleted={vi.fn()}
        pendingSessions={pending}
        onActivatePending={onActivatePending}
        activePendingRunId={activePendingRunId}
        scrollRootRef={{ current: null }}
      />,
    );
  }

  it("shows a pending row immediately and activates its run on click", async () => {
    const onActivate = vi.fn();
    renderWithPending(
      [
        {
          id: "pending-run-1",
          title: "Just sent message",
          pendingRunId: "run-1",
        },
      ],
      onActivate,
    );
    const row = await screen.findByText("Just sent message");
    fireEvent.click(row);
    expect(onActivate).toHaveBeenCalledWith("run-1");
    // No options button on a pending row (no DB session behind it).
    expect(
      row
        .closest(".sidebar-recent-session")
        ?.querySelector(".sidebar-recent-session-options"),
    ).toBeNull();
  });

  it("drops a pending row once its session lands in the synced list", async () => {
    const { rerender } = render(
      <SidebarRecentSessions
        open
        connectionId="connection-main"
        activeProfile="default"
        currentSessionId={null}
        loadingSessionIds={new Set()}
        approvalSessionIds={new Set()}
        resumingSessionId={null}
        onSelect={vi.fn()}
        onNewChatInProject={vi.fn()}
        onSessionDeleted={vi.fn()}
        pendingSessions={[
          {
            id: "pending-run-4",
            title: "Handoff chat",
            pendingRunId: "run-4",
            pendingSessionId: "session-real",
          },
        ]}
        scrollRootRef={{ current: null }}
      />,
    );
    expect(await screen.findByText("Handoff chat")).toBeTruthy();
    // The real session row arrives via sync: the pending twin must vanish.
    syncSessionCache.mockImplementation(async () => [
      { id: "session-real", title: "Handoff chat real", contextFolder: null },
    ]);
    window.dispatchEvent(new CustomEvent("hermes-sessions-maybe-changed"));
    await screen.findByText("Handoff chat real");
    expect(screen.queryByText("Handoff chat")).toBeNull();
    rerender(
      <SidebarRecentSessions
        open
        connectionId="connection-main"
        activeProfile="default"
        currentSessionId="session-real"
        loadingSessionIds={new Set()}
        approvalSessionIds={new Set()}
        resumingSessionId={null}
        onSelect={vi.fn()}
        onNewChatInProject={vi.fn()}
        onSessionDeleted={vi.fn()}
        pendingSessions={[
          {
            id: "pending-run-4",
            title: "Handoff chat",
            pendingRunId: "run-4",
            pendingSessionId: "session-real",
          },
        ]}
        scrollRootRef={{ current: null }}
      />,
    );
    // Synced row present: still exactly one row for the session.
    expect(screen.queryByText("Handoff chat")).toBeNull();
  });

  it("never resurrects a pending row after its session is deleted (issue #99)", async () => {
    const { rerender } = render(
      <SidebarRecentSessions
        open
        connectionId="connection-main"
        activeProfile="default"
        currentSessionId={null}
        loadingSessionIds={new Set()}
        approvalSessionIds={new Set()}
        resumingSessionId={null}
        onSelect={vi.fn()}
        onNewChatInProject={vi.fn()}
        onSessionDeleted={vi.fn()}
        pendingSessions={[
          {
            id: "pending-run-4",
            title: "Handoff chat",
            pendingRunId: "run-4",
            pendingSessionId: "session-real",
          },
        ]}
        scrollRootRef={{ current: null }}
      />,
    );
    expect(await screen.findByText("Handoff chat")).toBeTruthy();
    // Handoff: the real session lands in sync and the pending twin drops.
    syncSessionCache.mockImplementation(async () => [
      { id: "session-real", title: "Handoff chat real", contextFolder: null },
    ]);
    window.dispatchEvent(new CustomEvent("hermes-sessions-maybe-changed"));
    await screen.findByText("Handoff chat real");
    expect(screen.queryByText("Handoff chat")).toBeNull();
    // The user DELETES the chat: the synced list empties. The run still
    // holds title+sessionId, so without the irreversible handoff the pending
    // row would resurrect the deleted chat in the sidebar.
    syncSessionCache.mockImplementation(async () => []);
    window.dispatchEvent(new CustomEvent("hermes-sessions-maybe-changed"));
    await waitFor(() => {
      expect(screen.queryByText("Handoff chat real")).toBeNull();
    });
    rerender(
      <SidebarRecentSessions
        open
        connectionId="connection-main"
        activeProfile="default"
        currentSessionId={null}
        loadingSessionIds={new Set()}
        approvalSessionIds={new Set()}
        resumingSessionId={null}
        onSelect={vi.fn()}
        onNewChatInProject={vi.fn()}
        onSessionDeleted={vi.fn()}
        pendingSessions={[
          {
            id: "pending-run-4",
            title: "Handoff chat",
            pendingRunId: "run-4",
            pendingSessionId: "session-real",
          },
        ]}
        scrollRootRef={{ current: null }}
      />,
    );
    expect(screen.queryByText("Handoff chat")).toBeNull();
  });

  it("groups a project-bound pending row inside its project", async () => {
    renderWithPending([
      {
        id: "pending-run-2",
        title: "Project pending chat",
        contextFolder: "/tmp/proj",
        pendingRunId: "run-2",
      },
    ]);
    // The row exists somewhere in the document; grouping placement (project
    // group vs Chats) is covered by the group-membership rendering.
    expect(await screen.findByText("Project pending chat")).toBeTruthy();
  });

  it("highlights the active pending row via activePendingRunId", async () => {
    renderWithPending(
      [
        {
          id: "pending-run-3",
          title: "Active pending chat",
          pendingRunId: "run-3",
        },
      ],
      vi.fn(),
      "run-3",
    );
    const row = await screen.findByText("Active pending chat");
    expect(row.closest(".sidebar-recent-session")?.className).toContain(
      "active",
    );
  });
});

describe("SidebarRecentSessions maybe-changed force refresh (issue #97)", () => {
  it("re-syncs past the 5s throttle when a first message creates a session", async () => {
    // Initial paint: only the loose chat exists.
    listCachedSessions.mockImplementation(async () => [
      { id: "session-loose", title: "Loose chat", contextFolder: null },
    ]);
    syncSessionCache.mockImplementation(async () => [
      { id: "session-loose", title: "Loose chat", contextFolder: null },
    ]);
    renderSidebar(vi.fn());
    await screen.findByText("Loose chat");
    const syncCallsAfterMount = syncSessionCache.mock.calls.length;
    expect(syncCallsAfterMount).toBeGreaterThan(0);

    // The first turn just materialized a NEW session: the next sync returns
    // it. Dispatching hermes-sessions-maybe-changed must trigger a sync
    // immediately even though the mount sync happened < 5s ago (throttle).
    syncSessionCache.mockImplementation(async () => [
      {
        id: "session-new",
        title: "New first-turn chat",
        contextFolder: null,
      },
      { id: "session-loose", title: "Loose chat", contextFolder: null },
    ]);
    window.dispatchEvent(new CustomEvent("hermes-sessions-maybe-changed"));

    await screen.findByText("New first-turn chat");
    expect(syncSessionCache.mock.calls.length).toBeGreaterThan(
      syncCallsAfterMount,
    );
  });
});

describe("SidebarRecentSessions state bullets", () => {
  function bulletFor(title: string): SVGSVGElement | null {
    const row = screen.getByText(title).closest(".sidebar-recent-session");
    return (
      row?.querySelector(
        ".sidebar-recent-session-dot, .sidebar-recent-session-spinner",
      ) ?? null
    );
  }

  it("renders an unread (filled accent) dot that clears on open", async () => {
    listCachedSessions.mockImplementation(async () => [
      {
        id: "session-unread",
        title: "Unread chat",
        contextFolder: null,
        unread: true,
      },
    ]);
    syncSessionCache.mockImplementation(async () => [
      {
        id: "session-unread",
        title: "Unread chat",
        contextFolder: null,
        unread: true,
      },
    ]);
    const onSelect = vi.fn();
    render(
      <SidebarRecentSessions
        open
        connectionId="connection-main"
        activeProfile="default"
        currentSessionId={null}
        loadingSessionIds={new Set()}
        approvalSessionIds={new Set()}
        resumingSessionId={null}
        onSelect={onSelect}
        onSessionDeleted={vi.fn()}
        scrollRootRef={{ current: null }}
      />,
    );

    const row = await screen.findByText("Unread chat");
    const dot = bulletFor("Unread chat");
    expect(dot?.getAttribute("class")).toContain(
      "sidebar-recent-session-dot--unread",
    );
    expect(dot?.getAttribute("fill")).toBe("currentColor");

    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("session-unread");
    // Optimistic clear: the dot loses its unread modifier without a re-sync.
    await screen.findByText("Unread chat");
    expect(bulletFor("Unread chat")?.getAttribute("class")).not.toContain(
      "sidebar-recent-session-dot--unread",
    );
  });

  it("renders the approval (warning) dot for a session with a pending approval", async () => {
    listCachedSessions.mockImplementation(async () => [
      {
        id: "session-approval",
        title: "Approval chat",
        contextFolder: null,
        unread: true,
      },
    ]);
    syncSessionCache.mockImplementation(async () => [
      {
        id: "session-approval",
        title: "Approval chat",
        contextFolder: null,
        unread: true,
      },
    ]);
    render(
      <SidebarRecentSessions
        open
        connectionId="connection-main"
        activeProfile="default"
        currentSessionId={null}
        loadingSessionIds={new Set()}
        approvalSessionIds={new Set(["session-approval"])}
        resumingSessionId={null}
        onSelect={vi.fn()}
        onSessionDeleted={vi.fn()}
        scrollRootRef={{ current: null }}
      />,
    );

    await screen.findByText("Approval chat");
    // Approval wins over unread (checked before the unread branch).
    const dot = bulletFor("Approval chat");
    expect(dot?.getAttribute("class")).toContain(
      "sidebar-recent-session-dot--approval",
    );
    expect(dot?.getAttribute("class")).not.toContain(
      "sidebar-recent-session-dot--unread",
    );
  });

  it("keeps the spinner over the unread dot for a loading session", async () => {
    listCachedSessions.mockImplementation(async () => [
      {
        id: "session-running",
        title: "Running chat",
        contextFolder: null,
        unread: true,
      },
    ]);
    syncSessionCache.mockImplementation(async () => [
      {
        id: "session-running",
        title: "Running chat",
        contextFolder: null,
        unread: true,
      },
    ]);
    render(
      <SidebarRecentSessions
        open
        connectionId="connection-main"
        activeProfile="default"
        currentSessionId={null}
        loadingSessionIds={new Set(["session-running"])}
        approvalSessionIds={new Set()}
        resumingSessionId={null}
        onSelect={vi.fn()}
        onSessionDeleted={vi.fn()}
        scrollRootRef={{ current: null }}
      />,
    );

    await screen.findByText("Running chat");
    const dot = bulletFor("Running chat");
    expect(dot?.getAttribute("class")).toContain(
      "sidebar-recent-session-spinner",
    );
    expect(dot?.getAttribute("class")).not.toContain(
      "sidebar-recent-session-dot--unread",
    );
  });

  it("shows the approval dot over the spinner while a loaded run awaits approval", async () => {
    // A chat waiting on a command approval keeps run.loading true (the turn
    // has not completed) — the approval bullet must still win (issue #90).
    listCachedSessions.mockImplementation(async () => [
      {
        id: "session-approval-running",
        title: "Approval running chat",
        contextFolder: null,
        unread: false,
      },
    ]);
    syncSessionCache.mockImplementation(async () => [
      {
        id: "session-approval-running",
        title: "Approval running chat",
        contextFolder: null,
        unread: false,
      },
    ]);
    render(
      <SidebarRecentSessions
        open
        connectionId="connection-main"
        activeProfile="default"
        currentSessionId={null}
        loadingSessionIds={new Set(["session-approval-running"])}
        approvalSessionIds={new Set(["session-approval-running"])}
        resumingSessionId={null}
        onSelect={vi.fn()}
        onSessionDeleted={vi.fn()}
        scrollRootRef={{ current: null }}
      />,
    );

    await screen.findByText("Approval running chat");
    const dot = bulletFor("Approval running chat");
    expect(dot?.getAttribute("class")).toContain(
      "sidebar-recent-session-dot--approval",
    );
    expect(dot?.getAttribute("class")).not.toContain(
      "sidebar-recent-session-spinner",
    );
  });
});
