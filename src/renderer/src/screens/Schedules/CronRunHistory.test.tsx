import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mocked } from "vitest";
import { Profiler, StrictMode } from "react";
import { CronRunHistory } from "./CronRunHistory";
import english from "../../../../shared/i18n/locales/en/schedules";

vi.mock("../../components/useI18n", () => {
  const t = (key: string): string => key;
  return { useI18n: () => ({ t }) };
});

type HistoryAPI = Pick<
  typeof window.hermesAPI,
  "getProfileEditorTarget" | "listCronRuns" | "getCronRunOutput"
>;
type Target = Awaited<ReturnType<HistoryAPI["getProfileEditorTarget"]>>;
type RunsReply = Awaited<ReturnType<HistoryAPI["listCronRuns"]>>;
type OutputReply = Awaited<ReturnType<HistoryAPI["getCronRunOutput"]>>;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const target: Target = {
  connectionId: "local",
  profile: "work",
  mode: "local",
  scopeToken: "scope-a",
};
function run(id: string): RunsReply["runs"][number] {
  return {
    id,
    source: "session",
    started_at: 1720000000,
    ended_at: null,
    title: id,
    preview: `${id}-preview`,
    message_count: 2,
    input_tokens: 10,
    output_tokens: 20,
    is_active: false,
  };
}
function apiFixture(): { api: Mocked<HistoryAPI>; emit: () => void } {
  const listeners = new Set<() => void>();
  const api = {
    getProfileEditorTarget: vi.fn<HistoryAPI["getProfileEditorTarget"]>(
      async () => target,
    ),
    listCronRuns: vi.fn<HistoryAPI["listCronRuns"]>(
      async (): Promise<RunsReply> => ({
        success: true,
        runs: [run("run-1"), run("run-2")],
      }),
    ),
    getCronRunOutput: vi.fn<HistoryAPI["getCronRunOutput"]>(
      async (): Promise<OutputReply> => ({
        success: true,
        output: "Run output",
        partial: true,
        truncated: true,
      }),
    ),
    onConnectionConfigChanged: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: api,
  });
  return { api, emit: () => listeners.forEach((listener) => listener()) };
}
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("Cron run history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it("supports StrictMode effect replay without leaving target capture stuck", async () => {
    apiFixture();
    render(
      <StrictMode>
        <CronRunHistory jobId="job-1" profile="work" />
      </StrictMode>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /run-1-preview/ }),
    );
    await screen.findByText("Run output");
  });

  it.each(["job", "profile", "connection"])(
    "rejects an old list after %s changes",
    async (scope) => {
      const { api } = apiFixture();
      const list = deferred<Awaited<ReturnType<typeof api.listCronRuns>>>();
      api.listCronRuns.mockImplementationOnce(() => list.promise);
      const { rerender } = render(
        <CronRunHistory jobId="job-1" profile="work" connectionId="local" />,
      );
      await flush();
      api.listCronRuns.mockResolvedValueOnce({
        success: true,
        runs: [run("new")],
      });
      rerender(
        <CronRunHistory
          jobId={scope === "job" ? "job-2" : "job-1"}
          profile={scope === "profile" ? "home" : "work"}
          connectionId={scope === "connection" ? "remote" : "local"}
        />,
      );
      await screen.findByText("new-preview");
      await act(async () => {
        list.resolve({ success: true, runs: [run("old")] });
      });
      expect(screen.queryByText("old-preview")).toBeNull();
      expect(screen.getByText("new-preview")).toBeTruthy();
    },
  );

  it("does not start a list after a pending target capture is unmounted", async () => {
    const { api } = apiFixture();
    const capture = deferred<typeof target>();
    api.getProfileEditorTarget.mockImplementationOnce(() => capture.promise);
    const { unmount } = render(<CronRunHistory jobId="job-1" profile="work" />);
    unmount();
    await act(async () => {
      capture.resolve(target);
    });
    expect(api.listCronRuns).not.toHaveBeenCalled();
  });

  it("rejects a late output reply after another run has been selected", async () => {
    const { api } = apiFixture();
    const output = deferred<Awaited<ReturnType<typeof api.getCronRunOutput>>>();
    api.getCronRunOutput.mockImplementationOnce(() => output.promise);
    render(<CronRunHistory jobId="job-1" profile="work" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /run-1-preview/ }),
    );
    api.getCronRunOutput.mockResolvedValueOnce({
      success: true,
      output: "New output",
    });
    fireEvent.click(screen.getByRole("button", { name: /run-2-preview/ }));
    await screen.findByText("New output");
    await act(async () => {
      output.resolve({ success: true, output: "Old output" });
    });
    expect(screen.queryByText("Old output")).toBeNull();
    expect(screen.getByText("New output")).toBeTruthy();
  });

  it("refreshes the selected run output only after the refreshed list confirms it still exists", async () => {
    const { api } = apiFixture();
    render(<CronRunHistory jobId="job-1" profile="work" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /run-1-preview/ }),
    );
    await screen.findByText("Run output");
    const list = deferred<Awaited<ReturnType<typeof api.listCronRuns>>>();
    api.listCronRuns.mockImplementationOnce(() => list.promise);
    api.getCronRunOutput.mockResolvedValueOnce({
      success: true,
      output: "Refreshed output",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "schedules.historyRefresh" }),
    );
    await flush();
    expect(api.getCronRunOutput).toHaveBeenCalledTimes(1);
    await act(async () => {
      list.resolve({ success: true, runs: [run("run-1")] });
    });
    await screen.findByText("Refreshed output");
    expect(api.getCronRunOutput).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Run output")).toBeNull();
  });

  it("provides English copy for all history controls and states", () => {
    for (const key of [
      "history",
      "historyLoading",
      "historyEmpty",
      "historyUnsupported",
      "historyRunOutput",
      "historyOutputPartial",
      "historyOutputTruncated",
      "historyClose",
      "historyRefresh",
      "historyRunning",
      "historyLoadFailed",
      "historyOutputFailed",
    ]) {
      expect((english as Record<string, string>)[key], key).toEqual(
        expect.any(String),
      );
    }
  });

  it.each(["capture", "list", "output"])(
    "rejects pending %s replies after config invalidation",
    async (stage) => {
      const { api, emit } = apiFixture();
      const capture = deferred<typeof target>();
      const list = deferred<Awaited<ReturnType<typeof api.listCronRuns>>>();
      const output =
        deferred<Awaited<ReturnType<typeof api.getCronRunOutput>>>();
      if (stage === "capture")
        api.getProfileEditorTarget.mockImplementationOnce(
          () => capture.promise,
        );
      if (stage === "list")
        api.listCronRuns.mockImplementationOnce(() => list.promise);
      if (stage === "output")
        api.getCronRunOutput.mockImplementationOnce(() => output.promise);
      render(<CronRunHistory jobId="job-1" profile="work" />);
      await flush();
      if (stage === "output")
        fireEvent.click(
          await screen.findByRole("button", { name: /run-1-preview/ }),
        );
      api.getProfileEditorTarget.mockResolvedValueOnce({
        ...target,
        scopeToken: "scope-new",
      });
      api.listCronRuns.mockResolvedValueOnce({
        success: true,
        runs: [run("new")],
      });
      act(() => {
        emit();
      });
      await screen.findByText("new-preview");
      const calls = api.listCronRuns.mock.calls.length;
      await act(async () => {
        capture.resolve(target);
        list.resolve({ success: true, runs: [run("old")] });
        output.resolve({
          success: true,
          output: "Old output",
          partial: false,
          truncated: false,
        });
      });
      expect(screen.queryByText("old-preview")).toBeNull();
      expect(screen.queryByText("Old output")).toBeNull();
      expect(screen.getByText("new-preview")).toBeTruthy();
      expect(api.listCronRuns).toHaveBeenCalledTimes(calls);
    },
  );

  it.each(["list", "output"])(
    "does not revive pending %s after unmount and reopen",
    async (stage) => {
      const { api } = apiFixture();
      const list = deferred<Awaited<ReturnType<typeof api.listCronRuns>>>();
      const output =
        deferred<Awaited<ReturnType<typeof api.getCronRunOutput>>>();
      if (stage === "list")
        api.listCronRuns.mockImplementationOnce(() => list.promise);
      else api.getCronRunOutput.mockImplementationOnce(() => output.promise);
      const old = render(<CronRunHistory jobId="job-1" profile="work" />);
      await flush();
      if (stage === "output")
        fireEvent.click(
          await screen.findByRole("button", { name: /run-1-preview/ }),
        );
      old.unmount();
      api.listCronRuns.mockResolvedValueOnce({
        success: true,
        runs: [run("new")],
      });
      render(<CronRunHistory jobId="job-1" profile="work" />);
      await screen.findByText("new-preview");
      await act(async () => {
        list.resolve({ success: true, runs: [run("old")] });
        output.resolve({
          success: true,
          output: "Old output",
          partial: false,
          truncated: false,
        });
      });
      expect(screen.queryByText("old-preview")).toBeNull();
      expect(screen.queryByText("Old output")).toBeNull();
      expect(screen.getByText("new-preview")).toBeTruthy();
    },
  );

  it("renders human-readable run times and an accessible active-run indicator", async () => {
    const { api } = apiFixture();
    api.listCronRuns.mockResolvedValueOnce({
      success: true,
      runs: [{ ...run("active"), is_active: true }],
    });
    render(<CronRunHistory jobId="job-1" profile="work" />);
    await screen.findByText(
      new Date(1720000000000).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    );
    expect(screen.getByLabelText("schedules.historyRunning")).toBeTruthy();
    expect(screen.getByText("↑10 ↓20")).toBeTruthy();
  });

  it("never commits the previous run's output under a newly selected run", async () => {
    const { api } = apiFixture();
    const commits: string[] = [];
    render(
      <Profiler
        id="history"
        onRender={() => {
          commits.push(document.body.textContent || "");
        }}
      >
        <CronRunHistory jobId="job-1" profile="work" />
      </Profiler>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /run-1-preview/ }),
    );
    await screen.findByText("Run output");
    const nextOutput =
      deferred<Awaited<ReturnType<typeof api.getCronRunOutput>>>();
    api.getCronRunOutput.mockImplementationOnce(() => nextOutput.promise);
    commits.length = 0;
    fireEvent.click(screen.getByRole("button", { name: /run-2-preview/ }));
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.every((text) => !text.includes("Run output"))).toBe(true);
    await act(async () => {
      nextOutput.resolve({
        success: true,
        output: "Fresh output",
        partial: false,
        truncated: false,
      });
    });
    await screen.findByText("Fresh output");
  });

  it.each(["unsupported", "failure", "rejection"])(
    "shows output %s errors without leaving a loading placeholder",
    async (kind) => {
      const { api } = apiFixture();
      if (kind === "rejection")
        api.getCronRunOutput.mockRejectedValueOnce(new Error("Output failed"));
      else
        api.getCronRunOutput.mockResolvedValueOnce({
          success: false,
          output: "",
          error: "Output failed",
          unsupported: kind === "unsupported",
        } as Awaited<ReturnType<typeof api.getCronRunOutput>>);
      render(<CronRunHistory jobId="job-1" profile="work" />);
      fireEvent.click(
        await screen.findByRole("button", { name: /run-1-preview/ }),
      );
      await screen.findByText(
        kind === "unsupported"
          ? "schedules.historyUnsupported"
          : "Output failed",
      );
      expect(screen.queryByText("schedules.historyLoading")).toBeNull();
    },
  );

  it("refreshes history without retaining old rows or output while the new list is pending", async () => {
    const { api } = apiFixture();
    render(<CronRunHistory jobId="job-1" profile="work" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /run-1-preview/ }),
    );
    await screen.findByText("Run output");
    const next = deferred<{
      success: boolean;
      runs: ReturnType<typeof run>[];
    }>();
    api.listCronRuns.mockImplementationOnce(() => next.promise);
    fireEvent.click(
      screen.getByRole("button", { name: "schedules.historyRefresh" }),
    );
    expect(screen.queryByText("run-1-preview")).toBeNull();
    expect(screen.queryByText("Run output")).toBeNull();
    await act(async () => {
      next.resolve({ success: true, runs: [] });
    });
    await screen.findByText("schedules.historyEmpty");
    expect(api.listCronRuns).toHaveBeenCalledTimes(2);
  });

  it.each(["unsupported", "failure", "rejection", "capture"])(
    "shows %s failures instead of empty history",
    async (kind) => {
      const { api } = apiFixture();
      if (kind === "capture")
        api.getProfileEditorTarget.mockRejectedValueOnce(
          new Error("Target unavailable"),
        );
      else if (kind === "rejection")
        api.listCronRuns.mockRejectedValueOnce(new Error("Run list failed"));
      else
        api.listCronRuns.mockResolvedValueOnce({
          success: false,
          runs: [],
          error: "Run list failed",
          unsupported: kind === "unsupported",
        } as Awaited<ReturnType<typeof api.listCronRuns>>);
      render(<CronRunHistory jobId="job-1" profile="work" />);
      await screen.findByText(
        kind === "capture"
          ? "Target unavailable"
          : kind === "unsupported"
            ? /schedules.historyUnsupported/
            : "Run list failed",
      );
      expect(screen.queryByText("schedules.historyEmpty")).toBeNull();
      if (kind === "capture") expect(api.listCronRuns).not.toHaveBeenCalled();
    },
  );

  it("invalidates history on config/auth events even for the same connection and rejects late output", async () => {
    const { api, emit } = apiFixture();
    const oldOutput = deferred<{ success: boolean; output: string }>();
    api.getCronRunOutput.mockImplementationOnce(
      () => oldOutput.promise as ReturnType<typeof api.getCronRunOutput>,
    );
    render(
      <CronRunHistory jobId="job-1" profile="work" connectionId="local" />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /run-1-preview/ }),
    );
    const capture = deferred<typeof target>();
    api.getProfileEditorTarget.mockImplementationOnce(() => capture.promise);
    act(() => {
      emit();
    });
    expect(screen.queryByText("run-1-preview")).toBeNull();
    await act(async () => {
      oldOutput.resolve({ success: true, output: "Stale auth output" });
    });
    expect(screen.queryByText("Stale auth output")).toBeNull();
    api.listCronRuns.mockResolvedValueOnce({
      success: true,
      runs: [run("fresh")],
    });
    await act(async () => {
      capture.resolve({ ...target, scopeToken: "scope-b" });
    });
    await screen.findByText("fresh-preview");
    expect(api.listCronRuns).toHaveBeenLastCalledWith(
      "job-1",
      20,
      "work",
      expect.objectContaining({ scopeToken: "scope-b" }),
    );
  });

  it.each(["job", "profile", "connection"])(
    "hides previous history immediately when %s changes and rejects its pending output",
    async (scope) => {
      const { api } = apiFixture();
      const oldOutput = deferred<{ success: boolean; output: string }>();
      api.getCronRunOutput.mockImplementationOnce(
        () => oldOutput.promise as ReturnType<typeof api.getCronRunOutput>,
      );
      const { rerender } = render(
        <CronRunHistory jobId="job-1" profile="work" connectionId="local" />,
      );
      fireEvent.click(
        await screen.findByRole("button", { name: /run-1-preview/ }),
      );
      const nextList = deferred<{
        success: boolean;
        runs: ReturnType<typeof run>[];
      }>();
      api.listCronRuns.mockImplementationOnce(() => nextList.promise);
      rerender(
        <CronRunHistory
          jobId={scope === "job" ? "job-2" : "job-1"}
          profile={scope === "profile" ? "home" : "work"}
          connectionId={scope === "connection" ? "remote" : "local"}
        />,
      );
      expect(screen.queryByText("run-1-preview")).toBeNull();
      await act(async () => {
        oldOutput.resolve({ success: true, output: "Old secret" });
      });
      expect(screen.queryByText("Old secret")).toBeNull();
      await act(async () => {
        nextList.resolve({ success: true, runs: [run("fresh")] });
      });
      await screen.findByText("fresh-preview");
      expect(screen.queryByText("run-1-preview")).toBeNull();
    },
  );

  it("selects run output against the captured target and labels partial/truncated text", async () => {
    const { api } = apiFixture();
    render(
      <CronRunHistory jobId="job-1" profile="work" connectionId="local" />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /run-1-preview/ }),
    );
    await screen.findByText("Run output");
    expect(api.getProfileEditorTarget).toHaveBeenCalledWith("work", "local");
    expect(api.getCronRunOutput).toHaveBeenCalledWith(
      "job-1",
      "run-1",
      "work",
      target,
    );
    expect(screen.getByText("schedules.historyOutputPartial")).toBeTruthy();
    expect(screen.getByText("schedules.historyOutputTruncated")).toBeTruthy();
  });
});
