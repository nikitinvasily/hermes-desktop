import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
  const connectionListeners = new Set<(conn: Conn) => void>();
  const listCronJobs = vi.fn(async (): Promise<unknown[]> => jobs);
  let connection: Conn = {
    connectionId: "local-main",
    mode: "local",
    remoteUrl: "",
  };
  const api = {
    listCronJobs,
    getProfileEditorTarget: vi.fn(
      async (profile: string, connectionId?: string) => ({
        connectionId: connectionId || connection.connectionId,
        profile,
        mode: connection.mode,
        scopeToken: JSON.stringify([
          connectionId || connection.connectionId,
          profile,
          connection.mode,
          connection.remoteUrl,
        ]),
      }),
    ),
    getConnectionConfig: vi.fn(async () => ({
      connectionId: "local-main",
      mode: "local",
      remoteUrl: "",
    })),
    onConnectionConfigChanged: vi.fn((callback: (c: Conn) => void) => {
      connectionListeners.add(callback);
      return () => {
        connectionListeners.delete(callback);
      };
    }),
  };
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: api,
  });
  return {
    listCronJobs,
    emitConnectionConfigChanged: (conn: Conn) => {
      connection = conn;
      connectionListeners.forEach((listener) => listener(conn));
    },
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

  it.each(["profile", "connection"])(
    "removes the old jobs and expanded history while the next %s list is pending",
    async (scope) => {
      const { listCronJobs, emitConnectionConfigChanged } = installHermesAPI([
        cronJob("job-1", "Old job"),
      ]);
      const api = window.hermesAPI as unknown as Record<string, unknown>;
      api.listCronRuns = vi.fn(async () => ({ success: true, runs: [] }));
      const { rerender } = render(<Schedules profile="work" />);
      await screen.findByText("Old job");
      fireEvent.click(
        screen.getByRole("button", { name: "schedules.history" }),
      );
      await screen.findByText("schedules.historyEmpty");
      let resolve!: (jobs: Record<string, unknown>[]) => void;
      listCronJobs.mockImplementationOnce(
        () =>
          new Promise((yes) => {
            resolve = yes;
          }),
      );
      if (scope === "profile") rerender(<Schedules profile="home" />);
      else
        act(() => {
          emitConnectionConfigChanged({
            connectionId: "remote",
            mode: "remote",
            remoteUrl: "http://example.invalid",
          });
        });
      const oldJob = screen.queryByText("Old job");
      if (oldJob) expect(oldJob).not.toBeVisible();
      await flush();
      expect(screen.queryByText("schedules.historyEmpty")).toBeNull();
      await act(async () => {
        resolve([cronJob("job-1", "New job")]);
      });
      await screen.findByText("New job");
      expect(screen.queryByText("schedules.historyEmpty")).toBeNull();
      expect(
        screen.getByRole("button", { name: "schedules.history" }),
      ).toHaveAttribute("aria-expanded", "false");
    },
  );

  it.each(["profile", "connection", "refresh"])(
    "rejects stale job-list replies across %s changes",
    async (scope) => {
      const { listCronJobs, emitConnectionConfigChanged } = installHermesAPI(
        [],
      );
      let oldResolve!: (jobs: Record<string, unknown>[]) => void;
      let newResolve!: (jobs: Record<string, unknown>[]) => void;
      listCronJobs.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            oldResolve = resolve;
          }),
      );
      const { rerender } = render(<Schedules profile="work" />);
      await flush();
      listCronJobs.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            newResolve = resolve;
          }),
      );
      if (scope === "profile") rerender(<Schedules profile="home" />);
      else if (scope === "connection")
        act(() => {
          emitConnectionConfigChanged({
            connectionId: "remote",
            mode: "remote",
            remoteUrl: "http://example.invalid",
          });
        });
      else {
        // Finish the initial load, then race two explicit refresh requests.
        await act(async () => {
          oldResolve([cronJob("initial", "Initial job")]);
        });
        fireEvent.click(
          screen.getByRole("button", { name: "schedules.refresh" }),
        );
        await flush();
        const firstRefreshResolve = newResolve;
        listCronJobs.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              newResolve = resolve;
            }),
        );
        fireEvent.click(
          screen.getByRole("button", { name: "schedules.refresh" }),
        );
        oldResolve = firstRefreshResolve;
      }
      await flush();
      await act(async () => {
        newResolve([cronJob("fresh", "Fresh job")]);
      });
      await screen.findByText("Fresh job");
      await act(async () => {
        oldResolve([cronJob("old", "Stale job")]);
      });
      expect(screen.queryByText("Stale job")).toBeNull();
      expect(screen.getByText("Fresh job")).toBeTruthy();
    },
  );

  it.each(["list", "create", "trigger", "pause", "remove"])(
    "rejects pending old-principal %s completions without followup reads or mutation state leaking into the next target",
    async (stage) => {
      const { listCronJobs, emitConnectionConfigChanged } = installHermesAPI([
        cronJob("job-1", "Old principal job"),
      ]);
      const api = window.hermesAPI;
      let finishOld!: () => void;
      const mutation = vi.fn(
        () =>
          new Promise<{ success: boolean }>((resolve) => {
            finishOld = () => resolve({ success: true });
          }),
      );
      Object.assign(api, {
        createCronJob: mutation,
        triggerCronJob: mutation,
        pauseCronJob: mutation,
        removeCronJob: mutation,
      });
      const { container } = render(
        <Schedules profile="work" connectionId="local-main" />,
      );
      await screen.findByText("Old principal job");
      const initialLists = listCronJobs.mock.calls.length;
      if (stage === "list") {
        listCronJobs.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishOld = () => resolve([cronJob("old", "Stale list job")]);
            }),
        );
        fireEvent.click(
          screen.getByRole("button", { name: "schedules.refresh" }),
        );
      } else if (stage === "create") {
        fireEvent.click(
          screen.getByRole("button", { name: "schedules.newTask" }),
        );
        fireEvent.change(
          screen.getByPlaceholderText("schedules.namePlaceholder"),
          { target: { value: "Private draft" } },
        );
        fireEvent.click(
          screen.getByRole("button", { name: "schedules.create" }),
        );
      } else {
        const tooltip =
          stage === "trigger"
            ? "schedules.triggerNow"
            : stage === "pause"
              ? "schedules.pause"
              : "schedules.delete";
        fireEvent.click(
          container.querySelector(`[data-tooltip="${tooltip}"]`)!,
        );
        if (stage === "remove")
          fireEvent.click(
            screen.getByRole("button", { name: "schedules.delete" }),
          );
      }
      await flush();
      let finishNext!: () => void;
      listCronJobs.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNext = () => resolve([cronJob("job-1", "New principal job")]);
          }),
      );
      vi.mocked(api.getProfileEditorTarget).mockResolvedValueOnce({
        connectionId: "local-main",
        profile: "work",
        mode: "local",
        scopeToken: "new-private-auth-revision",
      });
      await act(async () =>
        emitConnectionConfigChanged({
          connectionId: "local-main",
          mode: "local",
          remoteUrl: "",
        }),
      );
      expect(screen.queryByText("Old principal job")).toBeNull();
      expect(
        screen.queryByPlaceholderText("schedules.namePlaceholder"),
      ).toBeNull();
      const listsBeforeCompletion = listCronJobs.mock.calls.length;
      expect(listsBeforeCompletion).toBe(
        initialLists + (stage === "list" ? 2 : 1),
      );
      await act(async () => finishOld());
      expect(listCronJobs).toHaveBeenCalledTimes(listsBeforeCompletion);
      expect(screen.queryByText("Stale list job")).toBeNull();
      await act(async () => finishNext());
      await screen.findByText("New principal job");
      expect(
        container.querySelector('[data-tooltip="schedules.pause"]'),
      ).not.toBeDisabled();
      fireEvent.click(
        screen.getByRole("button", { name: "schedules.newTask" }),
      );
      expect(
        screen.getByPlaceholderText("schedules.namePlaceholder"),
      ).toHaveValue("");
      expect(
        screen.getByRole("button", { name: "schedules.create" }),
      ).not.toBeDisabled();
    },
  );

  it("propagates top-level Refresh through mounted history and refetches the selected output after list membership is confirmed", async () => {
    installHermesAPI([cronJob("job-1", "Daily report")]);
    const api = window.hermesAPI;
    const run = {
      id: "run-1",
      preview: "First run",
      source: "session",
      started_at: null,
      ended_at: null,
      title: "Run",
      message_count: 1,
      input_tokens: 1,
      output_tokens: 1,
      is_active: false,
    };
    const list = vi.fn(async () => ({ success: true, runs: [run] }));
    const output = vi.fn(async () => ({
      success: true,
      output: "Initial output",
    }));
    Object.assign(api, { listCronRuns: list, getCronRunOutput: output });
    render(<Schedules profile="work" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "schedules.history" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /First run/ }));
    await screen.findByText("Initial output");
    let resolve!: (reply: { success: boolean; runs: (typeof run)[] }) => void;
    list.mockImplementationOnce(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    output.mockResolvedValueOnce({ success: true, output: "Refreshed output" });
    fireEvent.click(screen.getByRole("button", { name: "schedules.refresh" }));
    await flush();
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Initial output")).toBeNull();
    expect(output).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ success: true, runs: [run] }));
    await screen.findByText("Refreshed output");
    expect(output).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: /First run/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // A run removed by the refreshed list closes output and forgets selection,
    // even if a later refresh includes that run again.
    list.mockResolvedValueOnce({ success: true, runs: [] });
    fireEvent.click(screen.getByRole("button", { name: "schedules.refresh" }));
    await screen.findByText("schedules.historyEmpty");
    expect(
      screen.queryByRole("region", { name: "schedules.historyRunOutput" }),
    ).toBeNull();
    expect(output).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "schedules.refresh" }));
    const returnedRun = await screen.findByRole("button", {
      name: /First run/,
    });
    expect(returnedRun).toHaveAttribute("aria-expanded", "false");
    expect(output).toHaveBeenCalledTimes(2);
  });

  it("opens history only on demand and closes it on the job card", async () => {
    installHermesAPI([cronJob("job-1", "Daily report")]);
    const api = window.hermesAPI as unknown as Record<string, unknown>;
    const listCronRuns = vi.fn(async () => ({ success: true, runs: [] }));
    api.listCronRuns = listCronRuns;
    api.getProfileEditorTarget = vi.fn(async () => ({
      connectionId: "local-main",
      profile: "work",
      mode: "local",
      scopeToken: "scope-1",
    }));
    render(<Schedules profile="work" />);
    await screen.findByText("Daily report");
    expect(listCronRuns).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "schedules.history" }));
    await screen.findByText("schedules.historyEmpty");
    expect(listCronRuns).toHaveBeenCalledWith(
      "job-1",
      20,
      "work",
      expect.objectContaining({ scopeToken: "scope-1" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "schedules.historyClose" }),
    );
    expect(screen.queryByText("schedules.historyEmpty")).toBeNull();
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
