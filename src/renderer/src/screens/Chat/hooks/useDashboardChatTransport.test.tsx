import { act, render, waitFor } from "@testing-library/react";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { DashboardRpcEvent } from "../dashboardGatewayClient";
import { useDashboardChatTransport } from "./useDashboardChatTransport";
import { useTranscriptState } from "./useTranscriptState";
import { useChatActions } from "./useChatActions";
import { useChatQueue } from "./useChatQueue";
import type { SlashCommandCatalog } from "../slash/types";
import type { ActiveTurn, Attachment, ChatMessage, UsageState } from "../types";

type SetUsageMock = Mock<(value: SetStateAction<UsageState | null>) => void>;

const dashboardMock = vi.hoisted(() => ({
  close: vi.fn(),
  connect: vi.fn(async () => undefined),
  instances: [] as Array<{
    close: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    connected: boolean;
    request: ReturnType<typeof vi.fn>;
  }>,
  onClose: null as (() => void) | null,
  onEvent: null as ((event: DashboardRpcEvent) => void) | null,
  onServerRequest: null as
    | ((
        method: string,
        params: Record<string, unknown>,
        frameId?: number | string,
      ) => unknown)
    | null,
  request: vi.fn(),
}));

vi.mock("../dashboardGatewayClient", () => ({
  DashboardGatewayClient: class MockDashboardGatewayClient {
    close = dashboardMock.close;
    connect = dashboardMock.connect;
    connected = true;
    request = dashboardMock.request;

    constructor(
      options: {
        onEvent?: (event: DashboardRpcEvent) => void;
        onClose?: () => void;
        onServerRequest?: (
          method: string,
          params: Record<string, unknown>,
        ) => unknown;
      } = {},
    ) {
      dashboardMock.onEvent = options.onEvent ?? null;
      dashboardMock.onClose = options.onClose ?? null;
      dashboardMock.onServerRequest = options.onServerRequest ?? null;
      dashboardMock.instances.push(this);
    }
  },
}));

interface HarnessApi {
  actions?: ReturnType<typeof useChatActions>;
  queue?: ReturnType<typeof useChatQueue>;
  isLoading?: boolean;
  activeTurnRef?: MutableRefObject<ActiveTurn | null>;
  abort?: () => Promise<void>;
  waitForIdle?: () => Promise<void>;
  execSlash?: ReturnType<typeof useDashboardChatTransport>["execSlash"];
  messages?: ChatMessage[];
  resyncAfterDetach?: () => Promise<void>;
  hasDetachedTurn?: boolean;
  respondClarify?: ReturnType<
    typeof useDashboardChatTransport
  >["respondClarify"];
  respondApproval?: ReturnType<
    typeof useDashboardChatTransport
  >["respondApproval"];
  send?: ReturnType<typeof useDashboardChatTransport>["sendMessage"];
  hasActiveSubagents?: boolean;
  sessionYolo?: boolean | null;
  toggleSessionYolo?: (enabled: boolean) => Promise<boolean>;
  setConnectionMode?: Dispatch<SetStateAction<"local" | "remote" | "ssh">>;
  setMessages?: Dispatch<SetStateAction<ChatMessage[]>>;
  setModel?: Dispatch<SetStateAction<string>>;
  setProvider?: Dispatch<SetStateAction<string>>;
}

const activeBadTurn: ActiveTurn = {
  startIndex: 0,
  status: "running",
  turnId: "turn-bad",
  userId: "u-bad",
};

const activeRecoveryTurn: ActiveTurn = {
  startIndex: 2,
  status: "running",
  turnId: "turn-recovery",
  userId: "u-recovery",
};

function Harness({
  api,
  connectionId,
  connectionRevision,
  fallbackOnUnavailable = false,
  hermesSessionId = null,
  initialConnectionMode = "local",
  onDashboardUnavailable,
  onTodoState,
  setUsage = vi.fn() as SetUsageMock,
}: {
  api: HarnessApi;
  connectionId?: string;
  connectionRevision?: number;
  fallbackOnUnavailable?: boolean;
  hermesSessionId?: string | null;
  initialConnectionMode?: "local" | "remote" | "ssh";
  onDashboardUnavailable?: (reason: string) => void;
  onTodoState?: (snapshot: unknown) => void;
  setUsage?: SetUsageMock;
}): null {
  // Same write-through transcript state Chat.tsx uses — the transport's
  // coalescing contract requires setMessages and messagesRef to be paired.
  const { messages, setMessages, messagesRef } = useTranscriptState([
    {
      id: "u-bad",
      role: "user",
      content: "bad provider turn",
      turnId: "turn-bad",
    },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [model, setModel] = useState("bad-model");
  const [provider, setProvider] = useState("bad-provider");
  const [connectionMode, setConnectionMode] = useState<
    "local" | "remote" | "ssh"
  >(initialConnectionMode);
  const activeTurnRef = useRef<ActiveTurn | null>({ ...activeBadTurn });
  const transport = useDashboardChatTransport({
    activeTurnRef,
    connectionId,
    connectionRevision,
    contextFolder: null,
    connectionMode,
    enabled: true,
    fallbackOnUnavailable,
    hermesSessionId,
    messagesRef,
    model,
    profile: undefined,
    provider,
    setHermesSessionId: vi.fn(),
    setIsLoading,
    setMessages,
    setToolProgress: vi.fn(),
    setUsage,
    onDashboardUnavailable,
    onTodoState,
  });

  const sendRef = useRef<ReturnType<typeof useChatActions>["handleSend"]>(
    async () => undefined,
  );
  const queue = useChatQueue({
    isLoading,
    scopeKey: `${connectionId}|${connectionRevision}`,
    stop: transport.abort,
    waitForIdle: transport.waitForIdle,
    send: (text, attachments) => sendRef.current(text, attachments, true),
  });
  const actions = useChatActions({
    runId: "test-run",
    connectionId: connectionId ?? "local",
    hermesSessionId,
    messages,
    isLoading,
    setIsLoading,
    setMessages,
    activeTurnRef,
    contextFolder: null,
    chatInputRef: { current: null },
    localCommands: { executeLocal: async () => false },
    slashCatalog: {
      commands: [],
      resolve: () => undefined,
    } as unknown as SlashCommandCatalog,
    abortDashboard: queue.stopCurrentTurn,
    sendViaDashboard: transport.sendMessage,
    execSlashViaDashboard: transport.execSlash,
  });
  useEffect(() => {
    sendRef.current = actions.handleSend;
  });
  useEffect(() => {
    Object.assign(api, { actions, queue });
  });

  useEffect(() => {
    // Bridge the hook's live values out to the test via the shared `api`
    // object. Object.assign mutates it in place (same reference the test
    // holds) without per-prop assignment, which the immutability rule rejects.
    Object.assign(api, {
      isLoading,
      activeTurnRef,
      abort: transport.abort,
      waitForIdle: transport.waitForIdle,
      execSlash: transport.execSlash,
      messages,
      resyncAfterDetach: transport.resyncAfterDetach,
      hasDetachedTurn: transport.hasDetachedTurn,
      respondApproval: transport.respondApproval,
      respondClarify: transport.respondClarify,
      send: transport.sendMessage,
      hasActiveSubagents: transport.hasActiveSubagents,
      sessionYolo: transport.sessionYolo,
      toggleSessionYolo: transport.toggleSessionYolo,
      setConnectionMode,
      setMessages,
      setModel,
      setProvider,
    });
  }, [
    isLoading,
    activeTurnRef,
    api,
    messages,
    setConnectionMode,
    setMessages,
    transport.sendMessage,
    transport.respondApproval,
    transport.respondClarify,
    transport.resyncAfterDetach,
    transport.hasDetachedTurn,
    transport.hasActiveSubagents,
    transport.sessionYolo,
    transport.toggleSessionYolo,
    transport.abort,
    transport.waitForIdle,
    transport.execSlash,
  ]);

  return null;
}

describe("useDashboardChatTransport recovery", () => {
  it("forwards todo.updated payloads to onTodoState (issue #126)", async () => {
    const onTodoState = vi.fn();
    const api: HarnessApi = {};
    render(<Harness api={api} onTodoState={onTodoState} />);
    await act(async () => {
      await api.send?.("hello");
    });
    const payload = {
      todos: [{ id: "1", content: "Ship", status: "pending" }],
      revision: 4,
    };
    await act(async () => {
      dashboardMock.onEvent?.({
        type: "todo.updated",
        payload,
      });
    });
    expect(onTodoState).toHaveBeenCalledWith(payload);
  });

  it("uses the latest todo callback after rerender without reattaching the session", async () => {
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.resume")
        return {
          session_id: "runtime-parent",
          stored_session_id: "stored-parent",
          running: true,
        };
      return { subagents: [] };
    });
    const api: HarnessApi = {};
    const previous = vi.fn();
    const latest = vi.fn();
    const view = render(
      <Harness
        api={api}
        hermesSessionId="stored-parent"
        onTodoState={previous}
      />,
    );
    await waitFor(() =>
      expect(dashboardMock.request).toHaveBeenCalledWith("subagent.list", {
        session_id: "runtime-parent",
      }),
    );
    const onEvent = dashboardMock.onEvent;
    view.rerender(
      <Harness
        api={api}
        hermesSessionId="stored-parent"
        onTodoState={latest}
      />,
    );
    const payload = { todos: [], revision: 5 };
    act(() => {
      onEvent?.({ type: "todo.updated", session_id: "other", payload });
      onEvent?.({
        type: "todo.updated",
        session_id: "runtime-parent",
        payload,
      });
    });
    expect(latest).toHaveBeenCalledExactlyOnceWith(payload);
    expect(previous).not.toHaveBeenCalled();
    view.rerender(<Harness api={api} hermesSessionId="stored-parent" />);
    act(() =>
      onEvent?.({
        type: "todo.updated",
        session_id: "runtime-parent",
        payload,
      }),
    );
    expect(latest).toHaveBeenCalledTimes(1);
    expect(dashboardMock.onEvent).toBe(onEvent);
    expect(dashboardMock.instances).toHaveLength(1);
    expect(dashboardMock.connect).toHaveBeenCalledTimes(1);
    expect(dashboardMock.close).not.toHaveBeenCalled();
    expect(
      dashboardMock.request.mock.calls.filter(
        ([method]) => method === "session.resume",
      ),
    ).toHaveLength(1);
    expect(api.isLoading).toBe(true);
    view.unmount();
  });

  beforeEach(() => {
    dashboardMock.close.mockClear();
    dashboardMock.connect.mockClear();
    dashboardMock.instances.length = 0;
    dashboardMock.onEvent = null;
    dashboardMock.request.mockReset();
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        freshDashboardWsUrl: vi.fn(async () => "ws://fresh-dashboard"),
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard: vi.fn(async () => ({
          connection: { wsUrl: "ws://127.0.0.1:12345" },
          running: true,
        })),
      },
    });
  });

  it.each(["startup", "connect"] as const)(
    "discards eager roster acquisition resolved after unmount during %s",
    async (stage) => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const startDashboard = vi.fn(async () => {
        if (stage === "startup") await pending;
        return {
          connection: { wsUrl: "ws://127.0.0.1:12345" },
          running: true,
        };
      });
      Object.defineProperty(window, "hermesAPI", {
        configurable: true,
        value: { startDashboard },
      });
      if (stage === "connect") {
        dashboardMock.connect.mockImplementationOnce(async () => {
          await pending;
          return undefined;
        });
      }
      const view = render(<Harness api={{}} hermesSessionId="stored-parent" />);
      await waitFor(() => {
        expect(startDashboard).toHaveBeenCalledTimes(1);
        if (stage === "connect") {
          expect(dashboardMock.connect).toHaveBeenCalledTimes(1);
        }
      });
      view.unmount();
      await act(async () => {
        release();
        await pending;
      });
      if (stage === "startup") {
        expect(dashboardMock.instances).toHaveLength(0);
      } else {
        expect(dashboardMock.instances).toHaveLength(1);
        expect(dashboardMock.instances[0].close).toHaveBeenCalledTimes(1);
      }
      expect(dashboardMock.request).not.toHaveBeenCalled();
    },
  );

  it("does not reconnect from a delayed drop probe after unmount", async () => {
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.resume") {
        return {
          session_id: "runtime-parent",
          stored_session_id: "stored-parent",
          running: true,
        };
      }
      return {};
    });
    const api: HarnessApi = {};
    const view = render(<Harness api={api} hermesSessionId="stored-parent" />);
    await waitFor(() =>
      expect(dashboardMock.request).toHaveBeenCalledWith("subagent.list", {
        session_id: "runtime-parent",
      }),
    );
    vi.useFakeTimers();
    try {
      act(() => dashboardMock.onClose?.());
      expect(api.hasDetachedTurn).toBe(true);
      view.unmount();
      dashboardMock.request.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(dashboardMock.instances).toHaveLength(1);
      expect(dashboardMock.connect).toHaveBeenCalledTimes(1);
      expect(dashboardMock.request).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // @lat: [[sidebar-navigation#Sidebar recent sessions#Session state bullets#Backend-started continuation]]
  it.each(["local", "remote", "ssh"] as const)(
    "restores activity for repeated backend-started turns on an idle %s chat",
    async (initialConnectionMode) => {
      dashboardMock.request.mockImplementation(async (method: string) => {
        if (method === "session.resume")
          return {
            session_id: "runtime-parent",
            stored_session_id: "stored-parent",
            running: false,
          };
        return { subagents: [] };
      });
      const api: HarnessApi = {};
      const view = render(
        <Harness
          api={api}
          hermesSessionId="stored-parent"
          initialConnectionMode={initialConnectionMode}
        />,
      );
      await waitFor(() =>
        expect(dashboardMock.request).toHaveBeenCalledWith("subagent.list", {
          session_id: "runtime-parent",
        }),
      );
      const emit = (type: string, session_id = "runtime-parent"): void => {
        act(() => dashboardMock.onEvent?.({ type, session_id, payload: {} }));
      };
      emit("message.complete");
      expect(api.isLoading).toBe(false);
      expect(api.activeTurnRef?.current).toBeNull();
      emit("message.start", "unrelated-runtime");
      expect(api.isLoading).toBe(false);
      for (let turn = 0; turn < 3; turn++) {
        emit("message.start");
        expect(api.isLoading).toBe(true);
        expect(api.activeTurnRef?.current?.status).toBe("running");
        const activeTurn = api.activeTurnRef?.current;
        emit("message.start");
        expect(api.activeTurnRef?.current).toBe(activeTurn);
        emit("message.complete");
        expect(api.isLoading).toBe(false);
        expect(api.activeTurnRef?.current).toBeNull();
      }
      expect(
        dashboardMock.request.mock.calls.some(
          ([method]) => method === "prompt.submit",
        ),
      ).toBe(false);
      view.unmount();
    },
  );

  it("shares a cold resume between the roster probe and a user send", async () => {
    let resume!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resume = resolve;
    });
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.resume") return pending;
      if (method === "subagent.list")
        return { subagents: [{ status: "running" }] };
      if (method === "model.options")
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} hermesSessionId="stored-parent" />);
    await waitFor(() =>
      expect(dashboardMock.request).toHaveBeenCalledWith(
        "session.resume",
        expect.objectContaining({ session_id: "stored-parent" }),
      ),
    );
    let sending!: ReturnType<NonNullable<HarnessApi["send"]>>;
    act(() => {
      sending = api.send!("hello");
    });
    await act(async () => {
      resume({
        session_id: "runtime-parent",
        stored_session_id: "stored-parent",
        running: false,
      });
      await sending;
    });
    expect(
      dashboardMock.request.mock.calls.filter(
        ([method]) => method === "session.resume",
      ),
    ).toHaveLength(1);
    expect(dashboardMock.request).toHaveBeenCalledWith("subagent.list", {
      session_id: "runtime-parent",
    });
    expect(api.hasActiveSubagents).toBe(true);
  });

  it("does not bind a delayed resume to a different stored chat on the same socket", async () => {
    let resumeOld!: (value: unknown) => void;
    const old = new Promise((resolve) => {
      resumeOld = resolve;
    });
    dashboardMock.request.mockImplementation(
      async (method: string, params: Record<string, unknown>) => {
        if (method === "session.resume") {
          if (params.session_id === "stored-old") return old;
          return {
            session_id: "runtime-new",
            stored_session_id: "stored-new",
            running: false,
          };
        }
        if (method === "subagent.list")
          return {
            subagents:
              params.session_id === "runtime-old"
                ? [{ status: "running" }]
                : [],
          };
        return {};
      },
    );
    const api: HarnessApi = {};
    const { rerender } = render(
      <Harness api={api} hermesSessionId="stored-old" />,
    );
    await waitFor(() =>
      expect(dashboardMock.request).toHaveBeenCalledWith(
        "session.resume",
        expect.objectContaining({ session_id: "stored-old" }),
      ),
    );
    rerender(<Harness api={api} hermesSessionId="stored-new" />);
    await act(async () => {
      resumeOld({
        session_id: "runtime-old",
        stored_session_id: "stored-old",
        running: false,
      });
    });
    await waitFor(() =>
      expect(dashboardMock.request).toHaveBeenCalledWith(
        "session.resume",
        expect.objectContaining({ session_id: "stored-new" }),
      ),
    );
    expect(dashboardMock.request).not.toHaveBeenCalledWith("subagent.list", {
      session_id: "runtime-old",
    });
    expect(api.hasActiveSubagents).toBe(false);
  });

  it("does not let a roster resume absorb forced recovery after a failed turn", async () => {
    let releaseResume!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      releaseResume = resolve;
    });
    let resumingAfterDrop = false;
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.resume") {
        if (resumingAfterDrop) return pending;
        return {
          session_id: "runtime-parent",
          stored_session_id: "stored-parent",
          running: false,
        };
      }
      if (method === "session.create")
        return {
          session_id: "runtime-clean",
          stored_session_id: "stored-parent",
        };
      if (method === "model.options")
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      if (method === "subagent.list") return { subagents: [] };
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} hermesSessionId="stored-parent" />);
    await waitFor(() =>
      expect(dashboardMock.request).toHaveBeenCalledWith("subagent.list", {
        session_id: "runtime-parent",
      }),
    );
    await act(async () => {
      await api.send!("bad provider turn");
      dashboardMock.onEvent?.({
        type: "message.complete",
        session_id: "runtime-parent",
        payload: { error: "Invalid API Key", status: "error" },
      });
      resumingAfterDrop = true;
      dashboardMock.onClose?.();
    });
    await waitFor(
      () =>
        expect(
          dashboardMock.request.mock.calls.filter(
            ([method]) => method === "session.resume",
          ),
        ).toHaveLength(2),
      { timeout: 3500 },
    );
    let sending!: ReturnType<NonNullable<HarnessApi["send"]>>;
    act(() => {
      api.activeTurnRef!.current = { ...activeRecoveryTurn };
      sending = api.send!("recovery turn");
    });
    await act(async () => {
      releaseResume({
        session_id: "runtime-resumed",
        stored_session_id: "stored-parent",
        running: false,
      });
      await sending;
    });
    expect(dashboardMock.request).toHaveBeenCalledWith(
      "session.create",
      expect.any(Object),
    );
    expect(dashboardMock.request).toHaveBeenLastCalledWith(
      "prompt.submit",
      expect.objectContaining({ session_id: "runtime-clean" }),
    );
    expect(window.hermesAPI.recordSessionContinuation).toHaveBeenCalledWith(
      "stored-parent",
      expect.arrayContaining([{ kind: "user", content: "bad provider turn" }]),
    );
  });

  it("routes /stop to interrupt without synchronizing the selected model", async () => {
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.create" || method === "session.resume")
        return {
          session_id: "live",
          stored_session_id: "stored",
          running: false,
        };
      if (method === "model.options")
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await act(async () => {
      await api.send?.("hello");
    });
    await act(async () => {
      api.setModel?.("different-model");
    });
    dashboardMock.request.mockClear();
    await act(async () => {
      await api.execSlash?.("/stop", vi.fn());
    });
    expect(dashboardMock.request).toHaveBeenCalledWith("session.interrupt", {
      session_id: "live",
    });
    // Resume addresses the durable conversation, not its ephemeral runtime ID.
    expect(dashboardMock.request).toHaveBeenCalledWith("session.resume", {
      session_id: "stored",
    });
    expect(
      dashboardMock.request.mock.calls.map(([method]) => method),
    ).not.toContain("slash.exec");
    expect(
      dashboardMock.request.mock.calls.map(([method]) => method),
    ).not.toContain("config.set");
    expect(
      dashboardMock.request.mock.calls.map(([method]) => method),
    ).not.toContain("session.close");
  });

  it("joins stop calls and waits past complete and interrupt ACK until real idle", async () => {
    let acknowledge!: (value: unknown) => void;
    let settle!: (value: unknown) => void;
    const interrupt = new Promise((resolve) => {
      acknowledge = resolve;
    });
    const idle = new Promise((resolve) => {
      settle = resolve;
    });
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.create")
        return { session_id: "live", stored_session_id: "stored" };
      if (method === "model.options")
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      if (method === "session.interrupt") return interrupt;
      if (method === "session.resume") return idle;
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await act(async () => {
      await api.send?.("hello");
    });
    let finished = false;
    let stopping!: Promise<void>;
    act(() => {
      stopping = Promise.resolve(api.abort?.()).then(() => {
        finished = true;
      });
      void api.abort?.();
    });
    await act(async () => {
      dashboardMock.onEvent?.({
        type: "message.complete",
        session_id: "live",
        payload: {},
      });
      acknowledge({ status: "interrupted" });
      await Promise.resolve();
    });
    expect(finished).toBe(false);
    expect(api.isLoading).toBe(true);
    expect(
      dashboardMock.request.mock.calls.filter(
        ([method]) => method === "session.interrupt",
      ),
    ).toHaveLength(1);
    await act(async () => {
      settle({ session_id: "live", running: false });
      await stopping;
    });
    expect(finished).toBe(true);
    expect(api.isLoading).toBe(false);
    expect(api.activeTurnRef?.current).toBeNull();
    expect(dashboardMock.close).not.toHaveBeenCalled();
  });

  it("reports a lost submit ACK as uncertain without replay or session recreation", async () => {
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.create")
        return { session_id: "live", stored_session_id: "stored" };
      if (method === "model.options")
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      if (method === "prompt.submit")
        throw new Error("Hermes dashboard request timed out: prompt.submit");
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    let outcome: unknown;
    await act(async () => {
      outcome = await api.send?.("hello");
    });
    expect(outcome).toBe("uncertain");
    expect(
      dashboardMock.request.mock.calls.filter(
        ([method]) => method === "prompt.submit",
      ),
    ).toHaveLength(1);
    expect(
      dashboardMock.request.mock.calls.map(([method]) => method),
    ).not.toContain("session.close");
  });

  it("reports an explicit prompt rejection without claiming acceptance", async () => {
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.create")
        return { session_id: "live", stored_session_id: "stored" };
      if (method === "model.options")
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      if (method === "prompt.submit")
        throw Object.assign(new Error("Session is busy"), {
          rpcRejected: true,
        });
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    let outcome: unknown;
    await act(async () => {
      outcome = await api.send?.("C");
    });
    expect(outcome).toBe("rejected");
    expect(
      dashboardMock.request.mock.calls.filter(
        ([method]) => method === "prompt.submit",
      ),
    ).toHaveLength(1);
  });

  it.each(["complete", "Stop"])(
    "does not let a superseded pending Stop suppress the new connection's %s",
    async (event) => {
      let acknowledge!: (value: unknown) => void;
      const interrupted = new Promise((resolve) => {
        acknowledge = resolve;
      });
      let interrupts = 0;
      dashboardMock.request.mockImplementation(async (method: string) => {
        if (method === "session.create" || method === "session.resume")
          return {
            session_id: "live",
            stored_session_id: "stored",
            running: false,
          };
        if (method === "model.options")
          return {
            model: "bad-model",
            provider: "bad-provider",
            providers: [],
          };
        if (method === "session.interrupt" && ++interrupts === 1)
          return interrupted;
        return {};
      });
      const api: HarnessApi = {};
      const { rerender } = render(<Harness api={api} connectionRevision={1} />);
      await act(async () => {
        await api.actions!.handleSend("A");
      });
      let oldStop!: Promise<string>;
      act(() => {
        oldStop = api.queue!.stopCurrentTurn().then(
          () => "stopped",
          (error: Error) => error.message,
        );
      });
      await waitFor(() => expect(interrupts).toBe(1));
      rerender(<Harness api={api} connectionRevision={2} />);
      await act(async () => {
        await api.actions!.handleSend("C");
      });
      let newStop!: Promise<void>;
      if (event === "complete") {
        await act(async () => {
          dashboardMock.onEvent?.({
            type: "message.complete",
            session_id: "live",
            payload: {},
          });
        });
        expect(api.isLoading).toBe(false);
        expect(api.activeTurnRef!.current).toBeNull();
      } else {
        act(() => {
          newStop = api.queue!.stopCurrentTurn();
        });
        await waitFor(() => expect(interrupts).toBe(2));
        await act(async () => {
          await newStop;
        });
        expect(api.isLoading).toBe(false);
      }
      await act(async () => {
        acknowledge({});
        expect(await oldStop).toMatch(/changed|superseded/i);
      });
      expect(api.isLoading).toBe(false);
      expect(api.activeTurnRef!.current).toBeNull();
    },
  );

  it("does not settle a new connection's turn when an old interrupt ACK arrives", async () => {
    let acknowledge!: (value: unknown) => void;
    const interrupted = new Promise((resolve) => {
      acknowledge = resolve;
    });
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.create" || method === "session.resume")
        return {
          session_id: "live",
          stored_session_id: "stored",
          running: false,
        };
      if (method === "model.options")
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      if (method === "session.interrupt") return interrupted;
      return {};
    });
    const api: HarnessApi = {};
    const { rerender } = render(<Harness api={api} connectionRevision={1} />);
    await act(async () => {
      await api.send?.("A");
    });
    let stopping!: Promise<string>;
    act(() => {
      stopping = api.abort!().then(
        () => "stopped",
        (error: Error) => error.message,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    rerender(<Harness api={api} connectionRevision={2} />);
    await act(async () => {
      await api.send?.("C");
    });
    const successor = { ...activeRecoveryTurn };
    api.activeTurnRef!.current = successor;
    let outcome = "";
    await act(async () => {
      acknowledge({ status: "interrupted" });
      outcome = await stopping;
    });
    expect(outcome).toMatch(/changed|superseded/i);
    expect(api.activeTurnRef?.current).toBe(successor);
  });

  it.each(["button", "/stop"])(
    "interrupts a submitted successor via %s before its submit ACK",
    async (control) => {
      let acknowledge!: (value: unknown) => void;
      const submitted = new Promise((resolve) => {
        acknowledge = resolve;
      });
      dashboardMock.request.mockImplementation(
        async (method: string, params) => {
          if (method === "session.create" || method === "session.resume")
            return {
              session_id: "live",
              stored_session_id: "stored",
              running: false,
            };
          if (method === "model.options")
            return {
              model: "bad-model",
              provider: "bad-provider",
              providers: [],
            };
          if (method === "prompt.submit" && params.text === "C")
            return submitted;
          return {};
        },
      );
      const api: HarnessApi = {};
      render(<Harness api={api} />);
      await act(async () => {
        await api.actions!.handleSend("A");
      });
      act(() => api.queue!.enqueue("C"));
      const id = api.queue!.messages[0].id;
      let sending!: Promise<void>;
      act(() => {
        sending = api.queue!.sendNow(id);
      });
      await waitFor(() =>
        expect(dashboardMock.request).toHaveBeenCalledWith(
          "prompt.submit",
          expect.objectContaining({ text: "C" }),
        ),
      );
      let stopping!: Promise<unknown>;
      act(() => {
        void api.queue!.sendNow(id);
        stopping =
          control === "button"
            ? api.queue!.stopCurrentTurn()
            : api.actions!.handleSend("/stop");
      });
      await waitFor(() =>
        expect(
          dashboardMock.request.mock.calls.filter(
            ([method]) => method === "session.interrupt",
          ),
        ).toHaveLength(2),
      );
      await act(async () => {
        await stopping;
      });
      expect(api.isLoading).toBe(false);
      await act(async () => {
        acknowledge({});
        await sending;
      });
      expect(
        dashboardMock.request.mock.calls.filter(
          ([method, params]) =>
            method === "prompt.submit" && params.text === "C",
        ),
      ).toHaveLength(1);
      expect(api.queue!.messages).toEqual([]);
    },
  );

  it("serializes real queue/actions/transport through complete-before-idle and repeated clicks", async () => {
    let acknowledge!: (value: unknown) => void;
    let settle!: (value: unknown) => void;
    const interrupted = new Promise((resolve) => {
      acknowledge = resolve;
    });
    const idle = new Promise((resolve) => {
      settle = resolve;
    });
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.create")
        return { session_id: "live", stored_session_id: "stored" };
      if (method === "model.options")
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      if (method === "session.interrupt") return interrupted;
      if (method === "session.resume") return idle;
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await act(async () => {
      await api.actions!.handleSend("A");
    });
    act(() => {
      api.queue!.enqueue("B");
      api.queue!.enqueue("C");
      api.queue!.enqueue("D");
    });
    const [b, c, d] = api.queue!.messages;
    let sending!: Promise<void>;
    act(() => {
      sending = api.queue!.sendNow(c.id);
      void api.queue!.sendNow(d.id);
    });
    await act(async () => {
      dashboardMock.onEvent?.({
        type: "message.complete",
        session_id: "live",
        payload: { text: "A stopped" },
      });
      acknowledge({ status: "interrupted" });
      await Promise.resolve();
    });
    expect(api.isLoading).toBe(true);
    expect(
      dashboardMock.request.mock.calls.filter(
        ([method]) => method === "prompt.submit",
      ),
    ).toHaveLength(1);
    expect(api.queue!.messages.map((m) => m.id)).toEqual([b.id, c.id, d.id]);
    await act(async () => {
      settle({ session_id: "live", running: false });
      await sending;
    });
    expect(api.queue!.messages.map((m) => m.id)).toEqual([b.id, d.id]);
    const prompts = dashboardMock.request.mock.calls.filter(
      ([method]) => method === "prompt.submit",
    );
    expect(prompts.map(([, params]) => params.text)).toEqual(["A", "C"]);
    expect(api.isLoading).toBe(true);
    expect(api.activeTurnRef?.current?.status).toBe("running");
    expect(
      dashboardMock.request.mock.calls.filter(
        ([method]) => method === "session.interrupt",
      ),
    ).toHaveLength(1);
    expect(
      dashboardMock.request.mock.calls.map(([method]) => method),
    ).not.toContain("session.close");
  });

  it("keeps ordinary legacy fallback draining but refuses unconfirmed force-send", async () => {
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        startDashboard: vi.fn(async () => ({ running: false })),
      },
    });
    const api: HarnessApi = {};
    const { rerender } = render(
      <Harness api={api} fallbackOnUnavailable initialConnectionMode="ssh" />,
    );
    await act(async () => {
      expect(await api.send?.("A")).toBe(false);
    });
    await act(async () => {
      await expect(api.waitForIdle!()).resolves.toBeUndefined();
    });
    await act(async () => {
      await expect(api.abort!()).rejects.toThrow(/legacy/i);
    });
    expect(dashboardMock.request).not.toHaveBeenCalled();
    rerender(
      <Harness
        api={api}
        fallbackOnUnavailable
        initialConnectionMode="ssh"
        connectionRevision={1}
      />,
    );
    await act(async () => {
      await expect(api.waitForIdle!()).rejects.toThrow(/unavailable/i);
    });
  });

  it("drops terminal events from a superseded socket even when runtime IDs match", async () => {
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.create" || method === "session.resume")
        return {
          session_id: "live",
          stored_session_id: "stored",
          running: false,
        };
      if (method === "model.options")
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      return {};
    });
    const api: HarnessApi = {};
    const { rerender } = render(<Harness api={api} connectionRevision={1} />);
    await act(async () => {
      await api.actions!.handleSend("A");
    });
    const oldEvent = dashboardMock.onEvent;
    rerender(<Harness api={api} connectionRevision={2} />);
    await act(async () => {
      await api.actions!.handleSend("C");
    });
    const successor = api.activeTurnRef!.current;
    await act(async () => {
      oldEvent?.({
        type: "message.complete",
        session_id: "live",
        payload: { text: "old A" },
      });
    });
    expect(api.activeTurnRef!.current).toBe(successor);
    expect(api.isLoading).toBe(true);
    expect(
      api.messages?.some((m) => "content" in m && m.content === "old A"),
    ).toBe(false);
  });

  it("times out an unknown idle state without closing or replaying the session", async () => {
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.resume") return { session_id: "live" };
      if (method === "session.create")
        return { session_id: "live", stored_session_id: "stored" };
      if (method === "model.options")
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await act(async () => {
      await api.actions!.handleSend("A");
    });
    vi.useFakeTimers();
    try {
      let stop!: Promise<string>;
      act(() => {
        stop = api.abort!().then(
          () => "stopped",
          (error: Error) => error.message,
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10001);
      });
      expect(await stop).toContain("Timed out");
      expect(dashboardMock.close).not.toHaveBeenCalled();
      expect(
        dashboardMock.request.mock.calls.map(([method]) => method),
      ).not.toContain("session.close");
      expect(
        dashboardMock.request.mock.calls.map(([method]) => method),
      ).not.toContain("session.status");
      const requests = dashboardMock.request.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(dashboardMock.request.mock.calls).toHaveLength(requests);
    } finally {
      vi.useRealTimers();
    }
  });

  async function clarifyHarness(): Promise<HarnessApi> {
    dashboardMock.request.mockImplementation(async (method) => {
      if (method === "session.create")
        return { session_id: "live", stored_session_id: "stored" };
      if (method === "model.options")
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      if (method === "clarify.respond") return { status: "ok" };
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await act(async () => {
      await api.send?.("hello");
    });
    await act(async () => {
      dashboardMock.onEvent?.({
        type: "clarify.request",
        session_id: "live",
        payload: {
          request_id: "q1",
          question: "Where?",
          choices: ["staging", "production"],
        },
      });
    });
    return api;
  }

  // @lat: [[dashboard-clarify#Gateway answer delivery]]
  it.each(["staging", "custom answer", ""])(
    "delivers a dashboard clarification answer %j",
    async (answer) => {
      const api = await clarifyHarness();
      expect(api.messages?.find((m) => m.kind === "clarify")).toMatchObject({
        choices: ["staging", "production"],
      });
      await act(async () => {
        expect(await api.respondClarify?.("q1", answer)).toBe(true);
      });
      expect(dashboardMock.request).toHaveBeenCalledWith("clarify.respond", {
        request_id: "q1",
        answer,
      });
      expect(api.messages?.find((m) => m.kind === "clarify")).toMatchObject({
        resolved: true,
        answer,
      });
    },
  );

  // @lat: [[dashboard-clarify#Consecutive questions]]
  it("preserves the next question when the prior reply acknowledgement arrives late", async () => {
    const api = await clarifyHarness();
    let finish!: (value: { status: string }) => void;
    dashboardMock.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let reply!: Promise<boolean>;
    await act(async () => {
      reply = api.respondClarify!("q1", "staging");
    });
    await act(async () => {
      dashboardMock.onEvent?.({
        type: "clarify.request",
        session_id: "live",
        payload: {
          request_id: "q2",
          question: "Region?",
          choices: ["EU", "US"],
        },
      });
    });
    await act(async () => {
      finish({ status: "ok" });
      expect(await reply).toBe(true);
    });
    expect(
      api.messages?.find((m) => m.kind === "clarify" && m.requestId === "q1"),
    ).toMatchObject({ resolved: true, unavailable: false });
    await act(async () => {
      expect(await api.respondClarify!("q2", "EU")).toBe(true);
    });
    expect(dashboardMock.request).toHaveBeenLastCalledWith("clarify.respond", {
      request_id: "q2",
      answer: "EU",
    });
  });

  // @lat: [[dashboard-clarify#Disconnect during answer]]
  it("releases the busy turn when the socket closes before clarify RPC rejects", async () => {
    const api = await clarifyHarness();
    let reject!: (reason: Error) => void;
    dashboardMock.request.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    let answer!: Promise<boolean>;
    act(() => {
      answer = api.respondClarify!("q1", "yes");
    });
    expect(api.isLoading).toBe(true);
    await act(async () => {
      dashboardMock.onClose?.();
      reject(new Error("socket closed"));
      await answer;
    });
    expect(api.isLoading).toBe(false);
    expect(api.activeTurnRef?.current).toBeNull();
    expect(api.messages?.find((m) => m.kind === "clarify")).toMatchObject({
      unavailable: true,
    });
    await act(async () => {
      expect(await api.send?.("retry after disconnect")).toBe("rejected");
    });
  });

  // @lat: [[dashboard-clarify#Stale request isolation]]
  it.each(["answered", "completed"])(
    "preserves the next question when an %s question is replayed",
    async (state) => {
      const api = await clarifyHarness();
      await act(async () => {
        if (state === "answered") await api.respondClarify!("q1", "staging");
        else
          dashboardMock.onEvent?.({
            type: "message.complete",
            session_id: "live",
            payload: { text: "Done" },
          });
        dashboardMock.onEvent?.({
          type: "clarify.request",
          session_id: "live",
          payload: { request_id: "q2", question: "Region?", choices: ["EU"] },
        });
        dashboardMock.onEvent?.({
          type: "clarify.request",
          session_id: "live",
          payload: {
            request_id: "q1",
            question: "Where?",
            choices: ["staging"],
          },
        });
      });
      expect(
        api.messages?.find((m) => m.kind === "clarify" && m.requestId === "q2"),
      ).toMatchObject({ unavailable: false });
      await act(async () => {
        expect(await api.respondClarify!("q2", "EU")).toBe(true);
      });
    },
  );

  // @lat: [[dashboard-clarify#In-flight request replay]]
  it("keeps a resumed turn busy when its question is replayed during delivery", async () => {
    const api = await clarifyHarness();
    let finish!: (value: { status: string }) => void;
    dashboardMock.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let reply!: Promise<boolean>;
    act(() => {
      reply = api.respondClarify!("q1", "staging");
    });
    const resumedTurn = api.activeTurnRef?.current;
    act(() => {
      dashboardMock.onEvent?.({
        type: "clarify.request",
        session_id: "live",
        payload: { request_id: "q1", question: "Where?", choices: ["staging"] },
      });
    });
    expect(api.isLoading).toBe(true);
    expect(api.activeTurnRef?.current).toBe(resumedTurn);
    await act(async () => {
      finish({ status: "ok" });
      await reply;
    });
  });

  // @lat: [[dashboard-clarify#Gateway expiration]]
  it("expires only the matching question and tracks the agent resuming after timeout", async () => {
    const api = await clarifyHarness();
    act(() => {
      dashboardMock.onEvent?.({
        type: "clarify.expire",
        session_id: "live",
        payload: { request_id: "old" },
      });
    });
    expect(api.messages?.find((m) => m.kind === "clarify")).toMatchObject({
      unavailable: false,
    });
    act(() => {
      dashboardMock.onEvent?.({
        type: "clarify.expire",
        session_id: "other",
        payload: { request_id: "q1" },
      });
    });
    expect(api.messages?.find((m) => m.kind === "clarify")).toMatchObject({
      unavailable: false,
    });
    act(() => {
      dashboardMock.onEvent?.({
        type: "clarify.expire",
        session_id: "live",
        payload: { request_id: "q1" },
      });
    });
    expect(api.messages?.find((m) => m.kind === "clarify")).toMatchObject({
      unavailable: true,
    });
    expect(api.isLoading).toBe(true);
    expect(api.activeTurnRef?.current?.turnId).toBe("turn-bad");
    await act(async () => {
      expect(await api.respondClarify!("q1", "staging")).toBe(false);
    });
    expect(
      dashboardMock.request.mock.calls.some(
        ([method]) => method === "clarify.respond",
      ),
    ).toBe(false);
    act(() => {
      dashboardMock.onEvent?.({
        type: "message.complete",
        session_id: "live",
        payload: { text: "Continued after timeout" },
      });
    });
    expect(api.isLoading).toBe(false);
    expect(api.activeTurnRef?.current).toBeNull();
  });

  // @lat: [[dashboard-clarify#Gateway answer delivery]]
  it("delivers a clarify answer after the runtime session changed (issue #158)", async () => {
    const api = await clarifyHarness();
    // Simulate a model switch / error recovery recreating the runtime session
    // while the question is pending: the pending slot's sessionId goes stale.
    await act(async () => {
      dashboardMock.onEvent?.({
        type: "message.complete",
        session_id: "live",
        payload: { text: "Done" },
      });
      await api.send?.("next turn after model switch");
    });
    // The card must either deliver (true) or retire to unavailable (false +
    // card closed) — never a silent false leaving the card interactive forever.
    const result = await act(async () => api.respondClarify?.("q1", "staging"));
    const card = api.messages?.find((m) => m.kind === "clarify");
    expect(result === true || card?.unavailable === true).toBe(true);
  });

  // @lat: [[dashboard-clarify#Gateway answer delivery]]
  it("re-registers an unanswered clarify card from session.resume open_requests (issue #158)", async () => {
    const api: HarnessApi = {};
    // First send: session created; then the app "restarts" (new harness) and
    // resumes with the clarify request still open on the gateway.
    dashboardMock.request.mockImplementation(async (method) => {
      if (method === "session.create")
        return { session_id: "live", stored_session_id: "stored" };
      if (method === "session.resume")
        return {
          session_id: "live-2",
          stored_session_id: "stored",
          running: true,
          open_requests: [
            {
              id: "srq-replay-1",
              method: "clarify",
              params: {
                session_id: "live-2",
                request_id: "q-replay",
                question: "Where?",
                choices: ["staging"],
              },
            },
          ],
        };
      if (method === "model.options")
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      if (method === "clarify.respond") return { status: "ok" };
      return {};
    });
    render(<Harness api={api} hermesSessionId="stored" />);
    await act(async () => {
      await api.send?.("hello");
    });
    // The replayed request re-delivered through the server-request pipeline
    // must surface an answerable card with a live resolver.
    await act(async () => {
      expect(await api.respondClarify?.("q-replay", "staging")).toBe(true);
    });
    expect(api.messages?.find((m) => m.kind === "clarify")).toMatchObject({
      resolved: true,
      answer: "staging",
    });
  });

  // @lat: [[dashboard-clarify#Gateway answer delivery]]
  it("answers a server-request clarify without the legacy clarify.respond RPC (issue #158)", async () => {
    // Newer cores: clarify arrives as a server→client JSON-RPC request and the
    // gateway has NO clarify.respond method — the answer is the result frame.
    dashboardMock.request.mockImplementation(async (method) => {
      if (method === "session.create")
        return { session_id: "live", stored_session_id: "stored" };
      if (method === "model.options")
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      if (method === "clarify.respond")
        throw new Error("Method not found: clarify.respond");
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await act(async () => {
      await api.send?.("hello");
    });
    let resolved: unknown = null;
    await act(async () => {
      const answer = dashboardMock.onServerRequest?.("clarify", {
        session_id: "live",
        request_id: "q-srq",
        question: "Where?",
        choices: ["staging"],
      });
      void Promise.resolve(answer).then((result) => {
        resolved = result;
      });
    });
    // The card is interactive; answering must resolve the server request with
    // the result frame payload and never touch the dead RPC.
    await act(async () => {
      expect(await api.respondClarify?.("q-srq", "staging")).toBe(true);
    });
    expect(resolved).toEqual({ answer: "staging" });
    expect(
      dashboardMock.request.mock.calls.some(
        ([method]) => method === "clarify.respond",
      ),
    ).toBe(false);
    expect(api.messages?.find((m) => m.kind === "clarify")).toMatchObject({
      resolved: true,
      answer: "staging",
    });
  });

  // @lat: [[dashboard-clarify#Batch server-request delivery]]
  it("answers a batch server-request clarify via clarify.lock with the frame id (issue #158)", async () => {
    // Newer cores send batch clarify as a server→client request whose frame id
    // (`srq-…`) is the only request identity: answers must lock through
    // `clarify.lock {request_id, question_id}` keyed by that id, never by a
    // synthetic one.
    dashboardMock.request.mockImplementation(async (method, params) => {
      if (method === "session.create")
        return { session_id: "live", stored_session_id: "stored" };
      if (method === "model.options")
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      if (method === "clarify.lock") {
        if (params?.request_id !== "srq-live1") return { status: "expired" };
        return { status: "ok", remaining: [] };
      }
      if (method === "clarify.respond")
        throw new Error("Method not found: clarify.respond");
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await act(async () => {
      await api.send?.("hello");
    });
    let resolved: unknown = null;
    await act(async () => {
      const answer = dashboardMock.onServerRequest?.(
        "clarify",
        {
          session_id: "live",
          questions: [{ qid: "q0", question: "When?", choices: ["am", "pm"] }],
        },
        "srq-live1",
      );
      void Promise.resolve(answer).then((result) => {
        resolved = result;
      });
    });
    const card = api.messages?.find(
      (m) => m.kind === "clarify" && m.qid === "q0",
    ) as { requestId?: string } | undefined;
    expect(card?.requestId).toBe("srq-live1");
    await act(async () => {
      expect(await api.respondClarify?.("srq-live1", "am", "q0")).toBe(true);
    });
    expect(resolved).toEqual({ answers: { q0: "am" } });
    expect(
      dashboardMock.request.mock.calls.some(
        ([method, params]) =>
          method === "clarify.lock" &&
          (params as Record<string, unknown>)?.request_id === "srq-live1" &&
          (params as Record<string, unknown>)?.question_id === "q0",
      ),
    ).toBe(true);
    expect(api.messages?.find((m) => m.kind === "clarify")).toMatchObject({
      resolved: true,
      answer: "am",
    });
  });

  // @lat: [[dashboard-clarify#Composer fallback]]
  it("uses the same delivery path when answering through the composer", async () => {
    const api = await clarifyHarness();
    await act(async () => {
      await api.send?.("production");
    });
    expect(api.messages?.find((m) => m.kind === "clarify")).toMatchObject({
      resolved: true,
      answer: "production",
    });
    expect(
      dashboardMock.request.mock.calls.filter(
        ([method]) => method === "clarify.respond",
      ),
    ).toHaveLength(1);
  });

  // @lat: [[dashboard-clarify#Composer fallback]]
  it("falls back to a normal prompt send when the clarify delivery fails (issue #154)", async () => {
    const api = await clarifyHarness();
    // The clarify.respond RPC fails (request gone server-side).
    dashboardMock.request.mockImplementation(async (method) => {
      if (method === "session.create")
        return { session_id: "live", stored_session_id: "stored" };
      if (method === "model.options")
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      if (method === "clarify.respond") return { status: "expired" };
      return {};
    });
    await act(async () => {
      await api.send?.("just proceed with staging");
    });
    // The stuck pending slot was retired: the card is unavailable…
    expect(api.messages?.find((m) => m.kind === "clarify")).toMatchObject({
      unavailable: true,
    });
    // …and the message went out as a NORMAL prompt instead of being
    // swallowed by the old clarify-intercept error path.
    expect(
      dashboardMock.request.mock.calls.some(
        ([method, params]) =>
          method === "prompt.submit" &&
          typeof (params as { text?: string })?.text === "string" &&
          ((params as { text: string }).text ?? "").includes("staging"),
      ),
    ).toBe(true);
  });

  // @lat: [[dashboard-clarify#Retry and duplicate answers]]
  it("keeps a failed answer retryable and blocks concurrent card/composer replies", async () => {
    const api = await clarifyHarness();
    let reject!: (reason: Error) => void;
    dashboardMock.request.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    let first!: Promise<boolean>;
    await act(async () => {
      first = api.respondClarify!("q1", "staging");
      expect(await api.respondClarify!("q1", "production")).toBe(false);
    });
    await act(async () => {
      reject(new Error("offline"));
      expect(await first).toBe(false);
    });
    expect(api.messages?.find((m) => m.kind === "clarify")).not.toHaveProperty(
      "resolved",
      true,
    );
    await act(async () => {
      expect(await api.respondClarify!("q1", "production")).toBe(true);
    });
  });

  // @lat: [[dashboard-clarify#Expired answers]]
  it("does not report an expired RPC as a successfully delivered answer", async () => {
    const api = await clarifyHarness();
    dashboardMock.request.mockResolvedValueOnce({ status: "expired" });
    await act(async () => {
      expect(await api.respondClarify!("q1", "staging")).toBe(false);
    });
    expect(api.messages?.find((m) => m.kind === "clarify")).toMatchObject({
      unavailable: true,
    });
  });

  // @lat: [[dashboard-clarify#Connection isolation]]
  it("invalidates pending clarification cards when the connection changes", async () => {
    const api = await clarifyHarness();
    await act(async () => {
      api.setConnectionMode?.("remote");
    });
    expect(api.messages?.find((m) => m.kind === "clarify")).toMatchObject({
      unavailable: true,
    });
    await act(async () => {
      expect(await api.respondClarify!("q1", "staging")).toBe(false);
    });
    expect(
      dashboardMock.request.mock.calls.filter(
        ([method]) => method === "clarify.respond",
      ),
    ).toHaveLength(0);
  });

  // @lat: [[dashboard-clarify#Completed turns and replay]]
  it("does not reopen a completed turn's question when the request is replayed", async () => {
    const api = await clarifyHarness();
    await act(async () => {
      dashboardMock.onEvent?.({
        type: "message.complete",
        session_id: "live",
        payload: { text: "Done" },
      });
    });
    await act(async () => {
      dashboardMock.onEvent?.({
        type: "clarify.request",
        session_id: "live",
        payload: { request_id: "q1", question: "Where?", choices: ["staging"] },
      });
    });
    expect(api.messages?.find((m) => m.kind === "clarify")).toMatchObject({
      unavailable: true,
    });
    await act(async () => {
      expect(await api.respondClarify!("q1", "staging")).toBe(false);
    });
  });

  it("requests a fresh WebSocket URL immediately before connecting", async () => {
    dashboardMock.request.mockImplementation(async (method) => {
      if (method === "session.create") {
        return { session_id: "live", stored_session_id: "stored" };
      }
      return {};
    });
    const api: HarnessApi = {};
    render(
      <Harness
        api={api}
        connectionId="connection-two"
        initialConnectionMode="remote"
      />,
    );

    await act(async () => {
      await api.send?.("hello");
    });

    expect(window.hermesAPI.freshDashboardWsUrl).toHaveBeenCalledTimes(1);
    expect(window.hermesAPI.startDashboard).toHaveBeenCalledWith(
      undefined,
      "connection-two",
    );
    expect(window.hermesAPI.freshDashboardWsUrl).toHaveBeenCalledWith(
      undefined,
      "connection-two",
    );
    expect(dashboardMock.connect).toHaveBeenCalledWith("ws://fresh-dashboard");
  });

  it("does not request model.options twice when no model switch runs", async () => {
    dashboardMock.request.mockImplementation(async (method) => {
      if (method === "session.create") {
        return { session_id: "live", stored_session_id: "stored" };
      }
      if (method === "model.options") {
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      }
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} />);

    await act(async () => {
      await api.send?.("first");
      await api.send?.("second");
    });

    const methods = dashboardMock.request.mock.calls.map(([method]) => method);
    expect(methods.filter((method) => method === "slash.exec")).toHaveLength(1);
    expect(methods.filter((method) => method === "model.options")).toHaveLength(
      3,
    );
  });

  it("surfaces OAuth login requirements without legacy fallback", async () => {
    // @lat: [[remote-dashboard-oauth#Test specifications#OAuth no-fallback]]
    const onUnavailable = vi.fn();
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard: vi.fn(async () => ({
          running: false,
          needsOAuthLogin: true,
          error: "Sign in with your browser.",
          connection: { authMode: "oauth", wsUrl: "" },
        })),
      },
    });
    const api: HarnessApi = {};
    render(
      <Harness
        api={api}
        initialConnectionMode="remote"
        fallbackOnUnavailable
        onDashboardUnavailable={onUnavailable}
      />,
    );

    let handled:
      | Awaited<ReturnType<NonNullable<HarnessApi["send"]>>>
      | undefined;
    await act(async () => {
      handled = await api.send?.("hello");
    });

    expect(handled).toBe("rejected");
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // @lat: [[chat-commands#Busy refusal preserves conversation]]
  it.each(["Session busy", "Session is busy", "\tSeSsIoN   iS  BuSy \n"])(
    "preserves the saved runtime on retry after a %s completion error",
    async (error) => {
      dashboardMock.request.mockImplementation(async (method: string) => {
        if (method === "session.resume")
          return {
            session_id: "runtime-saved",
            stored_session_id: "stored-saved",
            running: false,
          };
        if (method === "session.create")
          return { session_id: "runtime-new", stored_session_id: "stored-new" };
        if (method === "model.options")
          return {
            model: "bad-model",
            provider: "bad-provider",
            providers: [],
          };
        return {};
      });
      const api: HarnessApi = {};
      render(<Harness api={api} hermesSessionId="stored-saved" />);
      await waitFor(() =>
        expect(dashboardMock.request).toHaveBeenCalledWith("subagent.list", {
          session_id: "runtime-saved",
        }),
      );
      await act(async () => {
        expect(await api.send!("refused turn")).toBe(true);
        dashboardMock.onEvent?.({
          type: "approval.request",
          session_id: "runtime-saved",
          payload: { request_id: "saved-owner-approval", choices: ["once"] },
        });
        dashboardMock.onEvent?.({
          type: "message.complete",
          session_id: "runtime-saved",
          payload: { status: "error", error },
        });
      });
      expect(api.isLoading).toBe(false);
      expect(api.activeTurnRef!.current).toBeNull();
      expect(api.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ error: error.trim() }),
        ]),
      );
      expect(
        api.messages?.find((message) => message.kind === "approval"),
      ).toMatchObject({
        requestId: "saved-owner-approval",
        unavailable: true,
      });
      expect(await api.respondApproval!("saved-owner-approval", "once")).toBe(
        false,
      );
      await act(async () => {
        api.activeTurnRef!.current = { ...activeRecoveryTurn };
        expect(await api.send!("retry turn")).toBe(true);
      });
      const calls = dashboardMock.request.mock.calls;
      expect(
        calls.filter(([method]) => method === "session.create"),
      ).toHaveLength(0);
      expect(
        calls.filter(([method]) => method === "session.close"),
      ).toHaveLength(0);
      expect(calls.filter(([method]) => method === "session.resume")).toEqual([
        ["session.resume", { session_id: "stored-saved", cols: 96 }],
      ]);
      expect(
        calls
          .filter(([method]) => method === "prompt.submit")
          .map(([, params]) => params.session_id),
      ).toEqual(["runtime-saved", "runtime-saved"]);
      expect(
        calls.filter(([method]) => method === "model.options"),
      ).toHaveLength(4);
      expect(
        calls.filter(([method]) => method === "session.interrupt"),
      ).toHaveLength(0);
    },
  );

  it.each([
    { error: "Invalid API Key" },
    { error: "Error code: 503 - provider session is busy" },
    { text: "Error code: 503 - provider session is busy" },
    { rendered: "Error code: 503 - provider session is busy" },
    { error: "Session is busy processing a provider request" },
  ])("recreates runtime after provider failure %j", async (failure) => {
    const error = failure.error || failure.text || failure.rendered!;
    const requests: Array<{ method: string; params: unknown }> = [];
    let liveModel = "bad-model";
    let liveProvider = "bad-provider";
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.create") {
        return { session_id: "live-bad", stored_session_id: "stored-chat" };
      }
      if (method === "session.resume") {
        return { session_id: "live-recovery", resumed: "stored-chat" };
      }
      if (method === "slash.exec") {
        const command =
          params && typeof params === "object" && "command" in params
            ? String(params.command)
            : "";
        const match = command.match(/^\/model\s+(.+?)\s+--provider\s+(.+)$/);
        if (match) {
          liveModel = match[1];
          liveProvider = match[2];
        }
        return {};
      }
      if (method === "model.options") {
        return { model: liveModel, provider: liveProvider, providers: [] };
      }
      return {};
    });

    const api: HarnessApi = {};
    render(<Harness api={api} />);

    await act(async () => {
      await api.send?.("bad provider turn");
    });

    await act(async () => {
      dashboardMock.onEvent?.({
        payload: {
          ...failure,
          status: "error",
        },
        session_id: "live-bad",
        type: "message.complete",
      });
    });

    const badSend = api.send;
    await act(async () => {
      api.setProvider?.("good-provider");
      api.setModel?.("good-model");
      api.activeTurnRef!.current = { ...activeRecoveryTurn };
      api.setMessages?.((prev) => [
        ...prev,
        {
          id: "u-recovery",
          role: "user",
          content: "recovery turn",
          turnId: "turn-recovery",
        },
      ]);
    });
    await waitFor(() => expect(api.send).not.toBe(badSend));

    await act(async () => {
      await api.send?.("recovery turn");
    });

    expect(requests).not.toContainEqual({
      method: "session.resume",
      params: { session_id: "stored-chat", cols: 96 },
    });
    expect(
      requests.filter((request) => request.method === "session.create"),
    ).toEqual([
      { method: "session.create", params: { cols: 96 } },
      { method: "session.create", params: { cols: 96 } },
    ]);
    expect(requests).not.toContainEqual({
      method: "session.create",
      params: {
        cols: 96,
        messages: [
          { role: "user", content: "bad provider turn" },
          { role: "assistant", content: `Error: ${error}` },
        ],
      },
    });
    expect(window.hermesAPI.recordSessionLocalError).toHaveBeenCalledWith(
      "stored-chat",
      {
        error,
        userContent: "bad provider turn",
      },
    );
    expect(window.hermesAPI.recordSessionContinuation).toHaveBeenCalledWith(
      "stored-chat",
      [
        { kind: "user", content: "bad provider turn" },
        {
          kind: "assistant",
          content: failure.text || failure.rendered || "",
          error,
        },
      ],
    );
  });

  it("discards an in-flight dashboard client after the connection mode changes", async () => {
    let releaseFirstConnect: (() => void) | null = null;
    const requests: Array<{ method: string; params: unknown }> = [];

    dashboardMock.connect
      .mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            releaseFirstConnect = () => resolve(undefined);
          }),
      )
      .mockImplementation(async () => undefined);
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.create") {
        return { session_id: "live-new", stored_session_id: "stored-new" };
      }
      if (method === "model.options") {
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      }
      return {};
    });

    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard: vi
          .fn()
          .mockResolvedValueOnce({
            connection: { wsUrl: "ws://old-dashboard" },
            running: true,
          })
          .mockResolvedValue({
            connection: { wsUrl: "ws://new-dashboard" },
            running: true,
          }),
      },
    });

    const api: HarnessApi = {};
    render(<Harness api={api} />);

    let firstSend: ReturnType<NonNullable<HarnessApi["send"]>> | null = null;
    await act(async () => {
      firstSend = api.send?.("first prompt") ?? null;
    });
    await waitFor(() =>
      expect(window.hermesAPI.startDashboard).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      api.setConnectionMode?.("remote");
    });

    await act(async () => {
      releaseFirstConnect?.();
      await firstSend;
    });

    expect(dashboardMock.close).toHaveBeenCalled();

    await act(async () => {
      api.activeTurnRef!.current = {
        startIndex: api.messages?.length ?? 0,
        status: "running",
        turnId: "turn-new",
        userId: "u-new",
      };
      api.setMessages?.((prev) => [
        ...prev,
        {
          id: "u-new",
          role: "user",
          content: "new prompt",
          turnId: "turn-new",
        },
      ]);
    });

    await act(async () => {
      await api.send?.("new prompt");
    });

    expect(dashboardMock.connect).toHaveBeenNthCalledWith(
      1,
      "ws://old-dashboard",
    );
    expect(dashboardMock.connect).toHaveBeenNthCalledWith(
      2,
      "ws://new-dashboard",
    );
    expect(requests.map((request) => request.method)).toContain(
      "prompt.submit",
    );
  });
});

describe("useDashboardChatTransport approvals", () => {
  beforeEach(() => {
    dashboardMock.close.mockClear();
    dashboardMock.connect.mockClear();
    dashboardMock.instances.length = 0;
    dashboardMock.onEvent = null;
    dashboardMock.request.mockReset();
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.create") {
        return { session_id: "live-1", stored_session_id: "stored-1" };
      }
      if (method === "model.options")
        return { provider: "bad-provider", model: "bad-model" };
      if (method === "approval.respond") return { resolved: 1 };
      return {};
    });
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard: vi.fn(async () => ({
          connection: { wsUrl: "ws://127.0.0.1:12345" },
          running: true,
        })),
      },
    });
  });

  afterEach(() => vi.clearAllMocks());

  // @lat: [[chat-commands#Busy refusal approval cleanup]]
  it.each([
    ["Session busy", 0],
    ["Session is busy", 0],
    ["\tSeSsIoN   iS  BuSy \n", 0],
    ["Invalid API Key", 1],
    ["Error code: 503 - provider session is busy", 1],
    ["Session is busy processing a provider request", 1],
  ] as const)(
    "expires approvals after RPC rejection %s with %i owner interruptions",
    async (error, interruptions) => {
      const api: HarnessApi = {};
      const normalRequest = dashboardMock.request.getMockImplementation()!;
      let rejectTurn = true;
      dashboardMock.request.mockImplementation(async (method, params) => {
        if (method === "session.resume")
          return {
            session_id: "live-1",
            stored_session_id: "stored-1",
            running: false,
          };
        if (method === "prompt.submit" && rejectTurn) {
          dashboardMock.onEvent?.({
            type: "approval.request",
            session_id: "live-1",
            payload: { request_id: "owner-approval", choices: ["once"] },
          });
          throw Object.assign(new Error(error), { rpcRejected: true });
        }
        return normalRequest(method, params);
      });
      render(<Harness api={api} hermesSessionId="stored-1" />);
      await waitFor(() =>
        expect(dashboardMock.request).toHaveBeenCalledWith("subagent.list", {
          session_id: "live-1",
        }),
      );
      await act(async () => {
        expect(await api.send!("refused turn")).toBe("rejected");
      });
      expect(
        api.messages?.find((message) => message.kind === "approval"),
      ).toMatchObject({
        requestId: "owner-approval",
        unavailable: true,
      });
      expect(await api.respondApproval!("owner-approval", "once")).toBe(false);
      expect(api.activeTurnRef!.current).toBeNull();
      expect(api.isLoading).toBe(false);
      const calls = dashboardMock.request.mock.calls;
      expect(
        calls.filter(([method]) => method === "session.interrupt"),
      ).toHaveLength(interruptions);
      expect(
        calls.filter(([method]) => method === "approval.respond"),
      ).toHaveLength(0);
      rejectTurn = false;
      await act(async () => {
        api.activeTurnRef!.current = { ...activeRecoveryTurn };
        expect(await api.send!("explicit retry")).toBe(true);
      });
      expect(
        calls.filter(([method]) => method === "session.create"),
      ).toHaveLength(0);
      expect(
        calls.filter(([method]) => method === "session.close"),
      ).toHaveLength(0);
      expect(calls.filter(([method]) => method === "session.resume")).toEqual([
        ["session.resume", { session_id: "stored-1", cols: 96 }],
      ]);
      expect(
        calls
          .filter(([method]) => method === "model.options")
          .map(([, params]) => params.session_id),
      ).toEqual(["live-1", "live-1", "live-1"]);
      expect(
        calls
          .filter(([method]) => method === "prompt.submit")
          .map(([, params]) => params.session_id),
      ).toEqual(["live-1", "live-1"]);
    },
  );

  it("responds only to the pending offered choice and clears after ack", async () => {
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await act(async () => {
      await api.send?.("hello");
      dashboardMock.onEvent?.({
        type: "approval.request",
        session_id: "live-1",
        payload: {
          request_id: "approval-1",
          command: "npm publish",
          choices: ["once"],
        },
      });
    });

    await expect(api.respondApproval?.("approval-1", "always")).resolves.toBe(
      false,
    );
    await expect(api.respondApproval?.("approval-1", "once")).resolves.toBe(
      true,
    );
    expect(dashboardMock.request).toHaveBeenCalledWith("approval.respond", {
      session_id: "live-1",
      request_id: "approval-1",
      choice: "once",
      all: false,
    });
    await expect(api.respondApproval?.("approval-1", "once")).resolves.toBe(
      false,
    );
  });

  it("keeps a failed response pending for retry", async () => {
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await act(async () => {
      await api.send?.("hello");
      dashboardMock.onEvent?.({
        type: "approval.request",
        session_id: "live-1",
        payload: { request_id: "approval-2", choices: ["deny"] },
      });
    });
    dashboardMock.request.mockRejectedValueOnce(new Error("offline"));

    await expect(api.respondApproval?.("approval-2", "deny")).resolves.toBe(
      false,
    );
    dashboardMock.request.mockResolvedValueOnce({ resolved: 1 });
    await expect(api.respondApproval?.("approval-2", "deny")).resolves.toBe(
      true,
    );
  });

  // @lat: [[chat-commands#Structured command approvals#Stale approval isolation]]
  it.each(["expired", "lost acknowledgement"])(
    "never applies a %s approval to the next queued command",
    async (failure) => {
      const api: HarnessApi = {};
      const serverPending = new Set(["first", "second"]);
      const approved: string[] = [];
      let loseAck = failure === "lost acknowledgement";
      render(<Harness api={api} />);
      await act(async () => {
        await api.send?.("hello");
        for (const request_id of serverPending) {
          dashboardMock.onEvent?.({
            type: "approval.request",
            session_id: "live-1",
            payload: { request_id, choices: ["once"] },
          });
        }
      });
      if (failure === "expired") serverPending.delete("first");
      dashboardMock.request.mockImplementation(
        async (method: string, params: Record<string, unknown>) => {
          if (method !== "approval.respond") return {};
          // Match the upstream resolver: omitting request_id consumes the FIFO head.
          const target = String(
            params.request_id ?? serverPending.values().next().value,
          );
          if (!serverPending.delete(target)) return { resolved: 0 };
          approved.push(target);
          if (loseAck) {
            loseAck = false;
            throw new Error("acknowledgement lost");
          }
          return { resolved: 1 };
        },
      );
      await act(async () => {
        expect(await api.respondApproval?.("first", "once")).toBe(false);
        if (failure === "lost acknowledgement")
          expect(await api.respondApproval?.("first", "once")).toBe(false);
      });
      expect(serverPending.has("second")).toBe(true);
      expect(approved).not.toContain("second");
      expect(dashboardMock.request).toHaveBeenCalledWith("session.interrupt", {
        session_id: "live-1",
      });
      expect(await api.respondApproval?.("second", "once")).toBe(false);
      expect(
        api.messages
          ?.filter((msg) => msg.kind === "approval")
          .every((msg) => msg.kind === "approval" && msg.unavailable),
      ).toBe(true);
    },
  );

  it("stops an approval that has no gateway-issued request ID", async () => {
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await act(async () => {
      await api.send?.("hello");
      dashboardMock.onEvent?.({
        type: "approval.request",
        session_id: "live-1",
        payload: { id: "display-only", command: "npm publish" },
      });
    });
    expect(await api.respondApproval?.("display-only", "once")).toBe(false);
    expect(dashboardMock.request).toHaveBeenCalledWith("session.interrupt", {
      session_id: "live-1",
    });
    expect(
      dashboardMock.request.mock.calls.some(
        ([method]) => method === "approval.respond",
      ),
    ).toBe(false);
  });

  it("does not recover and replay after an approval precedes a missing-session error", async () => {
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.create")
        return { session_id: "live-1", stored_session_id: "stored-1" };
      if (method === "model.options")
        return { provider: "bad-provider", model: "bad-model" };
      if (method === "prompt.submit") {
        dashboardMock.onEvent?.({
          type: "approval.request",
          session_id: "live-1",
          payload: { request_id: "before-ack", choices: ["once"] },
        });
        throw new Error("session not found");
      }
      return {};
    });
    await act(async () => {
      await api.send?.("hello");
    });
    expect(
      dashboardMock.request.mock.calls.filter(
        ([method]) => method === "prompt.submit",
      ),
    ).toHaveLength(1);
    expect(
      dashboardMock.request.mock.calls.some(
        ([method]) => method === "session.resume",
      ),
    ).toBe(false);
  });

  it("clears pending approval on completion and abort", async () => {
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await act(async () => {
      await api.send?.("hello");
      dashboardMock.onEvent?.({
        type: "approval.request",
        session_id: "live-1",
        payload: { request_id: "approval-3", choices: ["once"] },
      });
      dashboardMock.onEvent?.({
        type: "message.complete",
        session_id: "live-1",
        payload: { text: "complete" },
      });
    });

    expect(
      api.messages?.find(
        (msg) => msg.kind === "approval" && msg.requestId === "approval-3",
      ),
    ).toMatchObject({ unavailable: true });
    await expect(api.respondApproval?.("approval-3", "once")).resolves.toBe(
      false,
    );

    await act(async () => {
      dashboardMock.onEvent?.({
        type: "approval.request",
        session_id: "live-1",
        payload: { request_id: "approval-4", choices: ["once"] },
      });
      api.abort?.();
    });
    await expect(api.respondApproval?.("approval-4", "once")).resolves.toBe(
      false,
    );
  });

  it("presents queued approvals in arrival order", async () => {
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await act(async () => {
      await api.send?.("hello");
      dashboardMock.onEvent?.({
        type: "approval.request",
        session_id: "live-1",
        payload: { request_id: "approval-first", choices: ["deny"] },
      });
      dashboardMock.onEvent?.({
        type: "approval.request",
        session_id: "live-1",
        payload: { request_id: "approval-second", choices: ["once"] },
      });
    });

    await expect(
      api.respondApproval?.("approval-second", "once"),
    ).resolves.toBe(false);
    await expect(api.respondApproval?.("approval-first", "deny")).resolves.toBe(
      true,
    );
    await expect(
      api.respondApproval?.("approval-second", "once"),
    ).resolves.toBe(true);
  });
});

describe("binary attachment Auto transport safety", () => {
  const binary = {
    id: "binary",
    kind: "path-ref" as const,
    name: "report.zip",
    mime: "application/octet-stream",
    size: 6,
    dataUrl: "data:application/octet-stream;base64,AP9QSwAB",
  };

  beforeEach(() => {
    dashboardMock.request.mockReset();
    dashboardMock.connect.mockReset().mockResolvedValue(undefined);
    dashboardMock.request.mockImplementation(
      async (method: string): Promise<unknown> => {
        if (method === "session.create")
          return {
            session_id: "runtime-binary",
            stored_session_id: "stored-binary",
          };
        if (method === "model.options")
          return { provider: "bad-provider", model: "bad-model" };
        if (method === "file.attach")
          return { attached: true, ref_text: "@file:/server/report.zip" };
        return {};
      },
    );
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        startDashboard: vi.fn(async () => ({
          running: true,
          connection: { wsUrl: "ws://binary-dashboard" },
        })),
      },
    });
  });

  it("submits the returned server ref with no client path or inline binary", async () => {
    const api: HarnessApi = {};
    render(
      <Harness
        api={api}
        initialConnectionMode="remote"
        fallbackOnUnavailable
      />,
    );
    await act(async () => {
      expect(
        await api.send?.("inspect", [
          { ...binary, path: "/Users/private/report.zip" },
        ]),
      ).toBe(true);
    });
    expect(dashboardMock.request).toHaveBeenCalledWith("file.attach", {
      session_id: "runtime-binary",
      name: "report.zip",
      data_url: binary.dataUrl,
    });
    expect(dashboardMock.request).toHaveBeenCalledWith(
      "prompt.submit",
      expect.objectContaining({
        session_id: "runtime-binary",
        text: "@file:/server/report.zip\n\ninspect",
      }),
    );
    expect(JSON.stringify(dashboardMock.request.mock.calls)).not.toContain(
      "/Users/private",
    );
  });

  it.each([
    "startup",
    "invalid-binary",
    "unhandled-image",
    "sync-unhandled",
    "unsupported",
    "upload-error",
    "upload-rejected",
    "missing-ref",
  ])(
    "rejects instead of falling back or submitting without the file: %s",
    async (failure) => {
      const attachments: Attachment[] = [{ ...binary }];
      if (failure === "startup") {
        Object.defineProperty(window, "hermesAPI", {
          configurable: true,
          value: {
            startDashboard: vi.fn(async () => ({
              running: false,
              error: "Dashboard unavailable",
            })),
          },
        });
      }
      if (failure === "invalid-binary")
        attachments[0].dataUrl = "not a data URL";
      if (failure === "unhandled-image")
        attachments.push({ ...binary, kind: "image", dataUrl: "broken" });
      if (failure === "sync-unhandled")
        attachments.push({
          ...binary,
          kind: "image",
          dataUrl: "data:image/png;base64,AAA=",
        });
      const normalRequest = dashboardMock.request.getMockImplementation()!;
      dashboardMock.request.mockImplementation(
        async (method: string, params: unknown): Promise<unknown> => {
          // Change after prompt validation to exercise sync's handled:false boundary.
          if (failure === "sync-unhandled" && method === "model.options")
            attachments[1].dataUrl = "broken";
          if (method === "file.attach") {
            if (failure === "unsupported")
              throw new Error("unknown method file.attach");
            if (failure === "upload-error") throw new Error("disk full");
            if (failure === "upload-rejected")
              return { attached: false, message: "Upload rejected" };
            if (failure === "missing-ref") return { attached: true };
          }
          return normalRequest(method, params);
        },
      );
      const api: HarnessApi = {};
      render(
        <Harness
          api={api}
          initialConnectionMode="remote"
          fallbackOnUnavailable
        />,
      );
      await act(async () => {
        expect(await api.send?.("inspect", attachments)).toBe("rejected");
      });
      expect(
        dashboardMock.request.mock.calls.some(
          ([method]) => method === "prompt.submit",
        ),
      ).toBe(false);
      expect(
        api.messages?.some((message) => "error" in message && !!message.error),
      ).toBe(true);
    },
  );
});

describe("useDashboardChatTransport unavailable fallback (issue #667)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function mockStartDashboard(): ReturnType<typeof vi.fn> {
    const startDashboard = vi.fn(async () => ({
      running: false,
      error: "Hermes dashboard chat WebSocket is unavailable (404)",
    }));
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard,
      },
    });
    return startDashboard;
  }

  it("latches unavailable on SSH and fails fast on later sends, notifying once", async () => {
    const startDashboard = mockStartDashboard();
    const onUnavailable = vi.fn();
    const api: HarnessApi = {};
    render(
      <Harness
        api={api}
        initialConnectionMode="ssh"
        fallbackOnUnavailable
        onDashboardUnavailable={onUnavailable}
      />,
    );

    let first: Awaited<ReturnType<NonNullable<HarnessApi["send"]>>> | undefined;
    await act(async () => {
      first = await api.send?.("hello");
    });
    // Dashboard unavailable → caller falls back to legacy (returns false).
    expect(first).toBe(false);
    expect(startDashboard).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledTimes(1);

    let second:
      | Awaited<ReturnType<NonNullable<HarnessApi["send"]>>>
      | undefined;
    await act(async () => {
      second = await api.send?.("again");
    });
    expect(second).toBe(false);
    // Fast path: no second status/probe round-trip, no duplicate notice.
    expect(startDashboard).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("re-probes after the connection changes", async () => {
    const startDashboard = mockStartDashboard();
    const api: HarnessApi = {};
    render(
      <Harness api={api} initialConnectionMode="ssh" fallbackOnUnavailable />,
    );

    await act(async () => {
      await api.send?.("hello");
    });
    expect(startDashboard).toHaveBeenCalledTimes(1);

    // Switching connection clears the sticky flag → the dashboard is retried.
    await act(async () => {
      api.setConnectionMode?.("remote");
    });
    await act(async () => {
      await api.send?.("after change");
    });
    expect(startDashboard).toHaveBeenCalledTimes(2);
  });

  it("re-probes after the selected connection is edited in place", async () => {
    const startDashboard = mockStartDashboard();
    const api: HarnessApi = {};
    const { rerender } = render(
      <Harness
        api={api}
        connectionId="connection-a"
        connectionRevision={0}
        initialConnectionMode="ssh"
        fallbackOnUnavailable
      />,
    );

    await act(async () => {
      await api.send?.("hello");
    });
    expect(startDashboard).toHaveBeenCalledTimes(1);

    rerender(
      <Harness
        api={api}
        connectionId="connection-a"
        connectionRevision={1}
        initialConnectionMode="ssh"
        fallbackOnUnavailable
      />,
    );
    await act(async () => {
      await api.send?.("after edit");
    });
    expect(startDashboard).toHaveBeenCalledTimes(2);
  });

  // @lat: [[dashboard-detach#Teardown retires a running turn]]
  it("retires a running turn when the transport is torn down (issue #76)", async () => {
    const api: HarnessApi = {};
    const { rerender } = render(
      <Harness api={api} connectionId="connection-a" connectionRevision={0} />,
    );

    // A running turn: activeTurnRef holds a running turn (the harness seeds
    // one) — a revision bump is the connection-switch teardown.
    expect(api.activeTurnRef?.current?.status).toBe("running");
    expect(api.isLoading).toBe(false);

    rerender(
      <Harness api={api} connectionId="connection-a" connectionRevision={1} />,
    );

    // The turn is retired: no dangling active turn, spinner cleared, and a
    // user-facing marker explains the agent keeps running server-side.
    expect(api.activeTurnRef?.current).toBeNull();
    const marker = api.messages?.find(
      (m) => "content" in m && m.content.includes("continues on the agent"),
    );
    expect(marker).toBeDefined();
  });

  it("seeds the run state when session.resume reports a still-running turn (issue #109)", async () => {
    // @lat: [[dashboard-detach#Run-state seeding from session.resume (issue #109)]]
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.resume") {
        return {
          session_id: "live-resumed",
          resumed: "stored-open",
          running: true,
          status: "streaming",
        };
      }
      return {};
    });
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        freshDashboardWsUrl: vi.fn(async () => "ws://fresh-dashboard"),
        getSessionMessages: vi.fn(async () => []),
        startDashboard: vi.fn(async () => ({
          connection: { wsUrl: "ws://127.0.0.1:12345" },
          running: true,
        })),
      },
    });

    const api: HarnessApi = {};
    render(<Harness api={api} hermesSessionId="stored-open" />);

    // Opening a chat whose stored session still runs server-side: no local
    // turn exists (the renderer lost it), and the resync's resume seeds the
    // spinner/Stop state from the backend's `running` flag.
    const turnRef = api.activeTurnRef as MutableRefObject<ActiveTurn | null>;
    turnRef.current = null;
    // Read through a thunk: TS narrows `current` to null after the assignment
    // above and never widens it again across the awaited act() boundary.
    const turnStatus = (): string | undefined => turnRef.current?.status;
    await act(async () => {
      await api.resyncAfterDetach?.();
    });
    expect(turnRef.current).not.toBeNull();
    expect(turnStatus()).toBe("running");
    expect(api.isLoading).toBe(true);
    expect(
      dashboardMock.request.mock.calls.some(
        ([method]) => method === "session.resume",
      ),
    ).toBe(true);
  });

  it("leaves the state alone when the resumed turn has finished (issue #109)", async () => {
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.resume") {
        return {
          session_id: "live-resumed",
          resumed: "stored-done",
          running: false,
          status: "idle",
        };
      }
      return {};
    });
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        freshDashboardWsUrl: vi.fn(async () => "ws://fresh-dashboard"),
        getSessionMessages: vi.fn(async () => []),
        startDashboard: vi.fn(async () => ({
          connection: { wsUrl: "ws://127.0.0.1:12345" },
          running: true,
        })),
      },
    });

    const api: HarnessApi = {};
    render(<Harness api={api} hermesSessionId="stored-done" />);

    const doneTurnRef =
      api.activeTurnRef as MutableRefObject<ActiveTurn | null>;
    doneTurnRef.current = null;
    await act(async () => {
      await api.resyncAfterDetach?.();
    });
    expect(doneTurnRef.current).toBeNull();
    expect(api.isLoading).toBe(false);
  });

  it("restores the run state after an accidental WebSocket drop (issue #109)", async () => {
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.create") {
        return { session_id: "live-drop", stored_session_id: "stored-drop" };
      }
      if (method === "session.resume") {
        return {
          session_id: "live-drop",
          resumed: "stored-drop",
          running: true,
          status: "streaming",
        };
      }
      return {};
    });
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        freshDashboardWsUrl: vi.fn(async () => "ws://fresh-dashboard"),
        getSessionMessages: vi.fn(async () => []),
        startDashboard: vi.fn(async () => ({
          connection: { wsUrl: "ws://127.0.0.1:12345" },
          running: true,
        })),
      },
    });

    const api: HarnessApi = {};
    render(<Harness api={api} hermesSessionId="stored-drop" />);

    // A send establishes the WS client (with its onClose hook) so the drop
    // path below runs against a connected client; Chat.tsx seeds the local
    // active turn around its send, so mirror that here.
    const dropTurnRef =
      api.activeTurnRef as MutableRefObject<ActiveTurn | null>;
    await act(async () => {
      await api.send?.("drop me mid-turn");
      dropTurnRef.current = { ...activeBadTurn };
    });
    expect(dropTurnRef.current).not.toBeNull();

    // Simulate the socket dropping mid-turn: retireDetachedTurn clears the
    // UI state and the 1.5s probe re-resumes — the backend reports the turn
    // still running, so the spinner/Stop state is restored.
    await act(async () => {
      dashboardMock.onClose?.();
    });
    expect(dropTurnRef.current).toBeNull();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1700));
    });
    const dropStatus = (): string | undefined => dropTurnRef.current?.status;
    expect(dropTurnRef.current).not.toBeNull();
    expect(dropStatus()).toBe("running");
    expect(api.isLoading).toBe(true);
  });

  it("leaves the transcript alone when no turn is running at teardown", async () => {
    const api: HarnessApi = {};
    const { rerender } = render(
      <Harness api={api} connectionId="connection-a" connectionRevision={0} />,
    );

    api.activeTurnRef!.current = null;
    const before = api.messages?.length ?? 0;
    rerender(
      <Harness api={api} connectionId="connection-a" connectionRevision={1} />,
    );

    expect(api.messages?.length ?? 0).toBe(before);
    expect(
      api.messages?.some(
        (m) => "content" in m && m.content.includes("continues on the agent"),
      ),
    ).toBe(false);
  });

  it("keeps retrying on local (does not latch)", async () => {
    const startDashboard = mockStartDashboard();
    const api: HarnessApi = {};
    render(
      <Harness api={api} initialConnectionMode="local" fallbackOnUnavailable />,
    );

    await act(async () => {
      await api.send?.("hello");
    });
    await act(async () => {
      await api.send?.("again");
    });
    // Local dashboard may still be spawning, so each send re-checks.
    expect(startDashboard).toHaveBeenCalledTimes(2);
  });
});

describe("useDashboardChatTransport messagesRef sync", () => {
  beforeEach(() => {
    dashboardMock.close.mockClear();
    dashboardMock.connect.mockClear();
    dashboardMock.instances.length = 0;
    dashboardMock.onEvent = null;
    dashboardMock.request.mockReset();
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard: vi.fn(async () => ({
          connection: { wsUrl: "ws://127.0.0.1:12345" },
          running: true,
        })),
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // `background.complete` appends an agent bubble built from `messagesRef.current`,
  // so it reads exactly the array the sync effect maintains — a clean probe for
  // whether the ref adopted an external Chat-state change. It requires a live
  // gateway client, so every test connects with one `send` first (which does not
  // append a user bubble — Chat owns that).
  const connect = async (api: HarnessApi): Promise<void> => {
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.create") {
        return { session_id: "live-1", stored_session_id: "stored-1" };
      }
      return {};
    });
    await act(async () => {
      await api.send?.("hello");
    });
    expect(dashboardMock.onEvent).toBeTypeOf("function");
  };

  const backgroundComplete = async (): Promise<void> => {
    await act(async () => {
      dashboardMock.onEvent?.({
        payload: { task_id: "t1", text: "bg answer" },
        type: "background.complete",
      });
    });
  };

  it("adopts an external clear so a new turn does not resurrect deleted messages (#757)", async () => {
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await connect(api);

    // Chat's `handleClear` empties the list without unmounting <Chat>. A length
    // guard (`messages.length > ref.length`) would skip this and leave the ref
    // pointing at the deleted turn, so the next event would append onto it.
    await act(async () => {
      api.setMessages?.([]);
    });
    await backgroundComplete();

    expect(api.messages).toHaveLength(1);
    expect(api.messages?.[0]?.id).toBe("bg-t1");
  });

  it("adopts a same-length in-place replacement (clarify resolve / edit)", async () => {
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await connect(api);

    // Same length, different content — mirrors `handleClarifyResolved` mapping a
    // clarify card to resolved before the gateway resumes the turn.
    await act(async () => {
      api.setMessages?.([
        { id: "u-edited", role: "user", content: "edited turn" },
      ]);
    });
    await backgroundComplete();

    expect(api.messages).toHaveLength(2);
    expect(api.messages?.[0]?.id).toBe("u-edited");
    expect(api.messages?.[1]?.id).toBe("bg-t1");
  });
});

describe("useDashboardChatTransport context gauge estimate (no usage payload)", () => {
  beforeEach(() => {
    dashboardMock.close.mockClear();
    dashboardMock.connect.mockClear();
    dashboardMock.instances.length = 0;
    dashboardMock.onEvent = null;
    dashboardMock.request.mockReset();
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.create") {
        return { session_id: "live-1", stored_session_id: "stored-1" };
      }
      return {};
    });
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard: vi.fn(async () => ({
          connection: { wsUrl: "ws://127.0.0.1:12345" },
          running: true,
        })),
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Resolve the final usage object a setUsage((prev) => next) call produces.
  const lastUsage = (setUsage: SetUsageMock): UsageState | null => {
    expect(setUsage).toHaveBeenCalled();
    const updater = setUsage.mock.calls.at(-1)?.[0];
    if (typeof updater !== "function") {
      throw new Error("setUsage was not called with an updater function");
    }
    return updater(null);
  };

  it("sets an estimated contextTokens when a successful completion has no usage", async () => {
    const setUsage = vi.fn() as SetUsageMock;
    const api: HarnessApi = {};
    render(<Harness api={api} setUsage={setUsage} />);
    await act(async () => {
      await api.send?.("hello");
    });

    // Provider omitted usage entirely → usageFromPayload returns null. The
    // gauge only renders when contextTokens is set, so the estimate must fill
    // it in — this was the case the gauge went blank on (#789).
    await act(async () => {
      dashboardMock.onEvent?.({
        payload: { status: "completed", final_response: "hi there" },
        session_id: "live-1",
        type: "message.complete",
      });
    });

    const usage = lastUsage(setUsage);
    expect(usage?.contextTokens).toBeGreaterThan(0);
  });

  it("prefers exact payload usage over the estimate", async () => {
    const setUsage = vi.fn() as SetUsageMock;
    const api: HarnessApi = {};
    render(<Harness api={api} setUsage={setUsage} />);
    await act(async () => {
      await api.send?.("hello");
    });

    await act(async () => {
      dashboardMock.onEvent?.({
        payload: {
          status: "completed",
          final_response: "hi there",
          usage: { input: 5000, output: 200, context_used: 45000 },
        },
        session_id: "live-1",
        type: "message.complete",
      });
    });

    const usage = lastUsage(setUsage);
    expect(usage?.contextTokens).toBe(45000);
  });

  it("does not fabricate usage for a failed turn without usage", async () => {
    const setUsage = vi.fn() as SetUsageMock;
    const api: HarnessApi = {};
    render(<Harness api={api} setUsage={setUsage} />);
    await act(async () => {
      await api.send?.("hello");
    });

    await act(async () => {
      dashboardMock.onEvent?.({
        payload: { status: "error", error: "Invalid API Key" },
        session_id: "live-1",
        type: "message.complete",
      });
    });

    expect(setUsage).not.toHaveBeenCalled();
  });
});

describe("useDashboardChatTransport delta coalescing", () => {
  beforeEach(() => {
    dashboardMock.close.mockClear();
    dashboardMock.connect.mockClear();
    dashboardMock.instances.length = 0;
    dashboardMock.onEvent = null;
    dashboardMock.request.mockReset();
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.create") {
        return { session_id: "live-1", stored_session_id: "stored-1" };
      }
      return {};
    });
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard: vi.fn(async () => ({
          connection: { wsUrl: "ws://127.0.0.1:12345" },
          running: true,
        })),
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("coalesces a burst of message.delta into one commit without losing text", async () => {
    // Capture rAF callbacks so the frame boundary is under test control.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);

    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await act(async () => {
      await api.send?.("hello");
    });

    // A burst of deltas inside one frame: transcript state must not commit yet
    // (schedule exactly one frame callback), but no delta text may be lost.
    await act(async () => {
      dashboardMock.onEvent?.({
        payload: {},
        session_id: "live-1",
        type: "message.start",
      });
      for (const chunk of ["a", "b", "c", "d", "e"]) {
        dashboardMock.onEvent?.({
          payload: { text: chunk },
          session_id: "live-1",
          type: "message.delta",
        });
      }
    });
    expect(frames).toHaveLength(1);

    // Frame fires → exactly one commit carrying the full accumulated text.
    await act(async () => {
      frames[0](0);
    });
    // The streamed bubble is the trailing message (the harness may add a
    // model-mismatch error bubble before it — unrelated to coalescing).
    const last = api.messages?.[api.messages.length - 1] as
      | { role?: string; content?: string }
      | undefined;
    expect(last?.role).toBe("agent");
    expect(last?.content).toBe("abcde");
  });

  it("message.complete flushes immediately, superseding a pending frame", async () => {
    const frames: FrameRequestCallback[] = [];
    const cancelled: number[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (h: number) => {
      cancelled.push(h);
    });

    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await act(async () => {
      await api.send?.("hello");
    });

    await act(async () => {
      dashboardMock.onEvent?.({
        payload: {},
        session_id: "live-1",
        type: "message.start",
      });
      dashboardMock.onEvent?.({
        payload: { text: "partial" },
        session_id: "live-1",
        type: "message.delta",
      });
      // Terminal event arrives before the frame: it must commit synchronously
      // and cancel the queued flush.
      dashboardMock.onEvent?.({
        payload: { text: "partial and done" },
        session_id: "live-1",
        type: "message.complete",
      });
    });

    expect(cancelled).toHaveLength(1);
    const last = api.messages?.[api.messages.length - 1] as
      | { role?: string; content?: string }
      | undefined;
    expect(last?.role).toBe("agent");
    expect(last?.content).toBe("partial and done");

    // A stale frame firing later must not resurrect the pre-complete state.
    await act(async () => {
      frames.forEach((cb) => cb(0));
    });
    const lastAfter = api.messages?.[api.messages.length - 1] as
      | { content?: string }
      | undefined;
    expect(lastAfter?.content).toBe("partial and done");
  });

  it("keeps pending deltas when a functional writer lands mid-frame", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);

    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await act(async () => {
      await api.send?.("hello");
    });

    await act(async () => {
      dashboardMock.onEvent?.({
        payload: {},
        session_id: "live-1",
        type: "message.start",
      });
      dashboardMock.onEvent?.({
        payload: { text: "alpha" },
        session_id: "live-1",
        type: "message.delta",
      });
      dashboardMock.onEvent?.({
        payload: { text: "beta" },
        session_id: "live-1",
        type: "message.delta",
      });
    });

    // Before the coalesced frame commits, a functional writer (the `/btw`
    // side-question path) appends a bubble. It must build on the streamed
    // deltas held in the transcript ref — not fork from the stale committed
    // state and drop them.
    await act(async () => {
      api.setMessages?.((prev) => [
        ...prev,
        { id: "side-q", role: "user", content: "btw question" } as ChatMessage,
      ]);
    });
    const afterAppend = api.messages ?? [];
    expect(afterAppend[afterAppend.length - 1]?.id).toBe("side-q");
    expect(
      (afterAppend[afterAppend.length - 2] as { content?: string }).content,
    ).toBe("alphabeta");

    // The pending frame then fires: it republishes the newest transcript and
    // must never resurrect the pre-append snapshot.
    await act(async () => {
      frames.forEach((cb) => cb(0));
    });
    const afterFlush = api.messages ?? [];
    expect(afterFlush[afterFlush.length - 1]?.id).toBe("side-q");
    expect(
      (afterFlush[afterFlush.length - 2] as { content?: string }).content,
    ).toBe("alphabeta");
  });
});

describe("useDashboardChatTransport session approval toggle", () => {
  beforeEach(() => {
    dashboardMock.close.mockClear();
    dashboardMock.connect.mockClear();
    dashboardMock.request.mockReset();
    dashboardMock.onEvent = null;
    dashboardMock.onClose = null;
    dashboardMock.instances.length = 0;
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function yoloHarness(): Promise<HarnessApi> {
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.create")
        return { session_id: "live", stored_session_id: "stored" };
      if (method === "model.options")
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      if (method === "config.set") return { value: "1" };
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    // Establish the runtime session (same as a first prompt would).
    await act(async () => {
      await api.send?.("hello");
    });
    return api;
  }

  it("reflects the yolo flag from session.info events", async () => {
    const api = await yoloHarness();
    expect(api.sessionYolo).toBeNull();
    await act(async () => {
      dashboardMock.onEvent?.({
        type: "session.info",
        session_id: "live",
        payload: { yolo: false, model: "bad-model" },
      });
    });
    expect(api.sessionYolo).toBe(false);
    await act(async () => {
      dashboardMock.onEvent?.({
        type: "session.info",
        session_id: "live",
        payload: { yolo: true, model: "bad-model" },
      });
    });
    expect(api.sessionYolo).toBe(true);
  });

  it("ignores session.info from a different session", async () => {
    const api = await yoloHarness();
    await act(async () => {
      dashboardMock.onEvent?.({
        type: "session.info",
        session_id: "other-session",
        payload: { yolo: true },
      });
    });
    expect(api.sessionYolo).toBeNull();
  });

  it("toggles the per-session bypass through config.set", async () => {
    const api = await yoloHarness();
    let result = false;
    await act(async () => {
      result = await api.toggleSessionYolo!(true);
    });
    expect(result).toBe(true);
    expect(dashboardMock.request).toHaveBeenCalledWith("config.set", {
      key: "yolo",
      value: "1",
      scope: "session",
      session_id: "live",
    });
    // Optimistic state until the backend's session.info lands.
    expect(api.sessionYolo).toBe(true);
    // The choice persists per stored session (issue #115).
    expect(
      window.localStorage.getItem("hermes.sessionYolo.v1:local:default:stored"),
    ).toBe("1");
  });

  it("clears the stored flag when the bypass is turned off", async () => {
    const api = await yoloHarness();
    await act(async () => {
      await api.toggleSessionYolo!(true);
    });
    await act(async () => {
      await api.toggleSessionYolo!(false);
    });
    expect(
      window.localStorage.getItem("hermes.sessionYolo.v1:local:default:stored"),
    ).toBe("0");
  });

  it("restores the persisted bypass after a restart (issue #115)", async () => {
    // Simulate the persisted pre-restart state: the user enabled the bypass
    // for this stored session in an earlier app run.
    window.localStorage.setItem(
      "hermes.sessionYolo.v1:local:default:stored",
      "1",
    );
    // Fresh app run: same stored chat session, backend process is new (its
    // in-memory yolo set is empty), resume reports yolo off.
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.resume")
        return {
          session_id: "live-2",
          stored_session_id: "stored",
          running: false,
        };
      if (method === "model.options")
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      if (method === "config.set") return { value: "1" };
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} hermesSessionId="stored" />);
    // Establish the runtime session (resume path) — the restore fires there,
    // no session.info event needed (a lazy resume carries no yolo at all).
    await act(async () => {
      await api.send?.("hello");
    });
    expect(api.sessionYolo).toBe(true);
    expect(dashboardMock.request).toHaveBeenCalledWith("config.set", {
      key: "yolo",
      value: "1",
      scope: "session",
      session_id: "live-2",
    });
    // A duplicate restore must not fire again for the same runtime session.
    dashboardMock.request.mockClear();
    await act(async () => {
      dashboardMock.onEvent?.({
        type: "session.info",
        session_id: "live-2",
        payload: { yolo: false, model: "bad-model" },
      });
    });
    const sets = dashboardMock.request.mock.calls.filter(
      ([method]) => method === "config.set",
    );
    expect(sets).toHaveLength(0);
  });

  it("keeps eager restore and resume single-shot across callback rerenders", async () => {
    window.localStorage.setItem(
      "hermes.sessionYolo.v1:local:default:stored",
      "1",
    );
    let resume!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resume = resolve;
    });
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.resume") return pending;
      if (method === "config.set") return { value: "1" };
      return { subagents: [] };
    });
    const api: HarnessApi = {};
    const view = render(
      <Harness api={api} hermesSessionId="stored" onTodoState={vi.fn()} />,
    );
    await waitFor(() =>
      expect(dashboardMock.request).toHaveBeenCalledWith(
        "session.resume",
        expect.objectContaining({ session_id: "stored" }),
      ),
    );
    view.rerender(
      <Harness api={api} hermesSessionId="stored" onTodoState={vi.fn()} />,
    );
    await act(async () => {
      resume({
        session_id: "live-restore",
        stored_session_id: "stored",
        running: true,
      });
      await pending;
    });
    await waitFor(() => expect(api.sessionYolo).toBe(true));
    const onEvent = dashboardMock.onEvent;
    const activeTurn = api.activeTurnRef?.current;
    view.rerender(
      <Harness api={api} hermesSessionId="stored" onTodoState={vi.fn()} />,
    );
    await act(async () => {});
    expect(dashboardMock.instances).toHaveLength(1);
    expect(dashboardMock.connect).toHaveBeenCalledTimes(1);
    expect(dashboardMock.close).not.toHaveBeenCalled();
    expect(dashboardMock.onEvent).toBe(onEvent);
    expect(
      dashboardMock.request.mock.calls.filter(
        ([method]) => method === "session.resume",
      ),
    ).toHaveLength(1);
    expect(
      dashboardMock.request.mock.calls.filter(
        ([method]) => method === "config.set",
      ),
    ).toEqual([
      [
        "config.set",
        {
          key: "yolo",
          value: "1",
          scope: "session",
          session_id: "live-restore",
        },
      ],
    ]);
    expect(api.activeTurnRef?.current).toBe(activeTurn);
    expect(api.isLoading).toBe(true);
    view.unmount();
  });

  it("does not restore when no flag was persisted", async () => {
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.resume")
        return {
          session_id: "live-3",
          stored_session_id: "stored",
          running: false,
        };
      if (method === "model.options")
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      if (method === "config.set") return { value: "1" };
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} hermesSessionId="stored" />);
    await act(async () => {
      await api.send?.("hello");
    });
    expect(api.sessionYolo).toBeNull();
    const sets = dashboardMock.request.mock.calls.filter(
      ([method]) => method === "config.set",
    );
    expect(sets).toHaveLength(0);
  });

  it("reports failure when the RPC rejects", async () => {
    const api = await yoloHarness();
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "config.set") throw new Error("boom");
      return {};
    });
    let result = true;
    await act(async () => {
      result = await api.toggleSessionYolo!(true);
    });
    expect(result).toBe(false);
    expect(api.sessionYolo).toBeNull();
  });
});
