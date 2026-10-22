import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChatActions } from "./useChatActions";
import type { SlashCommandCatalog } from "../slash/types";

function harness(
  overrides: Partial<Parameters<typeof useChatActions>[0]> = {},
): ReturnType<typeof renderHook<ReturnType<typeof useChatActions>, unknown>> {
  return renderHook(() =>
    useChatActions({
      runId: "run",
      connectionId: "connection",
      hermesSessionId: "stored",
      messages: [],
      isLoading: true,
      setIsLoading: vi.fn(),
      setMessages: vi.fn(),
      chatInputRef: { current: null },
      activeTurnRef: { current: null },
      contextFolder: null,
      localCommands: { executeLocal: vi.fn() },
      slashCatalog: {
        commands: [],
        resolve: () => undefined,
      } as unknown as SlashCommandCatalog,
      ...overrides,
    }),
  );
}

describe("chat stop and submission boundaries", () => {
  it("still aborts the legacy turn after Dashboard explicitly falls back", async () => {
    const legacy = vi.fn();
    const stop = vi.fn(async () => undefined);
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: { abortChat: legacy, sendMessage: vi.fn(async () => undefined) },
    });
    const { result } = harness({
      isLoading: false,
      sendViaDashboard: vi.fn(async () => false),
      abortDashboard: stop,
    });
    await act(async () => {
      await result.current.handleSend("legacy prompt");
    });
    await act(async () => {
      await result.current.handleAbort();
    });
    expect(legacy).toHaveBeenCalledWith("run", "connection");
    expect(stop).not.toHaveBeenCalled();
  });
  it("propagates an uncertain dashboard submit instead of treating handled as acceptance", async () => {
    const { result } = harness({
      isLoading: false,
      sendViaDashboard: vi.fn(async (): Promise<"uncertain"> => "uncertain"),
    });
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.handleSend("payload");
    });
    expect(outcome).toBe("uncertain");
  });
  it("uses the same awaitable stop for typed /stop without slash dispatch or legacy abort", async () => {
    let finish!: () => void;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const slash = vi.fn();
    const legacy = vi.fn();
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: { abortChat: legacy },
    });
    const { result } = harness({
      abortDashboard: stop,
      execSlashViaDashboard: slash,
    });
    let done = false;
    let sending!: Promise<unknown>;
    act(() => {
      sending = result.current.handleSend("/stop", [], true).then(() => {
        done = true;
      });
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(slash).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(done).toBe(false);
    await act(async () => {
      finish();
      await sending;
    });
    expect(done).toBe(true);
  });
});
