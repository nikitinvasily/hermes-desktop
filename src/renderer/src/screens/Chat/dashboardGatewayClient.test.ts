// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardGatewayClient } from "./dashboardGatewayClient";

// A controllable WebSocket stand-in: it never opens, errors, or closes on its
// own, so each test drives the readyState transition explicitly. This lets us
// exercise the connect handshake — in particular the stalled CONNECTING case
// that wedged the transport before issue #718 added a connect timeout.
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: FakeWebSocket | null = null;

  readyState = FakeWebSocket.CONNECTING;
  closeCalls = 0;
  sent: string[] = [];
  private listeners: Record<string, ((event: unknown) => void)[]> = {};

  constructor(public url: string) {
    FakeWebSocket.last = this;
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(handler);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter(
      (candidate) => candidate !== handler,
    );
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
  }

  emit(type: string, event: unknown = {}): void {
    for (const handler of this.listeners[type] ?? []) handler(event);
  }

  send(raw: string): void {
    this.sent.push(raw);
  }

  /** Deliver one server frame as a string message event. */
  receive(frame: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.last = null;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DashboardGatewayClient.connect", () => {
  it("rejects and closes the socket when the handshake stalls", async () => {
    const client = new DashboardGatewayClient({ connectTimeoutMs: 1_000 });
    const connecting = client.connect("ws://localhost/api/ws");
    const assertion = expect(connecting).rejects.toThrow(/timed out/i);

    // Socket never fires open/error/close — only the timeout should settle it.
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;

    expect(FakeWebSocket.last?.closeCalls).toBe(1);
    expect(client.connected).toBe(false);
  });

  it("resolves on open and cancels the timeout", async () => {
    const client = new DashboardGatewayClient({ connectTimeoutMs: 1_000 });
    const connecting = client.connect("ws://localhost/api/ws");

    const socket = FakeWebSocket.last;
    if (!socket) throw new Error("socket not created");
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    await connecting;

    expect(client.connected).toBe(true);
    // A late timeout firing must not tear down a healthy socket.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.closeCalls).toBe(0);
    expect(client.connected).toBe(true);
  });

  it("rejects when the socket closes before the handshake settles", async () => {
    const client = new DashboardGatewayClient({ connectTimeoutMs: 10_000 });
    const connecting = client.connect("ws://localhost/api/ws");
    const assertion = expect(connecting).rejects.toThrow(/closed/i);

    FakeWebSocket.last?.emit("close", {});
    await assertion;
  });
});

describe("DashboardGatewayClient server→client requests", () => {
  interface SentFrame {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: { code?: number };
  }

  function sentFrames(): SentFrame[] {
    return (FakeWebSocket.last?.sent ?? []).map((raw) => JSON.parse(raw));
  }

  /** Open a connected client with a recording onServerRequest. */
  async function openedClient(
    options: ConstructorParameters<typeof DashboardGatewayClient>[0],
  ): Promise<DashboardGatewayClient> {
    const client = new DashboardGatewayClient(options);
    const connecting = client.connect("ws://localhost/api/ws");
    const socket = FakeWebSocket.last;
    if (!socket) throw new Error("socket not created");
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    await connecting;
    return client;
  }

  it("advertises server_requests as a request frame with an id on connect", async () => {
    await openedClient({});
    const advertisement = sentFrames().find(
      (frame) => frame.method === "client.capabilities",
    );
    expect(advertisement).toBeTruthy();
    expect(advertisement?.id).not.toBeNull();
    expect(advertisement?.params).toEqual({ server_requests: true });
  });

  it("delivers an approval server request and answers with the result frame", async () => {
    const onServerRequest = vi.fn(() => ({ choice: "once", all: false }));
    await openedClient({ onServerRequest });
    FakeWebSocket.last?.receive({
      jsonrpc: "2.0",
      id: "srq-1",
      method: "approval",
      params: { session_id: "s1", request_id: "up-1", choices: ["once"] },
    });
    expect(onServerRequest).toHaveBeenCalledWith("approval", {
      session_id: "s1",
      request_id: "up-1",
      choices: ["once"],
    });
    await vi.waitFor(() => {
      expect(sentFrames().find((frame) => frame.id === "srq-1")).toEqual({
        jsonrpc: "2.0",
        id: "srq-1",
        result: { choice: "once", all: false },
      });
    });
  });

  it("answers a declined request with -32601", async () => {
    const onServerRequest = vi.fn(
      (_method: string, _params: Record<string, unknown>) => false as const,
    );
    await openedClient({ onServerRequest });
    FakeWebSocket.last?.receive({
      jsonrpc: "2.0",
      id: "srq-2",
      method: "sudo",
      params: { session_id: "s1" },
    });
    expect(sentFrames().find((frame) => frame.id === "srq-2")?.error).toEqual(
      expect.objectContaining({ code: -32601 }),
    );
  });

  it("answers an unknown method with -32601 even without a handler", async () => {
    await openedClient({});
    FakeWebSocket.last?.receive({
      jsonrpc: "2.0",
      id: "srq-4",
      method: "tour",
      params: { session_id: "s1" },
    });
    expect(sentFrames().find((frame) => frame.id === "srq-4")?.error).toEqual(
      expect.objectContaining({ code: -32601 }),
    );
  });

  it("waits for a handler's promise before answering", async () => {
    let pendingResolve: ((value: Record<string, unknown>) => void) | undefined;
    const answerPromise = new Promise<Record<string, unknown>>((resolve) => {
      pendingResolve = resolve;
    });
    const onServerRequest = vi.fn(
      (_method: string, _params: Record<string, unknown>) => answerPromise,
    );
    await openedClient({ onServerRequest });
    FakeWebSocket.last?.receive({
      jsonrpc: "2.0",
      id: "srq-3",
      method: "clarify",
      params: { session_id: "s1", question: "q" },
    });
    expect(sentFrames().find((frame) => frame.id === "srq-3")).toBeUndefined();
    pendingResolve?.({ answer: "eu" });
    await vi.waitFor(() => {
      expect(
        sentFrames().find((frame) => frame.id === "srq-3")?.result,
      ).toEqual({ answer: "eu" });
    });
  });
});
