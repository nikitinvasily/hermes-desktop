import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { EventEmitter } from "events";
import type { ConnectionConfig } from "../src/main/config";

const transport = vi.hoisted(() => ({
  http: [] as Array<{ url: string; headers: Record<string, string> }>,
  rpc: [] as Array<{ method: string; params: Record<string, unknown> }>,
  sockets: [] as Array<{ emit: (name: string, value?: string) => boolean }>,
  respond: vi.fn(),
  runsEvent: null as ((event: Record<string, unknown>) => void) | null,
}));

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: "/tmp/approval-test",
  HERMES_PYTHON: "/usr/bin/true",
  HERMES_REPO: "/tmp",
  hermesCliArgs: () => [],
  getEnhancedPath: () => "",
}));
vi.mock("../src/main/config", () => ({
  getApiServerKey: () => "local-key",
  getActiveConnection: () => ({ connectionId: "local-test", config: {} }),
  // Deliberately differs from the connection captured by sendMessage.
  getConnectionConfig: () => ({
    mode: "remote",
    remoteUrl: "https://other.invalid",
    apiKey: "wrong-key",
    remoteAuthMode: "bearer",
    ssh: {},
  }),
  getModelConfig: () => ({ provider: "openrouter", model: "test-model" }),
  getConfigValue: () => null,
  readEnv: () => ({}),
}));
vi.mock("../src/main/utils", () => ({
  pidIsAliveAs: () => false,
  stripAnsi: (value: string) => value,
  profileHome: () => "/tmp/approval-test",
  normalizeProfileName: (value: string) => value,
  getActiveProfileNameSync: () => undefined,
}));
vi.mock("../src/main/ssh-tunnel", () => ({
  getSshTunnelUrl: () => null,
  isSshTunnelActive: () => false,
}));
vi.mock("../src/main/gateway-ports", () => ({ getProfilePort: () => 8642 }));
vi.mock("../src/main/secrets", () => ({ providerListSafe: () => ({}) }));
vi.mock("../src/main/models", () => ({ readModels: () => [] }));
vi.mock("child_process", async () => {
  const { EventEmitter } = await import("events");
  const spawn = vi.fn(() =>
    Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      killed: false,
      exitCode: null,
    }),
  );
  return { spawn, ChildProcess: class {}, default: { spawn } };
});
vi.mock("net", async () => {
  const { EventEmitter } = await import("events");
  return {
    default: {
      createServer: () => {
        const server = Object.assign(new EventEmitter(), {
          listen: () => queueMicrotask(() => server.emit("listening")),
          close: (callback: () => void) => callback(),
        });
        return server;
      },
    },
  };
});
vi.mock("ws", async () => {
  const { EventEmitter } = await import("events");
  return {
    default: class extends EventEmitter {
      static OPEN = 1;
      readyState = 1;
      constructor() {
        super();
        transport.sockets.push(this);
        queueMicrotask(() => this.emit("open"));
      }
      close(): void {
        this.readyState = 3;
        this.emit("close");
      }
      send(raw: string): void {
        const frame = JSON.parse(raw);
        transport.rpc.push(frame);
        queueMicrotask(() => {
          const result = transport.respond(frame.method, frame.params, this);
          this.emit(
            "message",
            JSON.stringify({
              id: frame.id,
              ...(result instanceof Error
                ? { error: { message: result.message } }
                : { result }),
            }),
          );
        });
      }
    },
  };
});
vi.mock("http", async () => {
  const { EventEmitter } = await import("events");
  return {
    default: {
      request: (
        url: string,
        options: { headers: Record<string, string> },
        callback?: (res: EventEmitter) => void,
      ) => {
        transport.http.push({ url, headers: options.headers });
        const response = Object.assign(new EventEmitter(), {
          statusCode: 200,
          resume: () => undefined,
        });
        return Object.assign(new EventEmitter(), {
          write: () => undefined,
          destroy: () => undefined,
          end: () =>
            queueMicrotask(() => {
              callback?.(response);
              if (url.endsWith("/events")) {
                transport.runsEvent = (event) =>
                  response.emit(
                    "data",
                    Buffer.from(`data: ${JSON.stringify(event)}\n\n`),
                  );
                return;
              }
              let body = {};
              if (url.endsWith("/v1/capabilities"))
                body = {
                  features: {
                    run_submission: true,
                    run_events_sse: true,
                    run_stop: true,
                    run_approval_response: true,
                    tool_progress_events: true,
                  },
                  endpoints: {
                    runs: { path: "/v1/runs" },
                    run_events: { path: "/v1/runs/{run_id}/events" },
                    run_stop: { path: "/v1/runs/{run_id}/stop" },
                    run_approval: { path: "/v1/runs/{run_id}/approval" },
                  },
                };
              if (url.endsWith("/v1/runs")) body = { run_id: "run-1" };
              response.emit("data", Buffer.from(JSON.stringify(body)));
              response.emit("end");
            }),
        });
      },
    },
  };
});

import {
  bindPendingApproval,
  clearAllPendingApprovals,
  resolvePendingApproval,
  sendMessage,
  stopHealthPolling,
  type ChatCallbacks,
} from "../src/main/hermes";
import type { ChatApprovalRequest } from "../src/shared/chat-approval";

const local = { mode: "local", ssh: {} } as ConnectionConfig;
const remote = {
  mode: "remote",
  remoteUrl: "http://original.invalid",
  apiKey: "original-key",
  remoteAuthMode: "bearer",
  ssh: {},
} as ConnectionConfig;
function callbacks(): ChatCallbacks & {
  onApproval: Mock<(approval: ChatApprovalRequest) => boolean>;
  onClarify: Mock<(req: unknown) => void>;
} {
  return {
    onChunk: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    onClarify: vi.fn(),
    onApproval: vi.fn((approval: ChatApprovalRequest) =>
      bindPendingApproval(approval.requestId, {
        ownerId: 1,
        runId: "chat-run",
      }),
    ),
  };
}
function emitApproval(payload: Record<string, unknown>): void {
  transport.sockets.at(-1)!.emit(
    "message",
    JSON.stringify({
      method: "event",
      params: { type: "approval.request", session_id: "live-1", payload },
    }),
  );
}
async function send(
  cb: ReturnType<typeof callbacks>,
  conn = local,
): ReturnType<typeof sendMessage> {
  return sendMessage(
    "hello",
    cb,
    `approval-${crypto.randomUUID()}`,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    conn,
    "original",
  );
}

beforeEach(() => {
  vi.stubEnv("VITEST", "false");
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("npm_lifecycle_event", "approval-regression");
  transport.http.length = 0;
  transport.rpc.length = 0;
  transport.sockets.length = 0;
  transport.runsEvent = null;
  transport.respond.mockReset();
  transport.respond.mockImplementation((method: string) =>
    method === "session.create"
      ? { session_id: "live-1", stored_session_id: "stored-1", info: {} }
      : method === "approval.respond"
        ? { resolved: 1 }
        : {},
  );
});
afterEach(() => {
  for (const socket of transport.sockets) socket.emit("close");
  clearAllPendingApprovals();
  stopHealthPolling();
  vi.unstubAllEnvs();
});

describe("approval transport safety", () => {
  // @lat: [[chat-commands#Structured command approvals#Gateway approval correlation]]
  it("sends the gateway ID, never the opaque renderer ID", async () => {
    const cb = callbacks();
    const handle = await send(cb);
    emitApproval({
      request_id: "upstream-1",
      command: "npm publish",
      choices: ["once"],
    });
    const approval = cb.onApproval.mock.calls[0][0];
    expect(approval.requestId).not.toBe("upstream-1");
    expect(
      await resolvePendingApproval(approval.requestId, "once", {
        ownerId: 1,
        runId: "chat-run",
      }),
    ).toBe(true);
    expect(transport.rpc).toContainEqual(
      expect.objectContaining({
        method: "approval.respond",
        params: {
          session_id: "live-1",
          request_id: "upstream-1",
          choice: "once",
          all: false,
        },
      }),
    );
    handle.abort();
  });

  it.each(["missing ID", "disconnect", "stale ID"])(
    "fails closed on %s without replaying the prompt",
    async (failure) => {
      const cb = callbacks();
      await send(cb);
      emitApproval({
        ...(failure === "missing ID" ? {} : { request_id: "upstream-1" }),
        choices: ["once"],
      });
      if (failure === "disconnect") transport.sockets.at(-1)!.emit("close");
      if (failure === "stale ID") {
        transport.respond.mockReturnValue({ resolved: 0 });
        expect(
          await resolvePendingApproval(
            cb.onApproval.mock.calls[0][0].requestId,
            "once",
            { ownerId: 1, runId: "chat-run" },
          ),
        ).toBe(false);
      }
      expect(cb.onError).toHaveBeenCalledWith(
        expect.stringContaining("Approval flow failed:"),
      );
      expect(transport.http.some(({ url }) => url.includes("/v1/"))).toBe(
        false,
      );
      expect(
        transport.rpc.filter(({ method }) => method === "prompt.submit"),
      ).toHaveLength(1);
    },
  );

  it("does not replay after approval arrives before a rejected prompt acknowledgement", async () => {
    const cb = callbacks();
    transport.respond.mockImplementation(
      (method: string, _params: unknown, socket: EventEmitter) => {
        if (method === "session.create")
          return { session_id: "live-1", info: {} };
        if (method === "prompt.submit") {
          socket.emit(
            "message",
            JSON.stringify({
              method: "event",
              params: {
                type: "approval.request",
                session_id: "live-1",
                payload: { request_id: "upstream-1", choices: ["once"] },
              },
            }),
          );
          return new Error("lost acknowledgement");
        }
        return {};
      },
    );
    await send(cb);
    expect(cb.onError).toHaveBeenCalledWith(
      expect.stringContaining("not replayed"),
    );
    expect(transport.http.some(({ url }) => url.includes("/v1/"))).toBe(false);
    expect(
      await resolvePendingApproval(
        cb.onApproval.mock.calls[0][0].requestId,
        "once",
        { ownerId: 1, runId: "chat-run" },
      ),
    ).toBe(false);
  });

  // @lat: [[chat-commands#Structured command approvals#Runs approval fail-closed]]
  it("stops unsupported Runs approvals using the original connection, with no approval POST or replay", async () => {
    const cb = callbacks();
    await send(cb, remote);
    await vi.waitFor(() => expect(transport.runsEvent).not.toBeNull());
    transport.runsEvent!({
      event: "approval.request",
      request_id: "upstream-1",
      command: "npm publish",
    });
    transport.runsEvent!({ event: "run.failed", error: "stream lost" });
    expect(cb.onApproval).not.toHaveBeenCalled();
    expect(cb.onError).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("cannot safely target"),
    );
    expect(transport.http).toContainEqual({
      url: "http://original.invalid/v1/runs/run-1/stop",
      headers: expect.objectContaining({
        Authorization: "Bearer original-key",
      }),
    });
    expect(
      transport.http.some(
        ({ url }) =>
          url.endsWith("/approval") || url.endsWith("/chat/completions"),
      ),
    ).toBe(false);
  });
});

describe("server-to-client requests", () => {
  function sentFrames(method?: string): Array<Record<string, unknown>> {
    return transport.rpc.filter((frame) => !method || frame.method === method);
  }

  // @lat: [[chat-commands#Structured command approvals#Server request advertisement]]
  it("advertises server_requests capability on connect", async () => {
    const cb = callbacks();
    await send(cb);
    expect(sentFrames("client.capabilities")).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        params: { server_requests: true },
      }),
    ]);
  });

  // @lat: [[chat-commands#Structured command approvals#Approval server requests]]
  it("renders an approval server request and answers it with the choice", async () => {
    const cb = callbacks();
    await send(cb);
    const socket = transport.sockets.at(-1)!;
    socket.emit(
      "message",
      JSON.stringify({
        jsonrpc: "2.0",
        id: "srq-approval1",
        method: "approval",
        params: {
          session_id: "live-1",
          request_id: "upstream-1",
          command: "npm publish",
          choices: ["once"],
        },
      }),
    );
    const approval = cb.onApproval.mock.calls[0][0];
    expect(approval.requestId).not.toBe("upstream-1");
    expect(
      await resolvePendingApproval(approval.requestId, "once", {
        ownerId: 1,
        runId: "chat-run",
      }),
    ).toBe(true);
    // The answer is the JSON-RPC result frame for the server request id —
    // NOT a separate approval.respond call.
    expect(transport.rpc).toContainEqual({
      jsonrpc: "2.0",
      id: "srq-approval1",
      result: { choice: "once", all: false },
    });
    expect(
      sentFrames("approval.respond").filter(
        (frame) =>
          (frame.params as Record<string, unknown>).request_id === "upstream-1",
      ),
    ).toEqual([]);
  });

  // @lat: [[chat-commands#Structured command approvals#Request cancel teardown]]
  it("drops the local card on request.cancel", async () => {
    const cb = callbacks();
    await send(cb);
    const socket = transport.sockets.at(-1)!;
    socket.emit(
      "message",
      JSON.stringify({
        jsonrpc: "2.0",
        id: "srq-approval2",
        method: "approval",
        params: {
          session_id: "live-1",
          request_id: "upstream-2",
          choices: ["once"],
        },
      }),
    );
    const approval = cb.onApproval.mock.calls[0][0];
    expect(approval).toBeTruthy();
    socket.emit(
      "message",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "request.cancel",
        params: { id: "srq-approval2", method: "approval", reason: "timeout" },
      }),
    );
    // The card's resolver is gone: a late approve cannot answer anymore.
    expect(
      await resolvePendingApproval(approval.requestId, "once", {
        ownerId: 1,
        runId: "chat-run",
      }),
    ).toBe(false);
  });

  // @lat: [[chat-commands#Structured command approvals#Clarify server requests]]
  it("answers a clarify server request with the renderer's answer", async () => {
    const cb = callbacks();
    await send(cb);
    const socket = transport.sockets.at(-1)!;
    socket.emit(
      "message",
      JSON.stringify({
        jsonrpc: "2.0",
        id: "srq-clarify1",
        method: "clarify",
        params: {
          session_id: "live-1",
          request_id: "upstream-q1",
          question: "Which region?",
          choices: ["eu", "us"],
        },
      }),
    );
    expect(cb.onClarify).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "upstream-q1" }),
    );
    // The renderer's IPC path (clarify-respond) resolves via the shared
    // pendingClarify map — drive it directly.
    const { resolvePendingClarify } = await import("../src/main/hermes");
    expect(resolvePendingClarify("upstream-q1", "eu")).toBe(true);
    await vi.waitFor(() =>
      expect(transport.rpc).toContainEqual({
        jsonrpc: "2.0",
        id: "srq-clarify1",
        result: { answer: "eu" },
      }),
    );
  });

  it("answers unknown methods with -32601", async () => {
    const cb = callbacks();
    await send(cb);
    const socket = transport.sockets.at(-1)!;
    socket.emit(
      "message",
      JSON.stringify({
        jsonrpc: "2.0",
        id: "srq-tour",
        method: "tour",
        params: { session_id: "live-1" },
      }),
    );
    await vi.waitFor(() =>
      expect(transport.rpc).toContainEqual({
        jsonrpc: "2.0",
        id: "srq-tour",
        error: expect.objectContaining({ code: -32601 }),
      }),
    );
  });
});
