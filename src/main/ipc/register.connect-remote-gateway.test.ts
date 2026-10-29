import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it, vi } from "vitest";

vi.mock("../utils", () => ({ getActiveProfileNameSync: () => "work" }));
vi.mock("../installer", () => ({
  HERMES_HOME: "unused",
  HERMES_PYTHON: "unused",
  hermesCliArgs: () => [],
}));
vi.mock("../config", () => ({
  getConnectionConfig: () => ({
    mode: "remote",
    remoteUrl: "https://gateway.example.test",
    remoteAuthMode: "oauth",
    apiKey: "",
  }),
  getActiveConnection: () => ({ connectionId: "remote" }),
}));
vi.mock("../hermes", () => ({
  isRemoteMode: () => true,
  isRemoteOnlyMode: () => true,
}));
vi.mock("../remote-oauth", () => ({ probeRemoteAuthMode: vi.fn() }));
vi.mock("../sessions", () => ({ expandRowsToHistory: vi.fn() }));
vi.mock("../remote-api", () => ({ remoteDashboardRequestJson: vi.fn() }));
vi.mock("../ssh-remote", () => ({ sshRunCron: vi.fn() }));

import {
  captureProfileEditorTarget,
  listCronRuns,
  withCronHistoryAuthChange,
} from "../cronjobs";

function sourceAst(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(join(process.cwd(), path), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

// Extract real source rather than reimplementing the IPC producer or preload
// subscription. Only external OAuth/Electron/config boundaries are substituted.
function connectHarness(action: () => Promise<unknown>): {
  connect: (...args: unknown[]) => Promise<unknown>;
  subscribe: (callback: () => void) => () => void;
  notify: () => boolean;
  setConnectionConfig: (...args: unknown[]) => void;
  openRemoteOAuthLogin: () => Promise<unknown>;
} {
  const renderer = new EventEmitter();
  const notify = vi.fn(() =>
    renderer.emit("connection-config-changed", {}, {}),
  );
  const setConnectionConfig = vi.fn();
  const openRemoteOAuthLogin = vi.fn(action);
  const scope = {
    ipcMain: {
      handle: (
        _channel: string,
        callback: (...args: unknown[]) => Promise<unknown>,
      ) => {
        connect = callback;
      },
    },
    context: {
      getMainWindow: () => null,
      notifyConnectionConfigChanged: notify,
    },
    probeRemoteAuthMode: async () => ({ authMode: "oauth" }),
    openRemoteOAuthLogin,
    withCronHistoryAuthChange,
    getConnectionConfig: () => ({ mode: "remote", apiKey: "" }),
    setConnectionConfig,
    resolveConnectionApiKeyUpdate: () => "",
    resetSshDashboardAvailability: vi.fn(),
    clearAgentCapabilityEvidence: vi.fn(),
    getActiveConnection: () => ({ connectionId: "remote" }),
    notifyConnectionConfigChanged: notify,
  };
  let connect!: (...args: unknown[]) => Promise<unknown>;
  const registration = sourceAst("src/main/ipc/register.ts");
  let producer: ts.CallExpression | undefined;
  const findProducer = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(registration) === "ipcMain.handle" &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "connect-remote-gateway"
    )
      producer = node;
    ts.forEachChild(node, findProducer);
  };
  findProducer(registration);
  if (!producer) throw new Error("connect-remote-gateway producer missing");
  new Function(
    ...Object.keys(scope),
    ts.transpile(producer.getText(registration), {
      target: ts.ScriptTarget.ES2022,
    }),
  )(...Object.values(scope));

  const preload = sourceAst("src/preload/index.ts");
  let subscription: ts.PropertyAssignment | undefined;
  const findSubscription = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(preload) === "onConnectionConfigChanged"
    )
      subscription = node;
    ts.forEachChild(node, findSubscription);
  };
  findSubscription(preload);
  if (!subscription) throw new Error("config subscription missing");
  const subscribe = new Function(
    "ipcRenderer",
    ts.transpile(`return (${subscription.initializer.getText(preload)});`, {
      target: ts.ScriptTarget.ES2022,
    }),
  )(renderer) as (callback: () => void) => () => void;
  return {
    connect,
    subscribe,
    notify,
    setConnectionConfig,
    openRemoteOAuthLogin,
  };
}

it.each(["success", "cancel"] as const)(
  "retires subscribed history while connect OAuth is pending and after %s",
  async (outcome) => {
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const originalError = new Error("OAuth window closed");
    const harness = connectHarness(
      () =>
        new Promise((resolve, reject) => {
          finish = () =>
            outcome === "success"
              ? resolve({ signedIn: true, original: "OAuth result" })
              : reject(originalError);
          started();
        }),
    );
    const before = captureProfileEditorTarget("work", "remote");
    let cachedOutput = "private cached history";
    const observations: string[] = [];
    const listener = vi.fn(() => {
      cachedOutput = "";
      try {
        observations.push(
          captureProfileEditorTarget("work", "remote").scopeToken,
        );
      } catch (error) {
        observations.push((error as Error).message);
      }
    });
    const unsubscribe = harness.subscribe(listener);
    const pending = harness.connect({}, "  https://gateway.example.test  ");
    // Attach rejection handling before settling OAuth, preserving error identity.
    const settled = pending.then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    );
    await entered;
    const pendingCalls = listener.mock.calls.length;
    const pendingOutput = cachedOutput;
    const fenced = await listCronRuns("job1", 1, "work", before);
    cachedOutput = "stale completion must also be retired";
    finish();
    const result = await settled;
    const after = captureProfileEditorTarget("work", "remote");
    const revoked = await listCronRuns("job1", 1, "work", before);
    unsubscribe();

    expect(result).toEqual(
      outcome === "success"
        ? { result: { connected: true, authMode: "oauth" }, error: undefined }
        : { result: undefined, error: originalError },
    );
    if (outcome === "cancel") expect(result.error).toBe(originalError);
    expect(pendingCalls).toBe(1);
    expect(pendingOutput).toBe("");
    expect(cachedOutput).toBe("");
    expect(fenced).toMatchObject({ success: false, runs: [] });
    expect(revoked).toMatchObject({ success: false, runs: [] });
    expect(after.scopeToken).not.toBe(before.scopeToken);
    expect(observations[0]).toMatch(/sign-in is changing/);
    expect(observations[1]).toBe(after.scopeToken);
    expect(listener).toHaveBeenCalledTimes(outcome === "success" ? 3 : 2);
    expect(harness.notify).toHaveBeenCalledTimes(outcome === "success" ? 3 : 2);
    expect(harness.setConnectionConfig).toHaveBeenCalledTimes(
      outcome === "success" ? 1 : 0,
    );
    expect(harness.openRemoteOAuthLogin).toHaveBeenCalledExactlyOnceWith(
      "https://gateway.example.test",
      null,
    );
    harness.notify();
    expect(listener).toHaveBeenCalledTimes(outcome === "success" ? 3 : 2);
  },
);
