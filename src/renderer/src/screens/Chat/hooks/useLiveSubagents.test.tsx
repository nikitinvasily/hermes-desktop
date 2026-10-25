import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasLiveSubagents,
  useLiveSubagents,
  type LiveSubagentSnapshot,
} from "./useLiveSubagents";
import { waitingSubagentSessionIds, type ChatRun } from "../../Layout/chatRuns";

afterEach(() => vi.useRealTimers());

const live = { subagents: [{ status: "running" }] };
const empty = { subagents: [] };

describe("live subagent waiting state", () => {
  it("uses explicit runtime status, not missing end timestamps or unknown states", () => {
    expect(hasLiveSubagents(live)).toBe(true);
    expect(hasLiveSubagents({ subagents: [{ status: "starting" }] })).toBe(
      true,
    );
    for (const status of [
      "completed",
      "failed",
      "interrupted",
      "died",
      undefined,
    ]) {
      expect(hasLiveSubagents({ subagents: [{ status }] })).toBe(false);
    }
  });

  it("polls after the parent is idle and clears only when the last child finishes", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async (): Promise<LiveSubagentSnapshot> => live);
    const { result } = renderHook(() => useLiveSubagents("parent", true, read));
    await act(async () => {});
    expect(result.current).toBe(true);
    read.mockResolvedValue({
      subagents: [{ status: "completed" }, { status: "running" }],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current).toBe(true);
    read.mockResolvedValue(empty);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current).toBe(false);
  });

  it("clears on error, retries, and restores the new scope without accepting stale responses", async () => {
    vi.useFakeTimers();
    let finishOld!: (snapshot: LiveSubagentSnapshot) => void;
    const read = vi.fn(
      (): Promise<LiveSubagentSnapshot> =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    const { result, rerender, unmount } = renderHook(
      ({ scope, enabled }) => useLiveSubagents(scope, enabled, read),
      {
        initialProps: { scope: "connection-a|default|stored-a", enabled: true },
      },
    );
    read.mockResolvedValue(empty);
    rerender({ scope: "connection-b|other|stored-b", enabled: true });
    await act(async () => {
      finishOld(live);
    });
    expect(result.current).toBe(false);
    read.mockResolvedValue(live);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current).toBe(true);
    read.mockRejectedValue(new Error("disconnected"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current).toBe(false);
    read.mockResolvedValue(live);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current).toBe(true);
    rerender({ scope: "connection-b|other|stored-b", enabled: false });
    expect(result.current).toBe(false);
    const calls = read.mock.calls.length;
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(read).toHaveBeenCalledTimes(calls);
  });

  it("does not overlap requests or restart polling when the callback identity changes", async () => {
    vi.useFakeTimers();
    let finish!: (snapshot: LiveSubagentSnapshot) => void;
    const read = vi.fn(
      (): Promise<LiveSubagentSnapshot> =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = renderHook(() =>
      useLiveSubagents("same", true, () => read()),
    );
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(empty);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("aggregates idle parents only for the selected connection and profile", () => {
    const parent: ChatRun = {
      runId: "r",
      connectionId: "a",
      profile: "default",
      sessionId: "stored",
      loading: false,
      hasActiveSubagents: true,
    };
    expect([...waitingSubagentSessionIds([parent], "a", "default")]).toEqual([
      "stored",
    ]);
    for (const patch of [
      { loading: true },
      { connectionId: "b" },
      { profile: "other" },
      { hasActiveSubagents: false },
      { sessionId: null },
    ]) {
      expect(
        waitingSubagentSessionIds([{ ...parent, ...patch }], "a", "default")
          .size,
      ).toBe(0);
    }
  });
});
