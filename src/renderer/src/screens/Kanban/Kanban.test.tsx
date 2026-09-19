import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/useI18n", () => {
  // Stable identity: the screens' load callbacks depend on `t`, so a fresh
  // `t` per render would retrigger their mount effects in a loop.
  const t = (key: string): string => key;
  return {
    useI18n: () => ({ t, locale: "en", setLocale: () => {} }),
  };
});

import Kanban from "./Kanban";

interface Conn {
  connectionId: string;
  mode: "local" | "remote" | "ssh";
  remoteUrl: string;
}

interface TasksRes {
  success: boolean;
  data?: unknown[];
  error?: string;
}

// Kanban boards/tasks are per-connection data (local kanban.db vs the remote
// dashboard plugin / SSH CLI). A local/remote switch must reload the board
// (issue #105); a same-connection event must not.
function installHermesAPI(): {
  kanbanListBoards: ReturnType<typeof vi.fn>;
  emitConnectionConfigChanged: (conn: Conn) => void;
} {
  let onConnectionChanged: ((conn: Conn) => void) | null = null;
  const boards = [{ slug: "default", name: "Default", is_current: true }];
  const kanbanListBoards = vi.fn(
    async (): Promise<TasksRes> => ({
      success: true,
      data: boards,
    }),
  );
  const api = {
    kanbanListBoards,
    kanbanListTasks: vi.fn(
      async (): Promise<TasksRes> => ({
        success: true,
        data: [],
      }),
    ),
    kanbanListClaw3dHqTasks: vi.fn(
      async (): Promise<TasksRes> => ({
        success: false,
      }),
    ),
    listProfiles: vi.fn(async () => [{ id: "work", name: "Work" }]),
    getConnectionConfig: vi.fn(async () => ({
      connectionId: "local-main",
      mode: "local",
      remoteUrl: "",
    })),
    onConnectionConfigChanged: vi.fn((callback: (c: Conn) => void) => {
      onConnectionChanged = callback;
      return () => {
        onConnectionChanged = null;
      };
    }),
  };
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: api,
  });
  return {
    kanbanListBoards,
    emitConnectionConfigChanged: (conn: Conn) => onConnectionChanged?.(conn),
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("Kanban connection-switch reload (#105)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("reloads boards when the connection changes", async () => {
    const { kanbanListBoards, emitConnectionConfigChanged } =
      installHermesAPI();
    render(<Kanban profile="work" visible />);
    await waitFor(() =>
      expect(kanbanListBoards.mock.calls.length).toBeGreaterThanOrEqual(1),
    );
    const before = kanbanListBoards.mock.calls.length;

    await act(async () => {
      emitConnectionConfigChanged({
        connectionId: "remote-a",
        mode: "remote",
        remoteUrl: "http://10.255.0.10:9119",
      });
    });
    await waitFor(() =>
      expect(kanbanListBoards.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it("does not reload when the same connection re-activates", async () => {
    const { kanbanListBoards, emitConnectionConfigChanged } =
      installHermesAPI();
    render(<Kanban profile="work" visible />);
    await flush();
    await waitFor(() =>
      expect(kanbanListBoards.mock.calls.length).toBeGreaterThanOrEqual(1),
    );
    const before = kanbanListBoards.mock.calls.length;

    await act(async () => {
      emitConnectionConfigChanged({
        connectionId: "local-main",
        mode: "local",
        remoteUrl: "",
      });
    });
    await flush();
    expect(kanbanListBoards.mock.calls.length).toBe(before);
  });
});
