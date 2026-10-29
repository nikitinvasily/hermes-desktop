// @vitest-environment node
import { readFileSync } from "fs";
import { join } from "path";
import { runInNewContext } from "vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";

function handler(
  scope: Record<string, unknown>,
): (event: unknown, requestId?: string) => Promise<unknown> {
  const file = join(__dirname, "../src/main/ipc/register.ts");
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let callback: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "ipcMain.handle" &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "run-hermes-update"
    )
      callback = node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!callback) throw new Error("Missing real update handler");
  const output = ts.transpileModule(
    `exports.handle = ${callback.getText(source)};`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  const exports: {
    handle?: (event: unknown, requestId?: string) => Promise<unknown>;
  } = {};
  runInNewContext(output, { exports, ...scope });
  return exports.handle!;
}

// @lat: [[desktop-updates#Agent phases#SSH phases follow operations]]
it("emits real SSH phases before their operations and never measures the pending command as complete", async () => {
  let finish!: () => void;
  const calls: string[] = [];
  const updates: Array<{
    title: string;
    step: number;
    totalSteps: number;
    operation?: string;
  }> = [];
  const ssh = { host: "isolated.example" };
  const run = handler({
    getConnectionConfig: () => ({ mode: "ssh", ssh }),
    sshRunUpdate: async () => {
      calls.push("update");
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    ensureSshDashboardCompatibility: async () => {
      calls.push("compatibility");
      return { ok: true };
    },
    sshStartGateway: async () => {
      calls.push("gateway");
    },
    startSshTunnel: async () => {
      calls.push("tunnel");
    },
    sshReadRemoteApiKey: async () => {
      calls.push("credential");
      return "fixture-key";
    },
    setSshRemoteApiKey: vi.fn(),
    clearAgentCapabilityEvidence: vi.fn(),
    getActiveConnection: () => ({ connectionId: "ssh-fixture" }),
  });
  const pending = run({
    sender: {
      isDestroyed: () => false,
      send: (_channel: string, progress: (typeof updates)[number]) =>
        updates.push(progress),
    },
  });
  expect(calls).toEqual(["update"]);
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({
    operation: "update",
    step: 0,
    totalSteps: 0,
  });
  finish();
  expect(await pending).toEqual({ success: true });
  expect(calls).toEqual([
    "update",
    "compatibility",
    "gateway",
    "tunnel",
    "credential",
  ]);
  expect(updates.map((p) => p.title)).toEqual([
    "Updating remote Hermes Agent",
    "Checking dashboard compatibility",
    "Restarting gateway",
    "Reconnecting tunnel",
    "Refreshing connection",
  ]);
  expect(
    updates.every((p) => p.operation === "update" && p.totalSteps === 0),
  ).toBe(true);
});

// @lat: [[desktop-updates#Agent phases#Remote update refusal remains read-only]]
it("keeps remote update refusal free of local or SSH updater operations", async () => {
  const update = vi.fn();
  const send = vi.fn();
  const run = handler({
    getConnectionConfig: () => ({ mode: "remote" }),
    runHermesUpdate: update,
    sshRunUpdate: update,
  });
  expect(
    await run({ sender: { send, isDestroyed: () => false } }),
  ).toMatchObject({ success: false });
  expect(update).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

// @lat: [[desktop-updates#Agent phases#IPC echoes the update owner]]
it("echoes only the supplied update owner while retaining legacy callers", async () => {
  for (const owner of [undefined, "fixture-update-owner"] as const) {
    const send = vi.fn();
    const run = handler({
      getConnectionConfig: () => ({ mode: "local" }),
      runHermesUpdate: async (emit: (p: unknown) => void) =>
        emit({
          operation: "update",
          step: 0,
          totalSteps: 0,
          title: "Updating",
          detail: "output",
          log: "output",
        }),
      ensureLocalDashboardCompatibility: () => ({ ok: true }),
      clearAgentCapabilityEvidence: vi.fn(),
      getActiveConnection: () => ({ connectionId: "local-fixture" }),
    });
    expect(
      await run({ sender: { send, isDestroyed: () => false } }, owner),
    ).toEqual({ success: true });
    expect(send.mock.calls).toHaveLength(2);
    for (const [, progress] of send.mock.calls) {
      if (owner) expect(progress.requestId).toBe(owner);
      else expect(progress).not.toHaveProperty("requestId");
    }
  }
});

function sshUpdateFixture(
  operation: (name: string) => Promise<void>,
): Record<string, unknown> {
  return {
    getConnectionConfig: () => ({
      mode: "ssh",
      ssh: { host: "isolated.example" },
    }),
    sshRunUpdate: () => operation("update"),
    ensureSshDashboardCompatibility: async () => {
      await operation("compatibility");
      return { ok: true };
    },
    sshStartGateway: () => operation("gateway"),
    startSshTunnel: () => operation("tunnel"),
    sshReadRemoteApiKey: async () => {
      await operation("credential");
      return " fixture-key ";
    },
    setSshRemoteApiKey: vi.fn(),
    clearAgentCapabilityEvidence: vi.fn(),
    getActiveConnection: () => ({ connectionId: "ssh-fixture" }),
  };
}

// @lat: [[desktop-updates#Agent phases#Closed windows do not interrupt SSH follow-up]]
it.each(["update", "compatibility", "gateway", "tunnel"])(
  "finishes SSH follow-up when the window closes during %s",
  async (closingOperation) => {
    let finish!: () => void;
    let admitted!: () => void;
    const entered = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const calls: string[] = [];
    let destroyed = false;
    const scope = sshUpdateFixture(async (name) => {
      calls.push(name);
      if (name === closingOperation) {
        admitted();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
    });
    const send = vi.fn(() => {
      if (destroyed) throw new Error("Object has been destroyed");
    });
    const pending = handler(scope)({
      sender: { isDestroyed: () => destroyed, send },
    });
    await entered;
    const sentBeforeClose = send.mock.calls.length;
    destroyed = true;
    finish();
    expect(await pending).toEqual({ success: true });
    expect(calls).toEqual([
      "update",
      "compatibility",
      "gateway",
      "tunnel",
      "credential",
    ]);
    expect(send).toHaveBeenCalledTimes(sentBeforeClose);
    expect(scope.setSshRemoteApiKey).toHaveBeenCalledWith("fixture-key");
    expect(scope.clearAgentCapabilityEvidence).toHaveBeenCalledWith(
      "ssh-fixture",
    );
  },
);

// @lat: [[desktop-updates#Agent phases#Progress delivery races are best effort]]
it("finishes SSH follow-up if a sender disappears between its live check and send", async () => {
  let throws = false;
  const calls: string[] = [];
  const scope = sshUpdateFixture(async (name) => {
    calls.push(name);
    if (name === "update") throws = true;
  });
  const send = vi.fn(() => {
    if (throws) throw new Error("Object has been destroyed");
  });
  expect(
    await handler(scope)({ sender: { isDestroyed: () => false, send } }),
  ).toEqual({ success: true });
  expect(calls).toEqual([
    "update",
    "compatibility",
    "gateway",
    "tunnel",
    "credential",
  ]);
  expect(scope.setSshRemoteApiKey).toHaveBeenCalledWith("fixture-key");
});

// @lat: [[desktop-updates#Agent phases#Closed windows do not interrupt Local validation]]
it("keeps Local command output and validation running after the window closes", async () => {
  let destroyed = false;
  const compatibility = vi.fn(() => ({ ok: true }));
  const clear = vi.fn();
  const run = handler({
    getConnectionConfig: () => ({ mode: "local" }),
    runHermesUpdate: async (emit: (p: unknown) => void) => {
      destroyed = true;
      emit({
        operation: "update",
        step: 0,
        totalSteps: 0,
        title: "Updating",
        detail: "output",
        log: "output",
      });
    },
    ensureLocalDashboardCompatibility: compatibility,
    clearAgentCapabilityEvidence: clear,
    getActiveConnection: () => ({ connectionId: "local-fixture" }),
  });
  const send = vi.fn(() => {
    throw new Error("Object has been destroyed");
  });
  expect(await run({ sender: { isDestroyed: () => destroyed, send } })).toEqual(
    { success: true },
  );
  expect(send).not.toHaveBeenCalled();
  expect(compatibility).toHaveBeenCalledOnce();
  expect(clear).toHaveBeenCalledWith("local-fixture");
});

// @lat: [[desktop-updates#Agent phases#Operation errors remain failures without a window]]
it("reports real SSH operation failures even when progress has no receiver", async () => {
  const calls: string[] = [];
  const scope = sshUpdateFixture(async (name) => {
    calls.push(name);
    if (name === "compatibility") throw new Error("SSH compatibility failed");
  });
  const send = vi.fn(() => {
    throw new Error("Object has been destroyed");
  });
  expect(
    await handler(scope)({ sender: { isDestroyed: () => true, send } }),
  ).toEqual({ success: false, error: "SSH compatibility failed" });
  expect(calls).toEqual(["update", "compatibility"]);
  expect(scope.setSshRemoteApiKey).not.toHaveBeenCalled();
  expect(scope.clearAgentCapabilityEvidence).not.toHaveBeenCalled();
});

function preloadFixture(): {
  api: {
    runHermesUpdate: (requestId?: string) => Promise<unknown>;
    onInstallProgress: (callback: (progress: unknown) => void) => () => void;
    onUpdateDownloadProgress: (
      callback: (progress: unknown) => void,
    ) => () => void;
  };
  invoke: ReturnType<typeof vi.fn>;
  listeners: Map<string, (event: unknown, progress: unknown) => void>;
  removeListener: ReturnType<typeof vi.fn>;
} {
  const listeners = new Map<
    string,
    (event: unknown, progress: unknown) => void
  >();
  const invoke = vi.fn(async () => ({ success: true }));
  const removeListener = vi.fn();
  const window = {} as { hermesAPI: ReturnType<typeof preloadFixture>["api"] };
  const file = join(__dirname, "../src/preload/index.ts");
  const output = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  runInNewContext(output, {
    exports: {},
    window,
    process: { platform: "fixture", versions: {} },
    require: (name: string) => {
      if (name !== "electron") throw new Error(`Unexpected require: ${name}`);
      return {
        ipcRenderer: {
          invoke,
          removeListener,
          on: (
            channel: string,
            listener: (event: unknown, progress: unknown) => void,
          ) => listeners.set(channel, listener),
        },
      };
    },
  });
  return { api: window.hermesAPI, invoke, listeners, removeListener };
}

it("forwards optional update ownership through the real preload bridge", async () => {
  const f = preloadFixture();
  await f.api.runHermesUpdate("fixture-owner");
  expect(f.invoke).toHaveBeenLastCalledWith(
    "run-hermes-update",
    "fixture-owner",
  );
  await f.api.runHermesUpdate();
  expect(f.invoke).toHaveBeenLastCalledWith("run-hermes-update", undefined);
});

it("delivers shared progress payloads unchanged and unsubscribes the exact preload listeners", () => {
  const f = preloadFixture();
  for (const [method, channel, progress] of [
    [
      "onInstallProgress",
      "install-progress",
      {
        operation: "update",
        requestId: "owner",
        step: 0,
        totalSteps: 0,
        title: "Updating",
        detail: "pending",
        log: "output",
      },
    ],
    [
      "onUpdateDownloadProgress",
      "update-download-progress",
      { percent: null, transferred: 4096, bytesPerSecond: 0 },
    ],
  ] as const) {
    const callback = vi.fn();
    const unsubscribe = f.api[method](callback);
    const listener = f.listeners.get(channel)!;
    listener({}, progress);
    expect(callback).toHaveBeenCalledWith(progress);
    unsubscribe();
    expect(f.removeListener).toHaveBeenLastCalledWith(channel, listener);
  }
});

it.each([
  "",
  "x".repeat(129),
  null,
  123,
  { requestId: "not-a-string" },
  "x".repeat(128),
])(
  "only accepts a nonempty bounded string update owner: %j",
  async (requestId) => {
    const send = vi.fn();
    const scope = sshUpdateFixture(async () => {});
    const run = handler(scope) as (
      event: unknown,
      owner: unknown,
    ) => Promise<unknown>;
    expect(
      await run({ sender: { isDestroyed: () => false, send } }, requestId),
    ).toEqual({ success: true });
    for (const [, progress] of send.mock.calls) {
      if (
        typeof requestId === "string" &&
        requestId.length > 0 &&
        requestId.length <= 128
      )
        expect(progress.requestId).toBe(requestId);
      else expect(progress).not.toHaveProperty("requestId");
    }
  },
);

it.each(["update", "compatibility", "gateway", "tunnel", "credential"])(
  "keeps real SSH %s failures authoritative when the sender races",
  async (failingOperation) => {
    const calls: string[] = [];
    const scope = sshUpdateFixture(async (name) => {
      calls.push(name);
      if (name === failingOperation) throw new Error(`failed ${name}`);
    });
    const send = vi.fn(() => {
      throw new Error("closed window");
    });
    expect(
      await handler(scope)({ sender: { isDestroyed: () => false, send } }),
    ).toEqual({ success: false, error: `failed ${failingOperation}` });
    expect(calls.at(-1)).toBe(failingOperation);
    expect(scope.setSshRemoteApiKey).not.toHaveBeenCalled();
    expect(scope.clearAgentCapabilityEvidence).not.toHaveBeenCalled();
  },
);

it("continues Local validation when a live sender throws while reporting output", async () => {
  const compatibility = vi.fn(() => ({ ok: true }));
  const clear = vi.fn();
  const run = handler({
    getConnectionConfig: () => ({ mode: "local" }),
    runHermesUpdate: async (emit: (p: unknown) => void) =>
      emit({
        operation: "update",
        step: 0,
        totalSteps: 0,
        title: "Updating",
        detail: "output",
        log: "output",
      }),
    ensureLocalDashboardCompatibility: compatibility,
    clearAgentCapabilityEvidence: clear,
    getActiveConnection: () => ({ connectionId: "local-fixture" }),
  });
  expect(
    await run({
      sender: {
        isDestroyed: () => false,
        send: () => {
          throw new Error("send race");
        },
      },
    }),
  ).toEqual({ success: true });
  expect(compatibility).toHaveBeenCalledOnce();
  expect(clear).toHaveBeenCalledWith("local-fixture");
});

it.each(["update", "compatibility"])(
  "preserves Local %s operation errors without a receiver",
  async (failingOperation) => {
    const clear = vi.fn();
    const run = handler({
      getConnectionConfig: () => ({ mode: "local" }),
      runHermesUpdate: async () => {
        if (failingOperation === "update")
          throw new Error("local operation failed");
      },
      ensureLocalDashboardCompatibility: () => {
        throw new Error("local operation failed");
      },
      clearAgentCapabilityEvidence: clear,
    });
    expect(
      await run({ sender: { isDestroyed: () => true, send: vi.fn() } }),
    ).toEqual({ success: false, error: "local operation failed" });
    expect(clear).not.toHaveBeenCalled();
  },
);
