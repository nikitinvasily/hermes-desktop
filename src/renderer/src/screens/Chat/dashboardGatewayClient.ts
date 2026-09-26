export interface DashboardRpcEvent<T = unknown> {
  payload?: T;
  session_id?: string;
  type: string;
}

export interface DashboardGatewayClientOptions {
  /** How long `connect()` waits for the WebSocket handshake before giving up.
   *  Without this, a socket stuck in CONNECTING (TCP accepted but the upgrade
   *  never completes — e.g. when the renderer is starved) leaves the connect
   *  promise pending forever, wedging the whole transport with no error and no
   *  fallback (issue #718). */
  connectTimeoutMs?: number;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
  onEvent?: (event: DashboardRpcEvent) => void;
  /**
   * Handler for server→client requests (approval, clarify, sudo/secret, …).
   * Return a result payload (or a promise of one) to answer with, or `false`
   * to decline — declining answers `-32601` so the backend withdraws the
   * request immediately instead of waiting out its deadline. A handler that
   * throws also declines.
   */
  onServerRequest?: (
    method: string,
    params: Record<string, unknown>,
  ) =>
    | Record<string, unknown>
    | Promise<Record<string, unknown> | void>
    | false;
  requestTimeoutMs?: number;
}

interface JsonRpcResponse<T = unknown> {
  error?: { code?: number; message?: string } | string;
  id: number | string;
  jsonrpc?: "2.0";
  result?: T;
}

interface JsonRpcNotification {
  method?: string;
  params?: unknown;
  type?: string;
  payload?: unknown;
  session_id?: string;
}

interface PendingRequest<T = unknown> {
  reject: (reason: Error) => void;
  resolve: (value: T) => void;
  timeout: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeDashboardNotification(
  value: unknown,
): DashboardRpcEvent | null {
  if (!isRecord(value)) return null;

  const notification = value as JsonRpcNotification;
  if (typeof notification.type === "string") {
    return {
      type: notification.type,
      payload: notification.payload,
      session_id:
        typeof notification.session_id === "string"
          ? notification.session_id
          : undefined,
    };
  }

  if (
    notification.method === "event" &&
    isRecord(notification.params) &&
    typeof notification.params.type === "string"
  ) {
    return {
      type: notification.params.type,
      payload: notification.params.payload,
      session_id:
        typeof notification.params.session_id === "string"
          ? notification.params.session_id
          : undefined,
    };
  }

  if (typeof notification.method === "string") {
    const params = isRecord(notification.params) ? notification.params : {};
    return {
      type: notification.method,
      payload: params.payload,
      session_id:
        typeof params.session_id === "string" ? params.session_id : undefined,
    };
  }

  return null;
}

export class DashboardGatewayClient {
  private nextRequestId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private socket: WebSocket | null = null;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;

  constructor(private readonly options: DashboardGatewayClientOptions = {}) {
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(wsUrl: string): Promise<void> {
    this.close();

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      this.socket = socket;
      let settled = false;

      // Bound the handshake: a socket stuck in CONNECTING fires neither `open`
      // nor `error`, so without this timer the promise would never settle and
      // the transport would wedge forever (issue #718). On timeout we reject and
      // close the half-open socket so `ensureClient` can fall back to legacy.
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        if (this.socket === socket) this.socket = null;
        try {
          socket.close();
        } catch {
          // Best-effort teardown of the stalled socket.
        }
        reject(new Error("Hermes dashboard WebSocket connection timed out"));
      }, this.connectTimeoutMs);

      const failOpen = (event: Event): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (this.socket === socket) this.socket = null;
        reject(new Error(`Could not connect to Hermes dashboard WebSocket`));
        this.options.onError?.(event);
      };

      socket.addEventListener(
        "open",
        () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          socket.removeEventListener("error", failOpen);
          // Tell the backend this client answers server→client requests
          // (approvals, clarify, sudo/secret prompts). Without the
          // advertisement the backend treats us as an old build and withdraws
          // every approval with "the attached client cannot answer approval
          // requests" — the agent then reports the command as blocked.
          // MUST carry an id: the dispatcher only handles request frames, a
          // notification (no id) is silently ignored and never advertises.
          try {
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: this.nextRequestId++,
                method: "client.capabilities",
                params: { server_requests: true },
              }),
            );
          } catch {
            /* best-effort; the close handler resets */
          }
          resolve();
        },
        { once: true },
      );
      socket.addEventListener("error", failOpen, { once: true });
      socket.addEventListener("message", (event) => this.handleMessage(event));
      socket.addEventListener("close", (event) => {
        if (this.socket === socket) this.socket = null;
        // A close before the handshake settles must still reject the connect
        // promise — otherwise a CONNECTING→CLOSED transition with no `error`
        // event would hang it until the timeout fires.
        if (!settled) {
          settled = true;
          window.clearTimeout(timeout);
          reject(new Error("Hermes dashboard WebSocket closed"));
        }
        this.rejectPending("Hermes dashboard WebSocket closed");
        this.options.onClose?.(event);
      });
    });
  }

  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error("Hermes dashboard WebSocket is not connected"),
      );
    }

    const id = this.nextRequestId++;
    const message = { jsonrpc: "2.0", id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hermes dashboard request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timeout,
      });
      socket.send(JSON.stringify(message));
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.rejectPending("Hermes dashboard WebSocket closed");
    if (
      socket &&
      (socket.readyState === WebSocket.CONNECTING ||
        socket.readyState === WebSocket.OPEN)
    ) {
      socket.close();
    }
  }

  private handleMessage(event: MessageEvent): void {
    let message: unknown;
    try {
      message =
        typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }

    // Server→client request (approval, clarify, sudo/secret prompt): a frame
    // carrying BOTH `id` and `method`. Route it to the registered handler and
    // answer with a JSON-RPC result frame on the same id; an unknown method
    // or a declined handler answers -32601 so the backend never waits out
    // its deadline against us.
    if (
      isRecord(message) &&
      "id" in message &&
      typeof (message as { method?: unknown }).method === "string"
    ) {
      this.deliverServerRequest(
        message as unknown as {
          id: number | string;
          method: string;
          params?: unknown;
        },
      );
      return;
    }

    if (isRecord(message) && "id" in message && !("method" in message)) {
      this.resolveResponse(message as unknown as JsonRpcResponse);
      return;
    }

    const normalized = normalizeDashboardNotification(message);
    if (normalized) this.options.onEvent?.(normalized);
  }

  private deliverServerRequest(request: {
    id: number | string;
    method: string;
    params?: unknown;
  }): void {
    const handler = this.options.onServerRequest;
    const params = isRecord(request.params) ? request.params : {};
    const answer = (frame: Record<string, unknown>): void => {
      try {
        this.socket?.send(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, ...frame }),
        );
      } catch {
        /* the socket closed; the backend withdraws the request itself */
      }
    };
    if (!handler) {
      answer({ error: { code: -32601, message: "Method not found" } });
      return;
    }
    let accepted: ReturnType<
      NonNullable<DashboardGatewayClientOptions["onServerRequest"]>
    >;
    try {
      accepted = handler(request.method, params);
    } catch {
      answer({ error: { code: -32601, message: "Method not found" } });
      return;
    }
    if (accepted === false) {
      answer({ error: { code: -32601, message: "Method not found" } });
      return;
    }
    Promise.resolve(accepted).then(
      (result) => answer({ result: result ?? {} }),
      () => answer({ error: { code: -32601, message: "Method not found" } }),
    );
  }

  private resolveResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    window.clearTimeout(pending.timeout);

    if (response.error) {
      const message =
        typeof response.error === "string"
          ? response.error
          : response.error.message || "Hermes dashboard request failed";
      pending.reject(new Error(message));
      return;
    }

    pending.resolve(response.result);
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}
