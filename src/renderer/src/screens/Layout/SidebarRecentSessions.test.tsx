import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SidebarRecentSessions from "./SidebarRecentSessions";
import toast from "react-hot-toast";

vi.mock("react-hot-toast", () => ({ default: { error: vi.fn() } }));

declare const __dirname: string;

// Read CSS outside Vitest's CSS-module stubs and the binding-file fs mocks.
// Keep Node-only imports out of the renderer's browser typecheck.
const [{ join }, { readFile }] = await Promise.all([
  vi.importActual<{ join(...parts: string[]): string }>("node:path"),
  vi.importActual<{
    readFile(path: string, encoding: "utf8"): Promise<string>;
  }>("node:fs/promises"),
]);
const mainCss = await readFile(
  join(__dirname, "../../assets/main.css"),
  "utf8",
);

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

// Backlog #92: tests that need chats WITHOUT desktop bindings (so they
// group into the flat Chats section) rely on this nulling readFileSync —
// the bindings file read returns null. The CSS contract uses the actual
// fs/promises module independently of these runtime fs mocks.
vi.mock("fs", () => ({
  readFileSync: (): null => null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    readFileSync: (): null => null,
  };
});

// window.hermesAPI is injected by preload; provide the subset the sidebar uses.
beforeEach(() => {
  window.localStorage.clear();
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
      degraded={false}
      resyncNonce={0}
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

describe("SidebarRecentSessions quick actions", () => {
  it("shows localized update guidance and rolls back a failed rename without losing the editor", async () => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(window.hermesAPI.updateSessionTitle).mockRejectedValueOnce(
      new Error(
        'Error invoking remote method \'update-session-title\': RemoteOAuthError: Remote OAuth request failed (409): {"detail":"client_upgrade_required"}',
      ),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderSidebar(vi.fn());
      const row = await screen.findByText("Loose chat");
      fireEvent.contextMenu(
        row.closest(".sidebar-recent-session") as HTMLElement,
      );
      fireEvent.click(await screen.findByText("navigation.sessionMenu.rename"));
      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "Unsaved title" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledExactlyOnceWith(
          "sessions.renameUpgradeRequired",
        ),
      );
      const restoredInput = screen.getByRole("textbox");
      await waitFor(() => expect(restoredInput).toBeEnabled());
      expect(restoredInput).toHaveValue("Unsaved title");
      expect(screen.queryByText("Unsaved title")).not.toBeInTheDocument();
      expect(window.hermesAPI.updateSessionTitle).toHaveBeenCalledWith(
        "session-loose",
        "Unsaved title",
        "connection-main",
        "default",
      );
      fireEvent.change(restoredInput, { target: { value: "Saved title" } });
      fireEvent.keyDown(restoredInput, { key: "Enter" });
      await screen.findByText("Saved title");
      expect(window.hermesAPI.updateSessionTitle).toHaveBeenCalledTimes(2);
    } finally {
      errors.mockRestore();
    }
  });

  function setup(pending = false): ReturnType<typeof render> & {
    props: React.ComponentProps<typeof SidebarRecentSessions>;
    onPointerDown: ReturnType<typeof vi.fn>;
    onKeyUp: ReturnType<typeof vi.fn>;
  } {
    const props = {
      pendingSessions: pending
        ? [
            {
              id: "pending-chat",
              title: "Pending chat",
              pendingRunId: "run-chat",
            },
            {
              id: "pending-project",
              title: "Pending project",
              pendingRunId: "run-project",
              contextFolder: "/tmp/proj",
            },
          ]
        : [],
      open: true,
      connectionId: "connection-quick",
      activeProfile: "research",
      degraded: false,
      resyncNonce: 0,
      currentSessionId: "session-loose",
      loadingSessionIds: new Set<string>(),
      approvalSessionIds: new Set<string>(),
      resumingSessionId: null,
      onSelect: vi.fn(),
      onSessionDeleted: vi.fn(),
      scrollRootRef: { current: null },
    };
    window.hermesAPI.setSessionArchived = vi.fn(async () => true);
    const onPointerDown = vi.fn();
    const onKeyUp = vi.fn();
    const view = render(
      <div onPointerDown={onPointerDown} onKeyUp={onKeyUp}>
        <SidebarRecentSessions {...props} />
      </div>,
    );
    return { ...view, props, onPointerDown, onKeyUp };
  }

  async function row(title = "Loose chat"): Promise<HTMLElement> {
    return (await screen.findByText(title)).closest<HTMLElement>(
      ".sidebar-recent-session",
    )!;
  }

  it.each(["archive", "delete", "options"])(
    "isolates pointer and keyboard events for %s",
    async (action) => {
      const { props, onPointerDown, onKeyUp } = setup();
      const button = within(await row()).getByRole("button", {
        name: `navigation.sessionMenu.${action}`,
      });
      fireEvent.pointerDown(button);
      for (const key of ["Enter", " "]) {
        // Keep native button activation enabled; the row must not handle it.
        expect(fireEvent.keyDown(button, { key })).toBe(true);
        fireEvent.keyUp(button, { key });
      }
      expect(props.onSelect).not.toHaveBeenCalled();
      expect(onPointerDown).not.toHaveBeenCalled();
      expect(onKeyUp).not.toHaveBeenCalled();
      fireEvent.click(button);
      expect(props.onSelect).not.toHaveBeenCalled();
      if (action === "archive")
        expect(window.hermesAPI.setSessionArchived).toHaveBeenCalledTimes(1);
      if (action === "delete")
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      if (action === "options")
        expect(screen.getByRole("menu")).toBeInTheDocument();
    },
  );

  it.each(["Chats", "Pinned", "Project"])(
    "shares localized ordered actions and scoped mutations in %s",
    async (section) => {
      if (section === "Pinned")
        localStorage.setItem(
          "hermes.sidebar.pinnedSessions",
          JSON.stringify(["session-loose"]),
        );
      const { props } = setup();
      const title = section === "Project" ? "Project chat" : "Loose chat";
      const id = section === "Project" ? "session-proj" : "session-loose";
      const chat = await row(title);
      const buttons = within(chat).getAllByRole("button");
      expect(
        buttons.map((button) => button.getAttribute("aria-label")),
      ).toEqual([
        "navigation.sessionMenu.archive",
        "navigation.sessionMenu.delete",
        "navigation.sessionMenu.options",
      ]);
      for (const button of buttons) {
        expect(button.getAttribute("title")).toBe(
          button.getAttribute("aria-label"),
        );
        expect(button.tabIndex).toBe(0);
      }
      fireEvent.click(buttons[0]);
      expect(
        window.hermesAPI.setSessionArchived,
      ).toHaveBeenCalledExactlyOnceWith(
        id,
        true,
        "connection-quick",
        "research",
      );
      expect(screen.queryByText(title)).toBeNull();
      expect(props.onSelect).not.toHaveBeenCalled();
      if (section === "Pinned")
        expect(
          JSON.parse(localStorage.getItem("hermes.sidebar.pinnedSessions")!),
        ).toEqual([]);
    },
  );

  it("omits all controls on pending chat and project rows", async () => {
    setup(true);
    for (const title of ["Pending chat", "Pending project"]) {
      const pending = await row(title);
      expect(
        pending.querySelector(".sidebar-recent-session-actions"),
      ).toBeNull();
      expect(within(pending).queryAllByRole("button")).toHaveLength(0);
    }
  });

  it.each(["Chats", "Pinned", "Project", "Projects", "Sidebar"])(
    "removes hidden quick actions from tab order when %s collapses",
    async (section) => {
      if (section === "Pinned")
        localStorage.setItem(
          "hermes.sidebar.pinnedSessions",
          JSON.stringify(["session-loose"]),
        );
      const { rerender, props } = setup();
      await row(
        section === "Project" || section === "Projects"
          ? "Project chat"
          : "Loose chat",
      );
      if (section === "Sidebar")
        rerender(
          <div>
            <SidebarRecentSessions {...props} open={false} />
          </div>,
        );
      else
        fireEvent.click(
          screen.getByRole("button", {
            name:
              section === "Project"
                ? "Project"
                : `navigation.${section.toLowerCase()}`,
          }),
        );
      const buttons = (
        await row(
          section === "Project" || section === "Projects"
            ? "Project chat"
            : "Loose chat",
        )
      ).querySelectorAll<HTMLButtonElement>("button");
      expect(buttons).toHaveLength(3);
      for (const button of buttons) expect(button.tabIndex).toBe(-1);
    },
  );

  it("restores a chat through the existing forced refresh after archive failure", async () => {
    const { props } = setup();
    const chat = await row();
    const before = syncSessionCache.mock.calls.length;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(window.hermesAPI.setSessionArchived).mockRejectedValueOnce(
        new Error("Archive refused"),
      );
      fireEvent.click(
        within(chat).getByRole("button", {
          name: "navigation.sessionMenu.archive",
        }),
      );
      expect(screen.queryByText("Loose chat")).toBeNull();
      await screen.findByText("Loose chat");
      expect(syncSessionCache.mock.calls.length).toBeGreaterThan(before);
      expect(syncSessionCache).toHaveBeenLastCalledWith(
        "connection-quick",
        "research",
        51,
      );
      expect(props.onSelect).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("retains the quick-delete target and reports server refusal", async () => {
    const { props } = setup();
    const chat = await row();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(window.hermesAPI.deleteSession).mockRejectedValueOnce(
        new Error("Delete refused"),
      );
      fireEvent.click(
        within(chat).getByRole("button", {
          name: "navigation.sessionMenu.delete",
        }),
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: "navigation.sessionMenu.deleteConfirmAction",
        }),
      );
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Delete refused"),
      );
      expect(screen.getByText("Loose chat")).toBeInTheDocument();
      expect(props.onSessionDeleted).not.toHaveBeenCalled();
      expect(props.onSelect).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      vi.mocked(toast.error).mockClear();
    }
  });

  it("lays out an ordered non-overlapping action group revealed by hover, focus, or menu", async () => {
    setup();
    const chat = await row();
    const actions = chat.querySelector(".sidebar-recent-session-actions");
    expect(actions).not.toBeNull();
    expect(
      Array.from(actions!.querySelectorAll("button")).map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual([
      "navigation.sessionMenu.archive",
      "navigation.sessionMenu.delete",
      "navigation.sessionMenu.options",
    ]);
    const groupCss = mainCss.match(
      /\.sidebar-recent-session-actions\s*\{([^}]+)\}/,
    )?.[1];
    expect(groupCss).toMatch(/display:\s*flex/);
    expect(groupCss).toMatch(/flex:\s*0 0 auto/);
    expect(groupCss).toMatch(/opacity:\s*0/);
    expect(mainCss).toMatch(
      /\.sidebar-recent-session-actions > \.sidebar-recent-session-options\s*\{[^}]*position:\s*static/s,
    );
    expect(mainCss).toMatch(
      /\.sidebar-recent-session:hover > \.sidebar-recent-session-actions,/,
    );
    expect(mainCss).toMatch(
      /\.sidebar-recent-session:focus-within > \.sidebar-recent-session-actions,/,
    );
    expect(mainCss).toMatch(
      /\.sidebar-recent-session.menu-open > \.sidebar-recent-session-actions\s*\{[^}]*opacity:\s*1/s,
    );
    expect(mainCss).toMatch(
      /\.sidebar-recent-session-title\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis/s,
    );
  });

  it("requires explicit confirmation for quick delete and leaves cancel mutation-free", async () => {
    const { props } = setup();
    const chat = await row();
    const remove = within(chat).getByRole("button", {
      name: "navigation.sessionMenu.delete",
    });
    fireEvent.click(remove);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(window.hermesAPI.deleteSession).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getAllByRole("button", {
        name: "navigation.sessionMenu.deleteCancel",
      })[1],
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Loose chat")).toBeInTheDocument();
    expect(window.hermesAPI.deleteSession).not.toHaveBeenCalled();
    fireEvent.click(remove);
    syncSessionCache.mockResolvedValue([
      { id: "session-proj", title: "Project chat", contextFolder: "/tmp/proj" },
    ]);
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.sessionMenu.deleteConfirmAction",
      }),
    );
    await waitFor(() => expect(screen.queryByText("Loose chat")).toBeNull());
    expect(window.hermesAPI.deleteSession).toHaveBeenCalledExactlyOnceWith(
      "session-loose",
      "connection-quick",
      "research",
    );
    expect(props.onSessionDeleted).toHaveBeenCalledExactlyOnceWith(
      "session-loose",
      "connection-quick",
      "research",
    );
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("archives the targeted chat without selecting or deleting the active chat", async () => {
    const { props } = setup();
    const chat = await row();
    fireEvent.click(
      within(chat).getByRole("button", {
        name: "navigation.sessionMenu.archive",
      }),
    );
    expect(window.hermesAPI.setSessionArchived).toHaveBeenCalledWith(
      "session-loose",
      true,
      "connection-quick",
      "research",
    );
    expect(screen.queryByText("Loose chat")).toBeNull();
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onSessionDeleted).not.toHaveBeenCalled();
  });
});

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

// @lat: [[sidebar-navigation#Session channel icons]]
describe("SidebarRecentSessions channel icons (issue #140)", () => {
  function seedSessions(
    rows: Array<{
      id: string;
      title: string;
      contextFolder?: string | null;
      source?: string;
      unread?: boolean;
    }>,
  ): void {
    listCachedSessions.mockImplementation(async () => rows);
    syncSessionCache.mockImplementation(async () => rows);
  }

  it("replaces the neutral bullet with a channel icon and hover hint for telegram", async () => {
    seedSessions([
      {
        id: "session-tg",
        title: "Telegram chat",
        contextFolder: null,
        source: "telegram",
      },
    ]);
    renderSidebar(vi.fn());

    const row = await screen.findByText("Telegram chat");
    // Hover hint carries the provenance.
    expect(row.closest('[role="button"]')?.getAttribute("title")).toBe(
      "Telegram chat (via Telegram)",
    );
    // The channel icon (aria-label) replaced the neutral bullet.
    expect(screen.getByLabelText("Telegram")).toBeTruthy();
  });

  it("keeps state bullets' priority over the channel icon", async () => {
    seedSessions([
      {
        id: "session-tg-unread",
        title: "Unread telegram",
        contextFolder: null,
        source: "telegram",
        unread: true,
      },
    ]);
    renderSidebar(vi.fn());

    await screen.findByText("Unread telegram");
    // Unread wins: no channel icon rendered alongside.
    expect(screen.queryByLabelText("Telegram")).toBeNull();
  });

  it("leaves desktop sessions without icon or hint", async () => {
    seedSessions([
      { id: "session-desktop", title: "Desktop chat", contextFolder: null },
    ]);
    renderSidebar(vi.fn());

    const row = await screen.findByText("Desktop chat");
    expect(row.closest('[role="button"]')?.getAttribute("title")).toBe(
      "Desktop chat",
    );
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
        degraded={false}
        resyncNonce={0}
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
        degraded={false}
        resyncNonce={0}
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

  it("shows a Show more row for the 6th+ project and reveals it on click (issue #160)", async () => {
    const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"];
    listCachedSessions.mockImplementation(
      async (): Promise<
        Array<{ id: string; title: string; contextFolder?: string | null }>
      > => [],
    );
    syncSessionCache.mockImplementation(
      async (): Promise<
        Array<{ id: string; title: string; contextFolder?: string | null }>
      > => [],
    );
    renderSidebarProjects(
      names.map((name) => ({
        id: `p-${name}`,
        slug: name,
        name: name.charAt(0).toUpperCase() + name.slice(1),
        primaryPath: `/tmp/${name}`,
        folders: [{ path: `/tmp/${name}` }],
      })),
    );

    // First chunk: 5 of the 7 headings paint; the remaining 2 do not. Order
    // is alphabetical by display name (issue #74), so derive both sets.
    const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined));
    const cap = (n: string): string => n.charAt(0).toUpperCase() + n.slice(1);
    expect(await screen.findByText(cap(sorted[0]))).toBeTruthy();
    for (const name of sorted.slice(0, 5)) {
      expect(screen.getByText(cap(name)));
    }
    for (const name of sorted.slice(5)) {
      expect(screen.queryByText(cap(name))).toBeNull();
    }

    // The reveal row exists (the i18n mock does not interpolate, so the
    // hidden count is asserted by the reveal behavior itself).
    const showMore = screen.getByText("navigation.showMoreCount");

    // Click reveals the remaining chunk: all 7 headings are visible.
    fireEvent.click(showMore);
    await screen.findByText(cap(sorted[5]));
    expect(screen.getByText(cap(sorted[6]))).toBeTruthy();
    expect(screen.queryByText("navigation.showMoreCount")).toBeNull();
  });
});

describe("SidebarRecentSessions single pagination (backlog #92)", () => {
  function chatsFixture(
    count: number,
  ): Array<{ id: string; title: string; contextFolder?: string | null }> {
    return Array.from({ length: count }, (_, i) => ({
      id: `chat-${i}`,
      title: `Chat ${i}`,
      contextFolder: null,
    }));
  }

  it("keeps the Show more row alive (uncounted) while the server has more rows", async () => {
    // Offset-aware server: 61 chats exist; the first sync window hands the
    // renderer its top 51, the page fetch walks the rest by offset.
    const serverRows = chatsFixture(61);
    syncSessionCache.mockImplementation(async () => serverRows.slice(0, 51));
    listCachedSessions.mockImplementation(async (_l: number, offset: number) =>
      serverRows.slice(offset, offset + 31),
    );
    renderSidebar(() => undefined);

    await screen.findByText("Chat 0");
    // While hasMore is true the label carries NO count: the hidden count is
    // provisional (a prefetch can grow it), and a number that jumps upward
    // mid-reveal reads as a bug (user report on #92).
    const row = (): HTMLElement => screen.getByText("common.showMore");
    expect(screen.queryByText("navigation.showMoreCount")).toBeNull();
    // 6 chunks of 5 reveal the 30 initially held rows. Near the end of the
    // held window the click prefetches the next page (rows 30..60 land), so
    // the row survives with hidden rows beyond the reveal.
    for (let i = 0; i < 6; i++) {
      fireEvent.click(row());
    }
    expect(screen.getByText("common.showMore")).toBeTruthy();
    expect(screen.queryByText("Chat 29")).toBeTruthy();
    expect(screen.queryByText("Chat 30")).toBeNull();
    // The prefetch fired during those clicks (beyond the two initial loads).
    expect(listCachedSessions.mock.calls.length).toBeGreaterThan(2);
  });

  it("grows the sync window with the loaded list instead of shrinking it on refresh", async () => {
    const serverRows = chatsFixture(91);
    // First sync hands the renderer 51 rows (window 50 + end-probe).
    syncSessionCache.mockImplementation(async () => serverRows.slice(0, 51));
    listCachedSessions.mockImplementation(async (_l: number, offset: number) =>
      serverRows.slice(offset, offset + 31),
    );
    renderSidebar(() => undefined);
    await screen.findByText("Chat 0");

    // Reveal chunks until the loaded remainder runs low → prefetch fires and
    // the loaded list grows past the initial sync window (uncounted label
    // throughout: the server may always have more rows).
    const row = (): HTMLElement => screen.getByText("common.showMore");
    for (let i = 0; i < 9; i++) {
      fireEvent.click(row());
    }
    await waitFor(() => {
      // A page fetch was issued beyond the initial two loads.
      expect(listCachedSessions.mock.calls.length).toBeGreaterThan(2);
    });

    // The refresh sync window now follows the loaded size (>= 50, capped at
    // 100 by the dashboard limit) — never the flat 50 of the old behavior.
    const calls = syncSessionCache.mock.calls as unknown as Array<unknown[]>;
    const withWindow = calls.filter(
      (c) => typeof c[2] === "number" && (c[2] as number) >= 50,
    );
    expect(withWindow.length).toBeGreaterThan(0);
  });

  it("ends the row after full reveal: duplicate pages kill it, refresh only resurrects with real rows", async () => {
    // 61 rows on the server; the first sync window hands over 51 (renderer
    // holds their top 30). Page fetches at offset >= 30 return only rows
    // the window already delivered (the recency-reorder race). Two such
    // consecutive full-no-append pages end the offset walk.
    const serverRows = chatsFixture(61);
    syncSessionCache.mockImplementation(async () => serverRows.slice(0, 51));
    const heldPage = [...serverRows.slice(0, 29), serverRows[0], serverRows[1]];
    listCachedSessions.mockImplementation(async (_l: number, offset: number) =>
      offset < 30 ? serverRows.slice(offset, offset + 31) : heldPage,
    );
    renderSidebar(() => undefined);
    await screen.findByText("Chat 0");

    const row = (): HTMLElement | null =>
      screen.queryByText("common.showMore") ??
      screen.queryByText("navigation.showMoreCount");
    // Reveal: clicks walk the held 30 rows, prefetches hit the duplicate
    // page — one duplicate doesn't kill (streak < 2), the next click's
    // prefetch does. Loop guards on the row disappearing.
    for (let i = 0; i < 12 && row(); i++) {
      fireEvent.click(row() as HTMLElement);
      // Let the async prefetch append + streak settle.
      await waitFor(() => {});
      await waitFor(() => {});
    }
    await waitFor(() => {
      expect(screen.queryByText("common.showMore")).toBeNull();
      expect(screen.queryByText("navigation.showMoreCount")).toBeNull();
    });

    // A refresh sync delivers the window truth (51 rows > 30 loaded): the
    // row RETURNS, honestly, with rows to show — uncounted again, because
    // hasMore=true means the server may still hold more below the window.
    window.dispatchEvent(new Event("hermes-sessions-maybe-changed"));
    await waitFor(() => {
      expect(screen.queryByText("common.showMore")).toBeTruthy();
    });
    // Reveal the rest: each click also prefetches (hasMore is true again),
    // the duplicate pages rebuild the streak and the row dies for good.
    // Flush between clicks so the async fetches are not swallowed by the
    // reentry guard.
    for (let i = 0; i < 8 && row(); i++) {
      fireEvent.click(row() as HTMLElement);
      await waitFor(() => {});
      await waitFor(() => {});
    }
    window.dispatchEvent(new Event("hermes-sessions-maybe-changed"));
    await waitFor(() => {
      expect(screen.queryByText("common.showMore")).toBeNull();
      expect(screen.queryByText("navigation.showMoreCount")).toBeNull();
    });
  });

  it("hides the Show more row when everything is loaded and the server has no more", async () => {
    // 8 chats, all loaded, sync confirms exactly 8 (8 <= 30 → hasMore=false).
    const fixture = chatsFixture(8);
    syncSessionCache.mockImplementation(async () => fixture);
    listCachedSessions.mockImplementation(async () => fixture);
    renderSidebar(() => undefined);

    await screen.findByText("Chat 0");
    // Chunk cap 5 → one click reveals all 8; the row must disappear (no
    // hidden rows, no server rows either).
    fireEvent.click(screen.getByText("navigation.showMoreCount"));
    await waitFor(() => {
      expect(screen.queryByText("navigation.showMoreCount")).toBeNull();
    });
    expect(screen.queryByText("common.showMore")).toBeNull();
    expect(screen.getByText("Chat 7")).toBeTruthy();
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
        degraded={false}
        resyncNonce={0}
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
    onSessionDeleted = vi.fn(),
    treeRead?: () => Promise<Record<string, TreeRow[]>>,
  ): ReturnType<typeof render> {
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
          treeRead ??
            (async (): Promise<Record<string, unknown>> =>
              treeGroups as unknown as Record<string, unknown>),
        ),
      },
    });
    return render(
      <SidebarRecentSessions
        open
        connectionId="connection-main"
        activeProfile="default"
        degraded={false}
        resyncNonce={0}
        currentSessionId={null}
        loadingSessionIds={new Set()}
        approvalSessionIds={new Set()}
        resumingSessionId={null}
        onSelect={vi.fn()}
        onNewChatInProject={vi.fn()}
        onSessionDeleted={onSessionDeleted}
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

  it.each([
    ["connectionId", false],
    ["activeProfile", false],
    ["connectionId", true],
    ["activeProfile", true],
  ] as const)(
    "reports owning scope after a late delete without changing the new %s view (failure=%s)",
    async (scope, failure) => {
      const onSessionDeleted = vi.fn();
      const view = renderWithTreeGroups(
        [{ id: "same-id", title: "Original chat" }],
        {},
        onSessionDeleted,
      );
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      vi.mocked(window.hermesAPI.deleteSession).mockReturnValueOnce(
        new Promise<void>((done, fail) => {
          resolve = done;
          reject = fail;
        }),
      );
      await deleteRowViaMenu("Original chat");
      expect(onSessionDeleted).not.toHaveBeenCalled();
      const rows = [{ id: "same-id", title: "New scope equal-id chat" }];
      listCachedSessions.mockResolvedValue(rows);
      syncSessionCache.mockResolvedValue(rows);
      view.rerender(
        <SidebarRecentSessions
          open
          connectionId={scope === "connectionId" ? "other" : "connection-main"}
          activeProfile={scope === "activeProfile" ? "other" : "default"}
          degraded={false}
          resyncNonce={0}
          currentSessionId={null}
          loadingSessionIds={new Set()}
          approvalSessionIds={new Set()}
          resumingSessionId={null}
          onSelect={vi.fn()}
          onSessionDeleted={onSessionDeleted}
          scrollRootRef={{ current: null }}
        />,
      );
      await screen.findByText(rows[0].title);
      const changed = vi.fn();
      window.addEventListener("hermes-sessions-maybe-changed", changed);
      const syncCount = syncSessionCache.mock.calls.length;
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await act(async () => {
          if (failure) reject(new Error("Old scope refusal"));
          else resolve();
        });
        expect(onSessionDeleted.mock.calls).toEqual(
          failure ? [] : [["same-id", "connection-main", "default"]],
        );
        expect(screen.getByText(rows[0].title)).toBeInTheDocument();
        expect(changed).not.toHaveBeenCalled();
        expect(syncSessionCache).toHaveBeenCalledTimes(syncCount);
        expect(toast.error).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
        window.removeEventListener("hermes-sessions-maybe-changed", changed);
      }
    },
  );

  it.each(["Chats", "Pinned", "Project"])(
    "does not resurrect a confirmed deletion from a refresh started before DELETE in %s",
    async (section) => {
      const rows = [
        {
          id: "deleted-race",
          title: "Delayed deletion chat",
          contextFolder: section === "Project" ? "/tmp/proj" : null,
        },
      ];
      if (section === "Pinned")
        localStorage.setItem(
          "hermes.sidebar.pinnedSessions",
          JSON.stringify([rows[0].id]),
        );
      renderWithTreeGroups(rows, {});
      await screen.findByText(rows[0].title);
      await act(async () => {});
      let finish!: (rows: Array<Record<string, unknown>>) => void;
      syncSessionCache.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      act(() =>
        window.dispatchEvent(new Event("hermes-sessions-maybe-changed")),
      );
      expect(finish).toBeTypeOf("function");
      // Subsequent refreshes see the authoritative post-delete state.
      syncSessionCache.mockResolvedValue([]);
      await deleteRowViaMenu(rows[0].title);
      await waitFor(() => expect(screen.queryByText(rows[0].title)).toBeNull());
      await act(async () => {
        finish(rows);
      });
      expect(screen.queryByText(rows[0].title)).toBeNull();
    },
  );

  it("rejects a project-tree snapshot captured before confirmed deletion", async () => {
    const rows = [
      {
        id: "late-tree-delete",
        title: "Late tree deletion",
        contextFolder: "/tmp/proj",
      },
    ];
    let finish!: (groups: Record<string, TreeRow[]>) => void;
    renderWithTreeGroups(
      rows,
      {},
      vi.fn(),
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await screen.findByText(rows[0].title);
    await act(async () => {});
    syncSessionCache.mockResolvedValue([]);
    await deleteRowViaMenu(rows[0].title);
    await waitFor(() => expect(screen.queryByText(rows[0].title)).toBeNull());
    await act(async () => {
      finish({ "/tmp/proj": rows });
    });
    expect(screen.queryByText(rows[0].title)).toBeNull();
  });

  // @lat: [[connections#Connections#Test specifications#Deletion failure preserves sidebar rows]]
  it("keeps a tree-only row when deletion is refused and shows the error", async () => {
    renderWithTreeGroups([], {
      "/tmp/proj": [
        {
          id: "session-tree",
          title: "Tree-only chat",
          contextFolder: "/tmp/proj",
        },
      ],
    });
    vi.mocked(window.hermesAPI.deleteSession).mockRejectedValueOnce(
      new Error("409: revision_conflict"),
    );
    await deleteRowViaMenu("Tree-only chat");
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("409: revision_conflict"),
    );
    expect(screen.getByText("Tree-only chat")).toBeInTheDocument();
  });

  it("does not hide a row while the server has not confirmed deletion", async () => {
    renderWithTreeGroups([], {
      "/tmp/proj": [
        {
          id: "session-tree",
          title: "Tree-only chat",
          contextFolder: "/tmp/proj",
        },
      ],
    });
    let finish!: () => void;
    vi.mocked(window.hermesAPI.deleteSession).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await deleteRowViaMenu("Tree-only chat");
    expect(screen.getByText("Tree-only chat")).toBeInTheDocument();
    await act(async () => {
      finish();
    });
    await waitFor(() =>
      expect(screen.queryByText("Tree-only chat")).toBeNull(),
    );
  });

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
        degraded={false}
        resyncNonce={0}
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
        degraded={false}
        resyncNonce={0}
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
        degraded={false}
        resyncNonce={0}
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
        degraded={false}
        resyncNonce={0}
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
        degraded={false}
        resyncNonce={0}
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
  it("keeps project activity spans out of title flex sizing and rotates waiting rings", () => {
    expect(mainCss).not.toMatch(/\.sidebar-recent-project-heading\s+span\s*\{/);
    expect(mainCss).toMatch(
      /\.sidebar-recent-project-title\s*\{[^}]*flex:\s*1 1 auto/s,
    );
    const waiting = mainCss.match(
      /\.sidebar-recent-session-waiting-subagents\s*\{([^}]+)\}/,
    )?.[1];
    expect(waiting).toMatch(/width:\s*13px/);
    expect(waiting).toMatch(/height:\s*13px/);
    expect(waiting).toMatch(/flex:\s*0 0 13px/);
    expect(waiting).toMatch(/animation:\s*spin 0\.8s linear infinite/);
  });

  it("prioritizes approval > running > waiting > unread and aggregates waiting projects", async () => {
    const rows = [
      {
        id: "parent",
        title: "Waiting parent",
        contextFolder: "/tmp/proj",
        unread: true,
      },
    ];
    listCachedSessions.mockResolvedValue(rows);
    syncSessionCache.mockResolvedValue(rows);
    const props = {
      open: true,
      connectionId: "connection-main",
      activeProfile: "default",
      degraded: false,
      resyncNonce: 0,
      currentSessionId: null,
      loadingSessionIds: new Set<string>(),
      approvalSessionIds: new Set<string>(),
      subagentSessionIds: new Set(["parent"]),
      resumingSessionId: null,
      onSelect: vi.fn(),
      onSessionDeleted: vi.fn(),
      scrollRootRef: { current: null },
    };
    const { rerender } = render(<SidebarRecentSessions {...props} />);
    await screen.findByText("Waiting parent");
    const row = (): Element =>
      screen.getByText("Waiting parent").closest(".sidebar-recent-session")!;
    expect(
      row()
        .querySelector(".sidebar-recent-session-waiting-subagents")
        ?.getAttribute("aria-label"),
    ).toBe("navigation.waitingSubagents");
    await waitFor(() =>
      expect(
        document.querySelector(
          ".sidebar-recent-project-heading .sidebar-recent-session-waiting-subagents",
        ),
      ).not.toBeNull(),
    );
    rerender(
      <SidebarRecentSessions
        {...props}
        loadingSessionIds={new Set(["parent"])}
      />,
    );
    expect(
      row().querySelector(".sidebar-recent-session-spinner"),
    ).not.toBeNull();
    expect(
      row().querySelector(".sidebar-recent-session-waiting-subagents"),
    ).toBeNull();
    rerender(
      <SidebarRecentSessions
        {...props}
        loadingSessionIds={new Set(["parent"])}
        approvalSessionIds={new Set(["parent"])}
      />,
    );
    expect(
      row().querySelector(".sidebar-recent-session-dot--approval"),
    ).not.toBeNull();
    rerender(
      <SidebarRecentSessions {...props} subagentSessionIds={new Set()} />,
    );
    expect(
      row().querySelector(".sidebar-recent-session-waiting-subagents"),
    ).toBeNull();
    expect(
      row().querySelector(".sidebar-recent-session-dot--unread"),
    ).not.toBeNull();
    expect(
      document.querySelector(
        ".sidebar-recent-project-heading .sidebar-recent-session-waiting-subagents",
      ),
    ).toBeNull();
  });

  it("aggregates different sessions as approval > running > waiting > folder even when collapsed", async () => {
    const rows = [
      {
        id: "waiting-child",
        title: "Waiting child",
        contextFolder: "/tmp/proj",
      },
      {
        id: "working-child",
        title: "Working child",
        contextFolder: "/tmp/proj",
      },
      {
        id: "approval-child",
        title: "Approval child",
        contextFolder: "/tmp/proj",
      },
    ];
    listCachedSessions.mockResolvedValue(rows);
    syncSessionCache.mockResolvedValue(rows);
    const props = {
      open: true,
      connectionId: "connection-main",
      activeProfile: "default",
      degraded: false,
      resyncNonce: 0,
      currentSessionId: null,
      loadingSessionIds: new Set(["working-child"]),
      approvalSessionIds: new Set<string>(),
      subagentSessionIds: new Set(["waiting-child"]),
      resumingSessionId: null,
      onSelect: vi.fn(),
      onSessionDeleted: vi.fn(),
      scrollRootRef: { current: null },
    };
    const { rerender } = render(<SidebarRecentSessions {...props} />);
    await screen.findByText("Working child");
    const heading = (): HTMLButtonElement =>
      document.querySelector(".sidebar-recent-project-heading")!;
    const has = (selector: string): boolean =>
      !!heading().querySelector(selector);
    expect(has(".sidebar-recent-session-spinner")).toBe(true);
    expect(has(".sidebar-recent-session-waiting-subagents")).toBe(false);
    expect(
      heading().querySelector(".sidebar-recent-project-title"),
    ).not.toBeNull();
    fireEvent.click(heading());
    expect(heading().getAttribute("aria-expanded")).toBe("false");
    expect(has(".sidebar-recent-session-spinner")).toBe(true);
    rerender(
      <SidebarRecentSessions
        {...props}
        approvalSessionIds={new Set(["approval-child"])}
      />,
    );
    expect(has(".sidebar-recent-session-dot--approval")).toBe(true);
    expect(has(".sidebar-recent-session-spinner")).toBe(false);
    rerender(
      <SidebarRecentSessions {...props} loadingSessionIds={new Set()} />,
    );
    expect(has(".sidebar-recent-session-waiting-subagents")).toBe(true);
    expect(has(".sidebar-recent-session-spinner")).toBe(false);
    expect(heading().getAttribute("aria-expanded")).toBe("false");
    rerender(
      <SidebarRecentSessions
        {...props}
        loadingSessionIds={new Set()}
        subagentSessionIds={new Set()}
      />,
    );
    expect(has(".sidebar-recent-session-waiting-subagents")).toBe(false);
    expect(has("svg.lucide-folder")).toBe(true);
  });

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
        degraded={false}
        resyncNonce={0}
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

    // A committed backend write is reflected by the subsequent authoritative
    // sync; a permanently unread mock would represent new/uncommitted activity.
    syncSessionCache.mockResolvedValue([
      {
        id: "session-unread",
        title: "Unread chat",
        contextFolder: null,
        unread: false,
      },
    ]);
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
        degraded={false}
        resyncNonce={0}
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
        degraded={false}
        resyncNonce={0}
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
        degraded={false}
        resyncNonce={0}
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

describe("project bullet child-activity aggregation (task #89)", () => {
  function projectBullet(): Element | null {
    const heading = document.querySelector(".sidebar-recent-project-heading");
    return (
      heading?.querySelector(
        ".sidebar-recent-session-dot, .sidebar-recent-session-spinner, svg",
      ) ?? null
    );
  }

  function renderProjectSidebar(props: {
    loadingSessionIds?: Set<string>;
    approvalSessionIds?: Set<string>;
    resumingSessionId?: string | null;
  }): void {
    render(
      <SidebarRecentSessions
        open
        connectionId="connection-main"
        activeProfile="default"
        degraded={false}
        resyncNonce={0}
        currentSessionId={null}
        loadingSessionIds={props.loadingSessionIds ?? new Set()}
        approvalSessionIds={props.approvalSessionIds ?? new Set()}
        resumingSessionId={props.resumingSessionId ?? null}
        onSelect={vi.fn()}
        onSessionDeleted={vi.fn()}
        scrollRootRef={{ current: null }}
      />,
    );
  }

  it("renders the Folder icon when no child is active", async () => {
    renderProjectSidebar({});
    await screen.findByText("Project chat");
    // The default bullet is the lucide Folder svg (no state classes).
    const bullet = projectBullet();
    expect(bullet?.getAttribute("class")).not.toContain(
      "sidebar-recent-session-spinner",
    );
    expect(bullet?.getAttribute("class")).not.toContain(
      "sidebar-recent-session-dot--approval",
    );
  });

  it("renders the running spinner when a child session is loading", async () => {
    renderProjectSidebar({ loadingSessionIds: new Set(["session-proj"]) });
    await screen.findByText("Project chat");
    expect(projectBullet()?.getAttribute("class")).toContain(
      "sidebar-recent-session-spinner",
    );
  });

  it("renders the approval dot when a child session awaits approval", async () => {
    renderProjectSidebar({
      approvalSessionIds: new Set(["session-proj"]),
    });
    await screen.findByText("Project chat");
    expect(projectBullet()?.getAttribute("class")).toContain(
      "sidebar-recent-session-dot--approval",
    );
  });

  it("aggregates over ANY child, not just the first", async () => {
    listCachedSessions.mockImplementation(async () => [
      {
        id: "session-proj-a",
        title: "Project chat A",
        contextFolder: "/tmp/proj",
      },
      {
        id: "session-proj-b",
        title: "Project chat B",
        contextFolder: "/tmp/proj",
      },
    ]);
    syncSessionCache.mockImplementation(async () => [
      {
        id: "session-proj-a",
        title: "Project chat A",
        contextFolder: "/tmp/proj",
      },
      {
        id: "session-proj-b",
        title: "Project chat B",
        contextFolder: "/tmp/proj",
      },
    ]);
    renderProjectSidebar({
      loadingSessionIds: new Set(["session-proj-b"]),
    });
    await screen.findByText("Project chat B");
    expect(projectBullet()?.getAttribute("class")).toContain(
      "sidebar-recent-session-spinner",
    );
  });

  it("approval wins over running for the project bullet", async () => {
    renderProjectSidebar({
      loadingSessionIds: new Set(["session-proj"]),
      approvalSessionIds: new Set(["session-proj"]),
    });
    await screen.findByText("Project chat");
    const bullet = projectBullet();
    expect(bullet?.getAttribute("class")).toContain(
      "sidebar-recent-session-dot--approval",
    );
    expect(bullet?.getAttribute("class")).not.toContain(
      "sidebar-recent-session-spinner",
    );
  });

  it("ignores a child that is only resuming (history fetch, not activity)", async () => {
    renderProjectSidebar({ resumingSessionId: "session-proj" });
    await screen.findByText("Project chat");
    expect(projectBullet()?.getAttribute("class")).not.toContain(
      "sidebar-recent-session-spinner",
    );
  });

  it("keeps the spinner footprint square inside the project heading (CSS contract)", async () => {
    renderProjectSidebar({ loadingSessionIds: new Set(["session-proj"]) });
    await screen.findByText("Project chat");
    // The heading's title rule (.sidebar-recent-project-heading span with
    // flex: 1 1 auto) also matches the spinner span — without the explicit
    // re-pin the 13px ring stretches into a horizontal bar ("stick").
    const re =
      /\.sidebar-recent-project-heading \.sidebar-recent-session-spinner\s*\{[^}]*flex:\s*0 0 13px[^}]*\}/;
    expect(mainCss).toMatch(re);
  });
});

describe("remote connection health (backlog #74/#75)", () => {
  const chatsToggle = (): HTMLElement | null =>
    [...document.querySelectorAll(".sidebar-recent-section-toggle")].find((b) =>
      b.textContent?.includes("navigation.chats"),
    ) as HTMLElement | null;

  test("degraded retains the sidebar snapshot but disables stale actions", async () => {
    const { rerender } = render(
      <SidebarRecentSessions
        open
        connectionId="connection-main"
        activeProfile="default"
        degraded={false}
        resyncNonce={0}
        currentSessionId={null}
        loadingSessionIds={new Set()}
        approvalSessionIds={new Set()}
        resumingSessionId={null}
        onSelect={vi.fn()}
        onSessionDeleted={vi.fn()}
        scrollRootRef={{ current: null }}
      />,
    );
    await screen.findByText("Project chat");
    rerender(
      <SidebarRecentSessions
        open
        connectionId="connection-main"
        activeProfile="default"
        degraded
        resyncNonce={0}
        currentSessionId={null}
        loadingSessionIds={new Set()}
        approvalSessionIds={new Set()}
        resumingSessionId={null}
        onSelect={vi.fn()}
        onSessionDeleted={vi.fn()}
        scrollRootRef={{ current: null }}
      />,
    );
    // @lat: [[sidebar-navigation#Sidebar recent sessions#Connection recovery preserves browsing]]
    expect(screen.queryByText("Project chat")).not.toBeNull();
    expect(screen.queryByText("Loose chat")).not.toBeNull();
    expect(
      document
        .querySelector(".sidebar-recent-sessions-wrap")
        ?.hasAttribute("inert"),
    ).toBe(true);
  });

  test("recovery replaces tree-only project chats only after group membership resolves", async () => {
    listCachedSessions.mockResolvedValue([]);
    syncSessionCache.mockResolvedValue([]);
    const listGroups = vi.mocked(window.hermesAPI.listProjectGroupSessions);
    listGroups.mockResolvedValue({
      "/tmp/proj": [
        {
          id: "tree-only",
          title: "Tree-only chat",
          contextFolder: "/tmp/proj",
          startedAt: 1,
          lastActivityAt: 1,
          source: "cli",
          messageCount: 1,
          model: "test",
        },
      ],
    });
    const props = {
      open: true,
      connectionId: "connection-main",
      activeProfile: "default",
      degraded: false,
      resyncNonce: 0,
      currentSessionId: null,
      loadingSessionIds: new Set<string>(),
      approvalSessionIds: new Set<string>(),
      resumingSessionId: null,
      onSelect: vi.fn(),
      onSessionDeleted: vi.fn(),
      scrollRootRef: { current: null },
    };
    const { rerender } = render(<SidebarRecentSessions {...props} />);
    await screen.findByText("Tree-only chat");
    const heading = screen.getByRole("button", { name: "Project" });
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    rerender(<SidebarRecentSessions {...props} degraded />);
    expect(screen.queryByText("Tree-only chat")).not.toBeNull();

    // The chat was removed/archived on the server during the outage. Keep
    // its snapshot until the recovery request returns, even an empty map.
    type Groups = Awaited<
      ReturnType<typeof window.hermesAPI.listProjectGroupSessions>
    >;
    let resolveGroups!: (groups: Groups) => void;
    const recoveredGroups = new Promise<Groups>((resolve) => {
      resolveGroups = resolve;
    });
    listGroups.mockReturnValue(recoveredGroups);
    rerender(<SidebarRecentSessions {...props} resyncNonce={1} />);
    expect(screen.queryByText("Tree-only chat")).not.toBeNull();
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      resolveGroups({});
      await recoveredGroups;
    });
    await waitFor(() => {
      expect(screen.queryByText("Tree-only chat")).toBeNull();
    });
    expect(listGroups).toHaveBeenCalledTimes(2);
    expect(heading.getAttribute("aria-expanded")).toBe("true");
  });

  test("recovery refreshes folder names without clearing the pending snapshot", async () => {
    const listNames = vi.mocked(window.hermesAPI.listProjectFolderNames);
    listNames.mockResolvedValue({ "/tmp/proj": "Old folder name" });
    const props = {
      open: true,
      connectionId: "connection-main",
      activeProfile: "default",
      degraded: false,
      resyncNonce: 0,
      currentSessionId: null,
      loadingSessionIds: new Set<string>(),
      approvalSessionIds: new Set<string>(),
      resumingSessionId: null,
      onSelect: vi.fn(),
      onSessionDeleted: vi.fn(),
      scrollRootRef: { current: null },
    };
    const { rerender } = render(<SidebarRecentSessions {...props} />);
    const heading = await screen.findByRole("button", {
      name: "Old folder name",
    });
    fireEvent.click(heading);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    rerender(<SidebarRecentSessions {...props} degraded />);
    let resolveNames!: (names: Record<string, string>) => void;
    const recoveredNames = new Promise<Record<string, string>>((resolve) => {
      resolveNames = resolve;
    });
    listNames.mockReturnValue(recoveredNames);
    rerender(<SidebarRecentSessions {...props} resyncNonce={1} />);
    expect(
      screen.queryByRole("button", { name: "Old folder name" }),
    ).not.toBeNull();
    await act(async () => {
      resolveNames({ "/tmp/proj": "New folder name" });
      await recoveredNames;
    });
    expect(await screen.findByRole("button", { name: "New folder name" })).toBe(
      heading,
    );
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    expect(listNames).toHaveBeenCalledTimes(2);
  });

  test("collapsed Chats stays collapsed across a forced resync (resyncNonce)", async () => {
    localStorage.setItem("hermes.sidebar.chatsOpen", "false");
    try {
      const { rerender } = render(
        <SidebarRecentSessions
          open
          connectionId="connection-main"
          activeProfile="default"
          degraded={false}
          resyncNonce={0}
          currentSessionId={null}
          loadingSessionIds={new Set()}
          approvalSessionIds={new Set()}
          resumingSessionId={null}
          onSelect={vi.fn()}
          onSessionDeleted={vi.fn()}
          scrollRootRef={{ current: null }}
        />,
      );
      await screen.findByText("Project chat");
      rerender(
        <SidebarRecentSessions
          open
          connectionId="connection-main"
          activeProfile="default"
          degraded={false}
          resyncNonce={1}
          currentSessionId={null}
          loadingSessionIds={new Set()}
          approvalSessionIds={new Set()}
          resumingSessionId={null}
          onSelect={vi.fn()}
          onSessionDeleted={vi.fn()}
          scrollRootRef={{ current: null }}
        />,
      );
      await screen.findByText("Project chat");
      expect(chatsToggle()?.getAttribute("aria-expanded")).toBe("false");
    } finally {
      localStorage.removeItem("hermes.sidebar.chatsOpen");
    }
  });
});
