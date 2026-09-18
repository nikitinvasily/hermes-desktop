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
      listProjects: vi.fn(async () => []),
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
  extra: {
    pendingRows?: Array<{
      id: string;
      title: string;
      contextFolder: string | null;
    }>;
    activePendingRunId?: string | null;
    onOpenPendingRun?: (runId: string) => void;
  } = {},
): void {
  render(
    <SidebarRecentSessions
      open
      connectionId="connection-main"
      activeProfile="default"
      currentSessionId={null}
      activePendingRunId={extra.activePendingRunId ?? null}
      loadingSessionIds={new Set()}
      resumingSessionId={null}
      pendingRows={extra.pendingRows ?? []}
      onSelect={vi.fn()}
      onOpenPendingRun={extra.onOpenPendingRun ?? vi.fn()}
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

describe("SidebarRecentSessions pending chat rows (issue #55)", () => {
  it("shows an unbound pending chat at the top of Chats and opens its run on click", async () => {
    const onOpenPendingRun = vi.fn();
    renderSidebar(vi.fn(), {
      pendingRows: [
        {
          id: "pending-run-a",
          title: "sessions.newChatPending",
          contextFolder: null,
        },
      ],
      activePendingRunId: "run-a",
      onOpenPendingRun,
    });

    const row = await screen.findByText("sessions.newChatPending");
    expect(row.closest(".sidebar-recent-session")).toHaveClass("active");
    fireEvent.click(row);
    expect(onOpenPendingRun).toHaveBeenCalledWith("run-a");
  });

  it("groups a project-bound pending chat under its project folder", async () => {
    renderSidebar(vi.fn(), {
      pendingRows: [
        {
          id: "pending-run-b",
          title: "sessions.newChatPending",
          contextFolder: "/tmp/proj",
        },
      ],
    });

    // The pending row renders inside the /tmp/proj project group — the same
    // group header as the cached session-proj row.
    const row = await screen.findByText("sessions.newChatPending");
    const group = row.closest(".sidebar-recent-project");
    expect(group).not.toBeNull();
    expect(group?.textContent).toContain("Project chat");
  });

  it("renders no options button on a pending row (no DB session behind it)", async () => {
    renderSidebar(vi.fn(), {
      pendingRows: [
        {
          id: "pending-run-c",
          title: "sessions.newChatPending",
          contextFolder: null,
        },
      ],
    });
    const row = await screen.findByText("sessions.newChatPending");
    const container = row.closest(".sidebar-recent-session");
    expect(container).not.toBeNull();
    expect(
      container?.querySelector(".sidebar-recent-session-options") ?? null,
    ).toBeNull();
  });
});
