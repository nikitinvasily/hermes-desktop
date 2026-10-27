import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// useI18n needs an I18nProvider; the Sessions tab only uses `t` for labels,
// so a pass-through mock keeps these tests focused on the refresh behaviour.
vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: () => {},
  }),
}));

vi.mock("react-hot-toast", () => ({ default: { error: vi.fn() } }));
import toast from "react-hot-toast";
import Sessions, { SESSIONS_REFRESH_MS } from "./Sessions";

const baseProps = {
  onResumeSession: (): void => {},
  onNewChat: (): void => {},
  currentSessionId: null,
  connectionId: "connection-one",
  profile: "work",
};

function installHermesAPI(initialSessions: unknown[] = []): {
  listCachedSessions: ReturnType<typeof vi.fn>;
  syncSessionCache: ReturnType<typeof vi.fn>;
  getConnectionConfig: ReturnType<typeof vi.fn>;
  searchSessions: ReturnType<typeof vi.fn>;
  updateSessionTitle: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
  deleteSessions: ReturnType<typeof vi.fn>;
  emitConnectionConfigChanged: () => void;
} {
  let connectionConfigChanged: (() => void) | null = null;
  const api = {
    listCachedSessions: vi.fn().mockResolvedValue(initialSessions),
    syncSessionCache: vi.fn().mockResolvedValue(initialSessions),
    getConnectionConfig: vi.fn().mockResolvedValue({ mode: "ssh" }),
    searchSessions: vi.fn().mockResolvedValue([]),
    updateSessionTitle: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    deleteSessions: vi.fn().mockResolvedValue({ requested: 0, deleted: 0 }),
    onConnectionConfigChanged: vi.fn((callback: () => void) => {
      connectionConfigChanged = callback;
      return () => {
        if (connectionConfigChanged === callback) {
          connectionConfigChanged = null;
        }
      };
    }),
  };
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: api,
  });
  return {
    ...api,
    emitConnectionConfigChanged: () => connectionConfigChanged?.(),
  };
}

function sessionSearchResult(
  title: string | null,
  snippet: string,
  sessionId?: string,
): {
  sessionId: string;
  title: string | null;
  startedAt: number;
  source: string;
  messageCount: number;
  model: string;
  snippet: string;
} {
  return {
    sessionId:
      sessionId ??
      (title ?? snippet)
        .replace(/<</g, "")
        .replace(/>>/g, "")
        .toLowerCase()
        .replace(/\s+/g, "-"),
    title,
    startedAt: Math.floor(Date.now() / 1000),
    source: "desktop",
    messageCount: 1,
    model: "gpt-5.5",
    snippet,
  };
}

describe("Sessions tab live refresh (#322)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // @lat: [[connections#Test specifications#Connection-explicit session browsing#Routes renderer operations]]
  it("routes browsing and rename operations through the selected connection and profile", async () => {
    vi.useRealTimers();
    const api = installHermesAPI([
      {
        id: "routed-session",
        title: "Routed chat",
        startedAt: Math.floor(Date.now() / 1000),
        source: "desktop",
        messageCount: 2,
        model: "gpt-5.5",
      },
    ]);

    render(<Sessions {...baseProps} visible={true} />);
    await waitFor(() => {
      expect(api.syncSessionCache).toHaveBeenCalledWith(
        "connection-one",
        "work",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "sessions.rename" }));
    const renameInput = screen.getAllByRole("textbox")[1];
    fireEvent.change(renameInput, { target: { value: "Renamed route" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });
    await waitFor(() => {
      expect(api.updateSessionTitle).toHaveBeenCalledWith(
        "routed-session",
        "Renamed route",
        "connection-one",
        "work",
      );
    });

    fireEvent.change(
      screen.getByPlaceholderText("sessions.searchPlaceholder"),
      { target: { value: "route" } },
    );
    await waitFor(() => {
      expect(api.searchSessions).toHaveBeenCalledWith(
        "route",
        undefined,
        "connection-one",
        "work",
      );
    });
  });

  it("disables the rename input during persistence and ignores a duplicate submit", async () => {
    vi.useRealTimers();
    const api = installHermesAPI([
      {
        id: "pending-session",
        title: "Original",
        startedAt: Date.now() / 1000,
        source: "desktop",
        messageCount: 1,
        model: "test",
      },
    ]);
    let complete!: () => void;
    api.updateSessionTitle.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    render(<Sessions {...baseProps} visible={true} />);
    await waitFor(() => expect(screen.getByText("Original")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "sessions.rename" }));
    const input = screen.getAllByRole("textbox")[1] as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Saved name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.disabled).toBe(true);
    fireEvent.blur(input);
    expect(api.updateSessionTitle).toHaveBeenCalledTimes(1);
    await act(async () => {
      complete();
    });
    expect(screen.getByText("Saved name")).toBeTruthy();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("re-syncs from state.db on an interval while the tab is visible", async () => {
    const api = installHermesAPI();
    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    const afterMount = api.syncSessionCache.mock.calls.length;
    expect(afterMount).toBeGreaterThan(0);

    await act(async () => {
      vi.advanceTimersByTime(SESSIONS_REFRESH_MS);
    });
    expect(api.syncSessionCache.mock.calls.length).toBe(afterMount + 1);

    await act(async () => {
      vi.advanceTimersByTime(SESSIONS_REFRESH_MS);
    });
    expect(api.syncSessionCache.mock.calls.length).toBe(afterMount + 2);
  });

  it("runs no timer while the tab is hidden", async () => {
    const api = installHermesAPI();
    render(<Sessions {...baseProps} visible={false} />);
    await act(async () => {});

    const afterMount = api.syncSessionCache.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(SESSIONS_REFRESH_MS * 5);
    });
    expect(api.syncSessionCache.mock.calls.length).toBe(afterMount);
  });

  it("stops the timer once the tab becomes hidden", async () => {
    const api = installHermesAPI();
    const view = render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    await act(async () => {
      view.rerender(<Sessions {...baseProps} visible={false} />);
    });
    const afterHide = api.syncSessionCache.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(SESSIONS_REFRESH_MS * 3);
    });
    expect(api.syncSessionCache.mock.calls.length).toBe(afterHide);
  });

  it("refreshes when the window regains focus", async () => {
    const api = installHermesAPI();
    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    const afterMount = api.syncSessionCache.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(api.syncSessionCache.mock.calls.length).toBe(afterMount + 1);
  });

  it("keeps visible sessions when a quiet refresh transiently returns empty", async () => {
    const api = installHermesAPI([
      {
        id: "ssh-session",
        title: "SSH session",
        startedAt: Math.floor(Date.now() / 1000),
        source: "api_server",
        messageCount: 3,
        model: "deepseek-v4-pro",
      },
    ]);

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});
    expect(screen.getByText("SSH session")).toBeTruthy();

    api.syncSessionCache.mockResolvedValue([]);

    await act(async () => {
      vi.advanceTimersByTime(SESSIONS_REFRESH_MS);
    });

    expect(screen.getByText("SSH session")).toBeTruthy();
    expect(screen.queryByText("sessions.empty")).toBeNull();
  });

  it("removes the last native-archived local session and shows it again on restore", async () => {
    const rows = [
      {
        id: "local-session",
        title: "Local chat",
        startedAt: 200,
        source: "desktop",
        messageCount: 2,
        model: "gpt-5.5",
      },
    ];
    const api = installHermesAPI(rows);
    api.getConnectionConfig.mockResolvedValue({ mode: "local" });
    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});
    expect(screen.getByText("Local chat")).toBeTruthy();

    api.syncSessionCache.mockResolvedValue([]);
    await act(async () => {
      vi.advanceTimersByTime(SESSIONS_REFRESH_MS);
    });
    expect(screen.queryByText("Local chat")).toBeNull();
    expect(screen.getByText("sessions.empty")).toBeTruthy();
    expect(api.getConnectionConfig).toHaveBeenCalledWith("connection-one");

    api.syncSessionCache.mockResolvedValue(rows);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByText("Local chat")).toBeTruthy();
  });

  it("preserves visible rows when confirming a local empty refresh fails, then retries", async () => {
    const api = installHermesAPI([
      {
        id: "local-session",
        title: "Local chat",
        startedAt: 200,
        source: "desktop",
        messageCount: 2,
        model: "gpt-5.5",
      },
    ]);
    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});
    api.syncSessionCache.mockResolvedValue([]);
    api.getConnectionConfig.mockRejectedValueOnce(
      new Error("Connection unavailable"),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => {
        vi.advanceTimersByTime(SESSIONS_REFRESH_MS);
      });
      expect(screen.getByText("Local chat")).toBeTruthy();
      api.getConnectionConfig.mockResolvedValue({ mode: "local" });
      await act(async () => {
        vi.advanceTimersByTime(SESSIONS_REFRESH_MS);
      });
      expect(screen.queryByText("Local chat")).toBeNull();
    } finally {
      errors.mockRestore();
    }
  });

  it("does not apply an old empty refresh after switching profiles", async () => {
    const api = installHermesAPI([
      {
        id: "local-session",
        title: "Old profile chat",
        startedAt: 200,
        source: "desktop",
        messageCount: 2,
        model: "gpt-5.5",
      },
    ]);
    const view = render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});
    let resolveConfig!: (value: { mode: "local" }) => void;
    api.getConnectionConfig.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConfig = resolve;
      }),
    );
    api.syncSessionCache.mockResolvedValueOnce([]);
    await act(async () => {
      vi.advanceTimersByTime(SESSIONS_REFRESH_MS);
    });
    expect(api.getConnectionConfig).toHaveBeenCalledWith("connection-one");

    api.syncSessionCache.mockResolvedValue([
      {
        id: "other-session",
        title: "Other profile chat",
        startedAt: 200,
        source: "desktop",
        messageCount: 2,
        model: "gpt-5.5",
      },
    ]);
    await act(async () => {
      view.rerender(<Sessions {...baseProps} profile="other" visible={true} />);
    });
    expect(screen.getByText("Other profile chat")).toBeTruthy();
    await act(async () => {
      resolveConfig({ mode: "local" });
    });
    expect(screen.getByText("Other profile chat")).toBeTruthy();
  });

  it("defaults to chats and persists the automation filter", async () => {
    vi.useRealTimers();
    const rows = [
      {
        id: "chat-session",
        title: "Manual chat",
        startedAt: Math.floor(Date.now() / 1000),
        source: "desktop",
        messageCount: 2,
        model: "gpt-5.5",
      },
      {
        id: "cron-session",
        title: "Nightly automation",
        startedAt: Math.floor(Date.now() / 1000),
        source: "cron",
        messageCount: 2,
        model: "gpt-5.5",
      },
    ];
    installHermesAPI(rows);
    const view = render(<Sessions {...baseProps} visible={true} />);
    await waitFor(() => expect(screen.getByText("Manual chat")).toBeTruthy());
    expect(screen.queryByText("Nightly automation")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "sessions.filter.automation" }),
    );
    expect(screen.queryByText("Manual chat")).toBeNull();
    expect(screen.getByText("Nightly automation")).toBeTruthy();

    view.unmount();
    render(<Sessions {...baseProps} visible={true} />);
    await waitFor(() =>
      expect(screen.getByText("Nightly automation")).toBeTruthy(),
    );
    expect(screen.queryByText("Manual chat")).toBeNull();
  });

  it("clears stale rows and reloads when the connection source changes", async () => {
    vi.useRealTimers();
    const api = installHermesAPI([
      {
        id: "local-session",
        title: "Local session",
        startedAt: Math.floor(Date.now() / 1000),
        source: "desktop",
        messageCount: 1,
        model: "gpt-5.5",
      },
    ]);
    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});
    expect(screen.getByText("Local session")).toBeTruthy();

    api.listCachedSessions.mockResolvedValue([]);
    api.syncSessionCache.mockResolvedValue([
      {
        id: "remote-session",
        title: "Remote session",
        startedAt: Math.floor(Date.now() / 1000),
        source: "tui",
        messageCount: 2,
        model: "deepseek-v4-pro",
      },
    ]);

    await act(async () => {
      api.emitConnectionConfigChanged();
    });

    await waitFor(() => {
      expect(screen.getByText("Remote session")).toBeTruthy();
    });
    expect(screen.queryByText("Local session")).toBeNull();
  });

  it("renders sessions recovered by sync when the fast cache starts empty", async () => {
    vi.useRealTimers();
    const api = installHermesAPI();
    api.syncSessionCache.mockResolvedValue([
      {
        id: "recovered-session",
        title: "Recovered older conversation",
        startedAt: Math.floor(Date.now() / 1000),
        source: "desktop",
        messageCount: 4,
        model: "gpt-5.5",
      },
    ]);

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    await waitFor(() => {
      expect(screen.getByText("Recovered older conversation")).toBeTruthy();
    });
    expect(screen.queryByText("sessions.empty")).toBeNull();
  });

  it("ignores stale search results from earlier keystrokes", async () => {
    const api = installHermesAPI();
    let resolveBroadSearch:
      | ((value: ReturnType<typeof sessionSearchResult>[]) => void)
      | undefined;
    api.searchSessions.mockImplementation((query: string) => {
      if (query === "h") {
        return new Promise((resolve) => {
          resolveBroadSearch = resolve;
        });
      }
      if (query === "hello") {
        return Promise.resolve([
          sessionSearchResult("Hello match", "<<hello>>"),
        ]);
      }
      return Promise.resolve([]);
    });

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    const search = screen.getByPlaceholderText("sessions.searchPlaceholder");
    fireEvent.change(search, { target: { value: "h" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    fireEvent.change(search, { target: { value: "hello" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {});
    expect(screen.getByText("Hello match")).toBeTruthy();

    await act(async () => {
      resolveBroadSearch?.([
        sessionSearchResult("Broad h match", "<<hermes>>"),
      ]);
    });

    expect(screen.getByText("Hello match")).toBeTruthy();
    expect(screen.queryByText("Broad h match")).toBeNull();
  });

  it("uses matched text as the visible title for untitled search results", async () => {
    vi.useRealTimers();
    const api = installHermesAPI();
    api.searchSessions.mockResolvedValue([
      sessionSearchResult(
        null,
        "<<Live PR499>> smoke test. Reply exactly: OK",
        "session-722999",
      ),
    ]);

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    const search = screen.getByPlaceholderText("sessions.searchPlaceholder");
    fireEvent.change(search, { target: { value: "Live PR499" } });

    await waitFor(() => {
      expect(screen.getByText(/smoke test\. Reply exactly: OK/)).toBeTruthy();
    });
    expect(screen.queryByText("sessions.title 722999")).toBeNull();
  });

  it("does not repopulate search results after clearing the input", async () => {
    const api = installHermesAPI();
    let resolveSearch:
      | ((value: ReturnType<typeof sessionSearchResult>[]) => void)
      | undefined;
    api.searchSessions.mockReturnValue(
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
    );

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    const search = screen.getByPlaceholderText("sessions.searchPlaceholder");
    fireEvent.change(search, { target: { value: "hello" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    fireEvent.click(screen.getByRole("button", { name: "" }));

    await act(async () => {
      resolveSearch?.([sessionSearchResult("Late hello", "<<hello>>")]);
    });

    expect(search).toHaveProperty("value", "");
    expect(screen.queryByText("Late hello")).toBeNull();
    expect(screen.queryByText("sessions.empty")).toBeTruthy();
  });
});

describe("Sessions deletion safety", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => vi.useRealTimers());

  const row = {
    id: "delete-target",
    title: "Keep until deleted",
    startedAt: 200,
    source: "desktop",
    messageCount: 1,
    model: "test",
  };

  async function beginDelete(bulk: boolean): Promise<void> {
    if (bulk) {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.selectMode" }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.selectVisible" }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.deleteSelected" }),
      );
    } else {
      fireEvent.click(screen.getByRole("button", { name: "sessions.delete" }));
    }
    fireEvent.click(
      screen.getByRole("button", { name: "sessions.deleteConfirmAction" }),
    );
    await act(async () => {});
  }

  it.each([false, true])(
    "reconciles only confirmed bulk IDs and fences delayed snapshots (search=%s)",
    async (search) => {
      const failed = { ...row, id: "failed-target", title: "Failed target" };
      const rows = [row, failed];
      const results = rows.map((item) =>
        sessionSearchResult(item.title, "match", item.id),
      );
      const api = installHermesAPI(rows);
      api.searchSessions.mockResolvedValue(results);
      let finishDelete!: (value: unknown) => void;
      api.deleteSessions.mockReturnValueOnce(
        new Promise((resolve) => {
          finishDelete = resolve;
        }),
      );
      const onSessionDeleted = vi.fn();
      const changed = vi.fn();
      window.addEventListener("hermes-sessions-maybe-changed", changed);
      try {
        render(
          <Sessions
            {...baseProps}
            visible
            onSessionDeleted={onSessionDeleted}
            currentSessionId={row.id}
          />,
        );
        await act(async () => {});
        if (search) {
          fireEvent.change(
            screen.getByPlaceholderText("sessions.searchPlaceholder"),
            { target: { value: "match" } },
          );
          await act(async () => {
            vi.advanceTimersByTime(300);
          });
        }
        await beginDelete(true);
        let finishList!: (value: typeof rows) => void;
        api.syncSessionCache.mockReturnValueOnce(
          new Promise((resolve) => {
            finishList = resolve;
          }),
        );
        act(() => window.dispatchEvent(new Event("focus")));
        let finishSearch!: (value: typeof results) => void;
        if (search) {
          api.searchSessions.mockReturnValueOnce(
            new Promise((resolve) => {
              finishSearch = resolve;
            }),
          );
          fireEvent.change(
            screen.getByPlaceholderText("sessions.searchPlaceholder"),
            { target: { value: "match again" } },
          );
          await act(async () => {
            vi.advanceTimersByTime(300);
          });
        }
        await act(async () => {
          finishDelete({
            requested: 2,
            deleted: 1,
            deletedIds: [row.id],
            error: "409 conflict",
          });
        });
        expect(onSessionDeleted.mock.calls).toEqual([
          [row.id, baseProps.connectionId, baseProps.profile],
        ]);
        expect(toast.error).toHaveBeenCalledWith("409 conflict");
        expect(changed).toHaveBeenCalledTimes(1);
        await act(async () => {
          finishList(rows);
          if (search) finishSearch(results);
        });
        // A fresh search should see the backend's surviving row only.
        api.searchSessions.mockResolvedValue([results[1]]);
        await act(async () => {
          vi.advanceTimersByTime(300);
        });
        expect(screen.queryByText(row.title)).not.toBeInTheDocument();
        expect(screen.getByText(failed.title)).toBeInTheDocument();
        expect(
          screen.getByRole("checkbox", { name: "sessions.selectSession" }),
        ).toBeChecked();
      } finally {
        window.removeEventListener("hermes-sessions-maybe-changed", changed);
      }
    },
  );

  it.each([
    [false, "debounce"],
    [true, "debounce"],
    [false, "sync"],
    [true, "sync"],
    [false, "search"],
    [true, "search"],
  ] as const)(
    "reissues the current query after confirmed deletion (bulk=%s stage=%s)",
    async (bulk, stage) => {
      const api = installHermesAPI([row]);
      let finishDelete!: (value: unknown) => void;
      (bulk ? api.deleteSessions : api.deleteSession).mockReturnValueOnce(
        new Promise((resolve) => {
          finishDelete = resolve;
        }),
      );
      render(<Sessions {...baseProps} visible />);
      await act(async () => {});
      await beginDelete(bulk);
      let finishSync!: (value: unknown[]) => void;
      let finishSearch!: (
        value: ReturnType<typeof sessionSearchResult>[],
      ) => void;
      if (stage === "sync")
        api.syncSessionCache.mockReturnValueOnce(
          new Promise((resolve) => {
            finishSync = resolve;
          }),
        );
      if (stage === "search")
        api.searchSessions.mockReturnValueOnce(
          new Promise((resolve) => {
            finishSearch = resolve;
          }),
        );
      fireEvent.change(
        screen.getByPlaceholderText("sessions.searchPlaceholder"),
        { target: { value: "new query" } },
      );
      if (stage !== "debounce")
        await act(async () => {
          vi.advanceTimersByTime(300);
        });
      await act(async () => {
        finishDelete({ requested: 1, deleted: 1, deletedIds: [row.id] });
      });
      const result = sessionSearchResult(
        "Current query result",
        "new query",
        "survivor",
      );
      api.searchSessions.mockResolvedValue([result]);
      await act(async () => {
        if (stage === "sync") finishSync([row]);
        if (stage === "search")
          finishSearch([sessionSearchResult(row.title, "stale", row.id)]);
        vi.advanceTimersByTime(300);
      });
      expect(api.searchSessions).toHaveBeenLastCalledWith(
        "new query",
        undefined,
        baseProps.connectionId,
        baseProps.profile,
      );
      expect(screen.getByText(result.title!)).toBeInTheDocument();
      expect(screen.queryByText(row.title)).not.toBeInTheDocument();
    },
  );

  it.each([false, true])(
    "fences late list and search snapshots after deletion (bulk=%s)",
    async (bulk) => {
      const api = installHermesAPI([row]);
      render(<Sessions {...baseProps} visible />);
      await act(async () => {});
      let finishList!: (value: (typeof row)[]) => void;
      api.syncSessionCache.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishList = resolve;
          }),
      );
      act(() => window.dispatchEvent(new Event("focus")));
      api.searchSessions.mockResolvedValue([
        sessionSearchResult(row.title, "match", row.id),
      ]);
      fireEvent.change(
        screen.getByPlaceholderText("sessions.searchPlaceholder"),
        {
          target: { value: "match" },
        },
      );
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      if (bulk) {
        fireEvent.click(
          screen.getByRole("button", { name: "sessions.selectMode" }),
        );
        fireEvent.click(
          screen.getByRole("button", { name: "sessions.selectVisible" }),
        );
        fireEvent.click(
          screen.getByRole("button", { name: "sessions.deleteSelected" }),
        );
      } else {
        fireEvent.click(
          screen.getByRole("button", { name: "sessions.delete" }),
        );
      }
      let finishSearch!: (
        value: ReturnType<typeof sessionSearchResult>[],
      ) => void;
      api.searchSessions.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSearch = resolve;
          }),
      );
      fireEvent.change(
        screen.getByPlaceholderText("sessions.searchPlaceholder"),
        {
          target: { value: "match again" },
        },
      );
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "sessions.deleteConfirmAction" }),
        );
      });
      expect(screen.queryByText(row.title)).toBeNull();
      await act(async () => {
        finishList([row]);
        finishSearch([sessionSearchResult(row.title, "match", row.id)]);
      });
      expect(screen.queryByText(row.title)).toBeNull();
    },
  );

  it.each([
    [false, "profile", false],
    [false, "profile", true],
    [true, "profile", false],
    [true, "profile", true],
    [false, "connectionId", false],
    [false, "connectionId", true],
    [true, "connectionId", false],
    [true, "connectionId", true],
  ] as const)(
    "reports scoped success but ignores stale UI completion (bulk=%s scope=%s failure=%s)",
    async (bulk, scope, failure) => {
      const api = installHermesAPI([row]);
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      (bulk ? api.deleteSessions : api.deleteSession).mockReturnValue(
        new Promise<void>((done, fail) => {
          resolve = done;
          reject = fail;
        }),
      );
      const onSessionDeleted = vi.fn();
      const changed = vi.fn();
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      window.addEventListener("hermes-sessions-maybe-changed", changed);
      try {
        const view = render(
          <Sessions
            {...baseProps}
            onSessionDeleted={onSessionDeleted}
            visible={true}
          />,
        );
        await act(async () => {});
        await beginDelete(bulk);
        const newRow = { ...row, title: "New scope chat with same id" };
        api.syncSessionCache.mockResolvedValue([newRow]);
        await act(async () => {
          view.rerender(
            <Sessions
              {...baseProps}
              {...{ [scope]: "other" }}
              onSessionDeleted={onSessionDeleted}
              visible={true}
            />,
          );
        });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        fireEvent.click(
          screen.getByRole("button", { name: "sessions.delete" }),
        );
        await act(async () => {
          if (failure) reject(new Error("Old scope error"));
          else resolve();
        });
        expect(screen.getByText(newRow.title)).toBeInTheDocument();
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(onSessionDeleted.mock.calls).toEqual(
          failure ? [] : [[row.id, baseProps.connectionId, baseProps.profile]],
        );
        expect(changed).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
        window.removeEventListener("hermes-sessions-maybe-changed", changed);
      }
    },
  );

  it.each([false, true])(
    "reports late scoped success after the deleting modal unmounts (bulk=%s)",
    async (bulk) => {
      const api = installHermesAPI([row]);
      let resolve!: () => void;
      (bulk ? api.deleteSessions : api.deleteSession).mockReturnValueOnce(
        new Promise<void>((done) => {
          resolve = done;
        }),
      );
      const onSessionDeleted = vi.fn();
      const old = render(
        <Sessions {...baseProps} visible onSessionDeleted={onSessionDeleted} />,
      );
      await act(async () => {});
      await beginDelete(bulk);
      old.unmount();
      const newRow = { ...row, title: "New mounted scope chat" };
      api.listCachedSessions.mockResolvedValue([newRow]);
      api.syncSessionCache.mockResolvedValue([newRow]);
      render(
        <Sessions
          {...baseProps}
          connectionId="other"
          visible
          onSessionDeleted={onSessionDeleted}
        />,
      );
      await act(async () => {});
      const changed = vi.fn();
      window.addEventListener("hermes-sessions-maybe-changed", changed);
      try {
        await act(async () => {
          resolve();
        });
        expect(onSessionDeleted.mock.calls).toEqual([
          [row.id, baseProps.connectionId, baseProps.profile],
        ]);
        expect(screen.getByText(newRow.title)).toBeInTheDocument();
        expect(changed).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener("hermes-sessions-maybe-changed", changed);
      }
    },
  );

  it.each([false, true])(
    "notifies Layout only after backend success (bulk=%s)",
    async (bulk) => {
      const second = { ...row, id: "second-target", title: "Second target" };
      const api = installHermesAPI(bulk ? [row, second] : [row]);
      let resolve!: () => void;
      (bulk ? api.deleteSessions : api.deleteSession).mockReturnValue(
        new Promise<void>((done) => {
          resolve = done;
        }),
      );
      const onSessionDeleted = vi.fn();
      const changed = vi.fn();
      window.addEventListener("hermes-sessions-maybe-changed", changed);
      try {
        render(
          <Sessions
            {...baseProps}
            onSessionDeleted={onSessionDeleted}
            visible={true}
          />,
        );
        await act(async () => {});
        await beginDelete(bulk);
        expect(onSessionDeleted).not.toHaveBeenCalled();
        expect(changed).not.toHaveBeenCalled();
        await act(async () => {
          resolve();
        });
        expect(screen.queryByText(row.title)).not.toBeInTheDocument();
        expect(onSessionDeleted.mock.calls).toEqual(
          (bulk ? [row.id, second.id] : [row.id]).map((id) => [
            id,
            baseProps.connectionId,
            baseProps.profile,
          ]),
        );
        expect(changed).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      } finally {
        window.removeEventListener("hermes-sessions-maybe-changed", changed);
      }
    },
  );

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "preserves rows while pending and after failure (bulk=%s search=%s)",
    async (bulk, search) => {
      const api = installHermesAPI([row]);
      api.searchSessions.mockResolvedValue([
        sessionSearchResult(row.title, "match", row.id),
      ]);
      let reject!: (error: Error) => void;
      (bulk ? api.deleteSessions : api.deleteSession).mockReturnValue(
        new Promise((_, fail) => {
          reject = fail;
        }),
      );
      const onSessionDeleted = vi.fn();
      const changed = vi.fn();
      window.addEventListener("hermes-sessions-maybe-changed", changed);
      render(
        <Sessions
          {...baseProps}
          onSessionDeleted={onSessionDeleted}
          visible={true}
        />,
      );
      await act(async () => {});
      if (search) {
        fireEvent.change(
          screen.getByPlaceholderText("sessions.searchPlaceholder"),
          { target: { value: "match" } },
        );
        await act(async () => {
          vi.advanceTimersByTime(300);
        });
      }
      await beginDelete(bulk);
      expect(screen.getByText(row.title)).toBeInTheDocument();
      const syncCount = api.syncSessionCache.mock.calls.length;
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await act(async () => {
          reject(new Error("Server refused deletion"));
        });
        expect(screen.getByText(row.title)).toBeInTheDocument();
        expect(toast.error).toHaveBeenCalledWith("Server refused deletion");
        expect(api.syncSessionCache).toHaveBeenCalledTimes(syncCount);
        expect(onSessionDeleted).not.toHaveBeenCalled();
        expect(changed).not.toHaveBeenCalled();
        if (search)
          expect(
            screen.getByPlaceholderText("sessions.searchPlaceholder"),
          ).toHaveValue("match");
      } finally {
        errors.mockRestore();
        window.removeEventListener("hermes-sessions-maybe-changed", changed);
      }
    },
  );
});

describe("Sessions tab — delete affordance (#408)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("does not resurrect a confirmed deletion from a delayed focus refresh", async () => {
    const rows = [
      {
        id: "sessions-delete-race",
        title: "Deleted during refresh",
        startedAt: Date.now() / 1000,
        source: "desktop",
        messageCount: 1,
        model: "test",
      },
    ];
    const api = installHermesAPI(rows);
    render(<Sessions {...baseProps} visible />);
    await act(async () => {});
    let finish!: (value: typeof rows) => void;
    api.syncSessionCache.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => window.dispatchEvent(new Event("focus")));
    expect(finish).toBeTypeOf("function");
    fireEvent.click(screen.getByRole("button", { name: "sessions.delete" }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.deleteConfirmAction" }),
      );
    });
    expect(screen.queryByText(rows[0].title)).toBeNull();
    await act(async () => {
      finish(rows);
    });
    expect(screen.queryByText(rows[0].title)).toBeNull();
  });

  it("calls deleteSession when the trash button is clicked + confirmed", async () => {
    const sessions = [
      {
        id: "sess-abc-123",
        title: "First chat",
        startedAt: Math.floor(Date.now() / 1000),
        source: "api_server",
        messageCount: 3,
        model: "gpt-4",
      },
    ];
    const api = installHermesAPI(sessions);

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    const deleteBtn = screen.getByRole("button", {
      name: "sessions.delete",
    });
    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "sessions.deleteConfirm",
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "sessions.deleteConfirmAction",
        }),
      );
    });

    expect(api.deleteSession).toHaveBeenCalledWith(
      "sess-abc-123",
      "connection-one",
      "work",
    );
  });

  it("does NOT call deleteSession when the confirm is cancelled", async () => {
    const sessions = [
      {
        id: "sess-abc-123",
        title: "First chat",
        startedAt: Math.floor(Date.now() / 1000),
        source: "api_server",
        messageCount: 3,
        model: "gpt-4",
      },
    ];
    const api = installHermesAPI(sessions);

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    const deleteBtn = screen.getByRole("button", {
      name: "sessions.delete",
    });
    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.deleteCancel" }),
      );
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.deleteSession).not.toHaveBeenCalled();
  });

  it("stops click propagation so the card's resume handler doesn't fire", async () => {
    // Regression: the trash button is nested inside a clickable card.
    // Clicking trash must NOT also resume the session (would open the chat
    // the user is trying to delete).
    const sessions = [
      {
        id: "sess-abc-123",
        title: "First chat",
        startedAt: Math.floor(Date.now() / 1000),
        source: "api_server",
        messageCount: 3,
        model: "gpt-4",
      },
    ];
    installHermesAPI(sessions);
    const onResume = vi.fn();

    render(
      <Sessions {...baseProps} onResumeSession={onResume} visible={true} />,
    );
    await act(async () => {});

    const deleteBtn = screen.getByRole("button", {
      name: "sessions.delete",
    });
    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    expect(onResume).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("Sessions tab — bulk delete selection (#490)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes the selected sessions after confirmation", async () => {
    const sessions = [
      {
        id: "sess-one",
        title: "First chat",
        startedAt: Math.floor(Date.now() / 1000),
        source: "api_server",
        messageCount: 3,
        model: "gpt-4",
      },
      {
        id: "sess-two",
        title: "Second chat",
        startedAt: Math.floor(Date.now() / 1000),
        source: "api_server",
        messageCount: 1,
        model: "gpt-4",
      },
      {
        id: "sess-three",
        title: "Third chat",
        startedAt: Math.floor(Date.now() / 1000),
        source: "api_server",
        messageCount: 2,
        model: "gpt-4",
      },
    ];
    const api = installHermesAPI(sessions);

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.selectMode" }),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByText("First chat"));
      fireEvent.click(screen.getByText("Second chat"));
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.deleteSelected" }),
      );
    });

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "sessions.deleteSelectedConfirm",
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "sessions.deleteConfirmAction",
        }),
      );
    });

    await waitFor(() => {
      expect(api.deleteSessions).toHaveBeenCalledWith(
        ["sess-one", "sess-two"],
        "connection-one",
        "work",
      );
    });
    expect(api.deleteSession).not.toHaveBeenCalled();
  });

  it("selects only visible search results", async () => {
    const api = installHermesAPI([
      {
        id: "main-session",
        title: "Main chat",
        startedAt: Math.floor(Date.now() / 1000),
        source: "api_server",
        messageCount: 1,
        model: "gpt-4",
      },
    ]);
    api.searchSessions.mockResolvedValue([
      sessionSearchResult("Search one", "<<bulk>> one"),
      sessionSearchResult("Search two", "<<bulk>> two"),
    ]);

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    const search = screen.getByPlaceholderText("sessions.searchPlaceholder");
    fireEvent.change(search, { target: { value: "bulk" } });
    await waitFor(() => {
      expect(screen.getByText("Search one")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.selectMode" }),
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.selectVisible" }),
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.deleteSelected" }),
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "sessions.deleteConfirmAction",
        }),
      );
    });

    await waitFor(() => {
      expect(api.deleteSessions).toHaveBeenCalledWith(
        ["search-one", "search-two"],
        "connection-one",
        "work",
      );
    });
    expect(api.deleteSessions).not.toHaveBeenCalledWith(["main-session"]);
  });

  it("does not delete selected sessions when the bulk confirm is cancelled", async () => {
    const sessions = [
      {
        id: "sess-one",
        title: "First chat",
        startedAt: Math.floor(Date.now() / 1000),
        source: "api_server",
        messageCount: 3,
        model: "gpt-4",
      },
    ];
    const api = installHermesAPI(sessions);

    render(<Sessions {...baseProps} visible={true} />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.selectMode" }),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByText("First chat"));
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.deleteSelected" }),
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "sessions.deleteCancel" }),
      );
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.deleteSessions).not.toHaveBeenCalled();
  });
});
