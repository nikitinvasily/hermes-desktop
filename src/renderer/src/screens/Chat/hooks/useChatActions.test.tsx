import { act, renderHook } from "@testing-library/react";
import { useRef, useState } from "react";
import type { ActiveTurn, Attachment, ChatMessage } from "../types";
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
  it.each(["explicit", "fallback"])(
    "rejects pending binary bytes visibly before %s legacy submission and settles the turn",
    async (mode) => {
      const sendMessage = vi.fn(async (): Promise<void> => {
        throw new Error("Binary file uploads require the Dashboard transport");
      });
      Object.defineProperty(window, "hermesAPI", {
        configurable: true,
        value: { sendMessage },
      });
      const attachment: Attachment = {
        id: "binary",
        kind: "path-ref",
        name: "report.pdf",
        mime: "application/pdf",
        size: 3,
        dataUrl: "data:application/pdf;base64,YWJj",
      };
      const { result } = renderHook(() => {
        const [messages, setMessages] = useState<ChatMessage[]>([]);
        const [isLoading, setIsLoading] = useState(false);
        const activeTurnRef = useRef<ActiveTurn | null>(null);
        const actions = useChatActions({
          runId: "run",
          connectionId: "ssh",
          hermesSessionId: null,
          messages,
          setMessages,
          isLoading,
          setIsLoading,
          activeTurnRef,
          chatInputRef: { current: null },
          contextFolder: null,
          localCommands: { executeLocal: vi.fn() },
          slashCatalog: {
            commands: [],
            resolve: () => undefined,
          } as unknown as SlashCommandCatalog,
          sendViaDashboard:
            mode === "fallback" ? async (): Promise<false> => false : undefined,
        });
        return { actions, messages, isLoading, activeTurnRef };
      });
      let outcome: unknown;
      await act(async () => {
        outcome = await result.current.actions.handleSend("read this", [
          attachment,
        ]);
      });
      expect(outcome).toBe("rejected");
      expect(result.current.isLoading).toBe(false);
      expect(result.current.activeTurnRef.current).toBeNull();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(result.current.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: "read this",
            attachments: [attachment],
          }),
          expect.objectContaining({
            role: "agent",
            error: expect.stringContaining("Dashboard"),
            pending: false,
          }),
        ]),
      );
    },
  );
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
