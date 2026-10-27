import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChatQueue } from "./useChatQueue";
import type { SubmissionOutcome } from "./useChatActions";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("chat queue stop barrier", () => {
  it("does not leak a rejected Stop promise through a simultaneous Send now click", async () => {
    const idle = deferred();
    const { result } = renderHook(() =>
      useChatQueue({
        isLoading: true,
        stop: () => idle.promise,
        send: async () => "accepted",
      }),
    );
    act(() => {
      result.current.enqueue("C");
    });
    let stopping!: Promise<unknown>;
    let sending!: Promise<void>;
    act(() => {
      stopping = result.current.stopCurrentTurn().catch(() => undefined);
      sending = result.current.sendNow(result.current.messages[0].id);
    });
    const outcome = sending.then(
      () => "resolved",
      () => "rejected",
    );
    await act(async () => {
      idle.reject(new Error("interrupt failed"));
      await stopping;
    });
    expect(await outcome).toBe("resolved");
    expect(result.current.messages).toHaveLength(1);
  });

  it("treats an unexpected submit rejection as uncertain and never blindly retries it", async () => {
    const send = vi.fn(async (): Promise<SubmissionOutcome> => {
      throw new Error("socket closed");
    });
    const { result } = renderHook(() =>
      useChatQueue({ isLoading: true, stop: async () => undefined, send }),
    );
    act(() => {
      result.current.enqueue("C");
    });
    const id = result.current.messages[0].id;
    await act(async () => {
      await result.current.sendNow(id);
    });
    expect(result.current.messages[0].uncertain).toBe(true);
    await act(async () => {
      await result.current.sendNow(id);
    });
    expect(send).toHaveBeenCalledOnce();
  });
  it("allows explicit retry after an unsupported force-send once the legacy turn finishes", async () => {
    const stop = vi.fn(async () => {
      throw new Error("Legacy idle cannot be confirmed");
    });
    const send = vi.fn(async (): Promise<SubmissionOutcome> => "accepted");
    const { result, rerender } = renderHook(
      ({ loading }) => useChatQueue({ isLoading: loading, stop, send }),
      { initialProps: { loading: true } },
    );
    act(() => {
      result.current.enqueue("B");
    });
    const id = result.current.messages[0].id;
    await act(async () => {
      await result.current.sendNow(id);
    });
    rerender({ loading: false });
    await act(async () => {
      await result.current.sendNow(id);
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("B", []);
    expect(result.current.messages).toEqual([]);
  });
  it("does not send a stopped selection onto a changed connection", async () => {
    const idle = deferred();
    const stop = vi.fn(() => idle.promise);
    const send = vi.fn(async (): Promise<SubmissionOutcome> => "accepted");
    const { result, rerender } = renderHook(
      ({ scope }) =>
        useChatQueue({
          scopeKey: scope,
          isLoading: true,
          stop,
          send,
        }),
      { initialProps: { scope: "connection-A" } },
    );
    act(() => {
      result.current.enqueue("C");
    });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.sendNow(result.current.messages[0].id);
    });
    rerender({ scope: "connection-B" });
    expect(stop).not.toHaveBeenCalled();
    await act(async () => {
      idle.resolve();
      await pending;
    });
    expect(stop).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.error).toContain("changed");
  });

  it("clears the queue without sending a pending selection after reset", async () => {
    const idle = deferred();
    const send = vi.fn(async (): Promise<SubmissionOutcome> => "accepted");
    const { result } = renderHook(() =>
      useChatQueue({ isLoading: true, stop: () => idle.promise, send }),
    );
    act(() => {
      result.current.enqueue("C");
    });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.sendNow(result.current.messages[0].id);
      result.current.clear();
    });
    await act(async () => {
      idle.resolve();
      await pending;
    });
    expect(send).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
  });
  it("drains FIFO only after an authoritative idle probe", async () => {
    const idle = deferred();
    const waitForIdle = vi.fn(() => idle.promise);
    const send = vi.fn(async (): Promise<SubmissionOutcome> => {
      markLoading();
      return "accepted";
    });
    const { result, rerender } = renderHook(
      ({ loading }) =>
        useChatQueue({
          isLoading: loading,
          stop: async () => undefined,
          waitForIdle,
          send,
        }),
      { initialProps: { loading: true } },
    );
    const markLoading = (): void => rerender({ loading: true });
    act(() => {
      result.current.enqueue("B");
      result.current.enqueue("D");
    });
    rerender({ loading: false });
    await waitFor(() => expect(waitForIdle).toHaveBeenCalledOnce());
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      idle.resolve();
    });
    expect(send).toHaveBeenCalledWith("B", []);
    expect(result.current.messages.map((m) => m.text)).toEqual(["D"]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps all items and pauses after interrupt rejection even when loading becomes false", async () => {
    const stop = vi.fn(async () => {
      throw new Error("interrupt rejected");
    });
    const send = vi.fn(async (): Promise<SubmissionOutcome> => "accepted");
    const { result, rerender } = renderHook(
      ({ loading }) => useChatQueue({ isLoading: loading, stop, send }),
      { initialProps: { loading: true } },
    );
    act(() => {
      result.current.enqueue("B");
      result.current.enqueue("C");
    });
    await act(async () => {
      await result.current.sendNow(result.current.messages[1].id);
    });
    rerender({ loading: false });
    expect(send).not.toHaveBeenCalled();
    expect(result.current.messages.map((m) => m.text)).toEqual(["B", "C"]);
    expect(result.current.error).toContain("interrupt rejected");
  });
  it.each(["rejected", "uncertain"] as const)(
    "retains attachments and pauses the queue after %s submit",
    async (outcome) => {
      const send = vi.fn(async (): Promise<SubmissionOutcome> => outcome);
      const { result, rerender } = renderHook(
        ({ loading }) =>
          useChatQueue({
            isLoading: loading,
            stop: async () => undefined,
            send,
          }),
        { initialProps: { loading: true } },
      );
      const attachments = [
        { name: "image.png", path: "/image.png", type: "image/png" },
      ] as unknown as Parameters<typeof result.current.enqueue>[1];
      act(() => {
        result.current.enqueue("B");
        result.current.enqueue("C", attachments);
      });
      const id = result.current.messages[1].id;
      await act(async () => {
        await result.current.sendNow(id);
      });
      rerender({ loading: false });
      expect(result.current.messages.map((m) => m.text)).toEqual(["B", "C"]);
      expect(result.current.messages[1].attachments).toEqual(attachments);
      expect(result.current.error).toContain(
        outcome === "uncertain" ? "Check" : "retry",
      );
      expect(send).toHaveBeenCalledTimes(1);
      if (outcome === "uncertain") {
        await act(async () => {
          await result.current.sendNow(id);
        });
        expect(send).toHaveBeenCalledTimes(1);
      }
    },
  );
  it("resumes FIFO when the selected turn completes before its submit ACK", async () => {
    const ack = deferred();
    const stop = vi.fn(async () => undefined);
    const waitForIdle = vi.fn(async () => undefined);
    const send = vi.fn(async (text: string): Promise<SubmissionOutcome> => {
      if (text === "C") await ack.promise;
      else markLoading();
      return "accepted";
    });
    const { result, rerender } = renderHook(
      ({ loading }) =>
        useChatQueue({ isLoading: loading, stop, waitForIdle, send }),
      { initialProps: { loading: true } },
    );
    const markLoading = (): void => rerender({ loading: true });
    act(() => {
      result.current.enqueue("B");
      result.current.enqueue("C");
      result.current.enqueue("D");
    });
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.sendNow(result.current.messages[1].id);
      await Promise.resolve();
    });
    expect(send.mock.calls.map(([text]) => text)).toEqual(["C"]);
    // C has completed, but its submission receipt has not arrived yet.
    rerender({ loading: false });
    expect(result.current.isHeld()).toBe(true);
    expect(waitForIdle).not.toHaveBeenCalled();
    await act(async () => {
      ack.resolve();
      await pending;
    });
    await waitFor(() => {
      expect(send.mock.calls.map(([text]) => text)).toEqual(["C", "B"]);
      expect(result.current.messages.map((m) => m.text)).toEqual(["D"]);
      expect(result.current.busy).toBe(false);
    });
    expect(waitForIdle).toHaveBeenCalledTimes(1);
    rerender({ loading: false });
    await waitFor(() => {
      expect(send.mock.calls.map(([text]) => text)).toEqual(["C", "B", "D"]);
      expect(result.current.messages).toEqual([]);
      expect(result.current.busy).toBe(false);
    });
    expect(waitForIdle).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
    expect(result.current.error).toBeNull();
    expect(result.current.isHeld()).toBe(false);
  });

  it("holds B,C,D until idle and submits selected C once despite repeated clicks and idle renders", async () => {
    const idle = deferred();
    const ack = deferred();
    const stop = vi.fn(() => idle.promise);
    const send = vi.fn(async (): Promise<SubmissionOutcome> => {
      await ack.promise;
      return "accepted";
    });
    const { result, rerender } = renderHook(
      ({ loading }) => useChatQueue({ isLoading: loading, stop, send }),
      { initialProps: { loading: true } },
    );
    act(() => {
      result.current.enqueue("B");
      result.current.enqueue("C");
      result.current.enqueue("D");
    });
    const ids = result.current.messages.map((m) => m.id);
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.sendNow(ids[1]);
      void result.current.sendNow(ids[2]);
    });
    rerender({ loading: false });
    expect(send).not.toHaveBeenCalled();
    expect(result.current.messages.map((m) => m.text)).toEqual(["B", "C", "D"]);
    await act(async () => {
      idle.resolve();
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("C", []);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(result.current.messages.map((m) => m.id)).toEqual(ids);
    // Unlike the complete-before-ACK case, C is still running on acceptance.
    rerender({ loading: true });
    await act(async () => {
      ack.resolve();
      await pending;
    });
    expect(result.current.messages.map((m) => m.text)).toEqual(["B", "D"]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
