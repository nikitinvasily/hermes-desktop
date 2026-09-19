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

import Schedules from "./Schedules";

interface Conn {
  connectionId: string;
  mode: "local" | "remote" | "ssh";
  remoteUrl: string;
}

// Schedules reloads its per-connection cron list when the active connection
// switches (issue #86; shared hook since #105). Same-connection events must
// not refetch.
// Minimal CronJob shape: the render path reads job.deliver.length, so the
// fixture must carry the full field set.
function cronJob(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    schedule: "daily 09:00",
    state: "active",
    enabled: true,
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    last_error: null,
    repeat: null,
    deliver: ["local"],
    skills: [],
    script: null,
  };
}

function installHermesAPI(jobs: Record<string, unknown>[]): {
  listCronJobs: ReturnType<typeof vi.fn>;
  emitConnectionConfigChanged: (conn: Conn) => void;
} {
  let onConnectionChanged: ((conn: Conn) => void) | null = null;
  const listCronJobs = vi.fn(async (): Promise<unknown[]> => jobs);
  const api = {
    listCronJobs,
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
    listCronJobs,
    emitConnectionConfigChanged: (conn: Conn) => onConnectionChanged?.(conn),
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("Schedules connection-switch reload (#86/#105)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("refetches cron jobs when the connection changes", async () => {
    const { listCronJobs, emitConnectionConfigChanged } = installHermesAPI([
      cronJob("job-1", "Daily report"),
    ]);
    render(<Schedules profile="work" />);
    await waitFor(() =>
      expect(listCronJobs.mock.calls.length).toBeGreaterThanOrEqual(1),
    );
    const callsBefore = listCronJobs.mock.calls.length;

    await act(async () => {
      emitConnectionConfigChanged({
        connectionId: "remote-a",
        mode: "remote",
        remoteUrl: "http://10.255.0.10:9119",
      });
    });
    await waitFor(() =>
      expect(listCronJobs.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it("does not refetch when the same connection re-activates", async () => {
    const { listCronJobs, emitConnectionConfigChanged } = installHermesAPI([]);
    render(<Schedules profile="work" />);
    await flush();
    await waitFor(() =>
      expect(listCronJobs.mock.calls.length).toBeGreaterThanOrEqual(1),
    );
    const callsBefore = listCronJobs.mock.calls.length;

    await act(async () => {
      emitConnectionConfigChanged({
        connectionId: "local-main",
        mode: "local",
        remoteUrl: "",
      });
    });
    await flush();
    expect(listCronJobs.mock.calls.length).toBe(callsBefore);
  });
});
