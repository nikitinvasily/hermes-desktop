import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const root = join(__dirname, "..");
const source = readFileSync(join(root, "src/main/ipc/register.ts"), "utf8");
const configSource = readFileSync(join(root, "src/main/config.ts"), "utf8");
const preloadSource = readFileSync(join(root, "src/preload/index.ts"), "utf8");

type Handler = (...args: unknown[]) => unknown;
type Connection = {
  mode: string;
  remoteUrl?: string;
  ssh?: { host: string };
  sshChatTransport?: string;
};

function evaluate(
  expression: string,
  dependencies: Record<string, unknown>,
): Handler {
  const javascript = ts.transpileModule(`const result = ${expression}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(
    ...Object.keys(dependencies),
    `${javascript}; return result;`,
  )(...Object.values(dependencies));
}

function handlerExpression(channel: string): string {
  const file = ts.createSourceFile(
    "register.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let expression = "";
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(file) === "ipcMain.handle" &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === channel
    ) {
      expression = node.arguments[1].getText(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!expression) throw new Error(`Missing handler: ${channel}`);
  return expression;
}

function configFunction(name: string): string {
  const file = ts.createSourceFile(
    "config.ts",
    configSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const node = file.statements.find(
    (statement): boolean =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!node) throw new Error(`Missing config function: ${name}`);
  return node.getText(file).replace(/^export /, "");
}

function harness(activeConnectionId = "remote"): {
  read: Handler;
  library: Handler;
  spies: Record<string, ReturnType<typeof vi.fn>>;
  connections: Record<string, Connection>;
  selectConnection: (connectionId: string) => void;
} {
  const connections: Record<string, Connection> = {
    local: { mode: "local" },
    remote: { mode: "remote", remoteUrl: "https://remote.example" },
    other: { mode: "remote", remoteUrl: "https://other.example" },
    ssh: {
      mode: "ssh",
      ssh: { host: "ssh.example" },
      sshChatTransport: "auto",
    },
    sshB: {
      mode: "ssh",
      ssh: { host: "ssh-b.example" },
      sshChatTransport: "auto",
    },
    legacy: {
      mode: "ssh",
      ssh: { host: "legacy.example" },
      sshChatTransport: "legacy",
    },
  };
  // Exercise the real config lookup, including invalid/unknown-ID rejection.
  const registry = {
    activeConnectionId,
    connections: Object.entries(connections).map(([connectionId, config]) => ({
      connectionId,
      config,
    })),
  };
  const getConnection = evaluate(configFunction("getConnection"), {
    getConnectionRegistry: (): typeof registry => registry,
  });
  const getConnectionConfig = evaluate(configFunction("getConnectionConfig"), {
    getConnection,
  });
  const spies = Object.fromEntries(
    [
      "getModelConfig",
      "listModels",
      "remoteGetModelConfig",
      "remoteListModels",
      "sshGetModelConfig",
      "sshListModels",
      "ensureSshTunnel",
    ].map((name): [string, ReturnType<typeof vi.fn>] => [
      name,
      vi.fn((): string => name),
    ]),
  );
  const bridge = vi.fn(
    (
      conn: Connection,
      operation: Handler,
      legacy: Handler,
      profile?: string,
    ): unknown => {
      if (conn.sshChatTransport === "legacy") return legacy();
      (spies.ensureSshTunnel as Handler)(conn.ssh);
      return operation({ ...conn, profile });
    },
  );
  const dependencies = {
    ...spies,
    getConnectionConfig,
    getActiveProfileNameSync: (): string => "active-profile",
    activeSshProfile: (profile?: string): string =>
      profile?.trim() || "active-profile",
    withRemoteDashboard: (_conn: Connection, operation: Handler): unknown =>
      operation(),
    withSshDashboardSessions: bridge,
    withSshDashboardModelLibrary: bridge,
  };
  return {
    read: evaluate(handlerExpression("get-model-config"), dependencies),
    library: evaluate(handlerExpression("list-models"), dependencies),
    spies,
    connections,
    selectConnection: (connectionId: string): void => {
      registry.activeConnectionId = connectionId;
    },
  };
}

function preloadMethod(name: string, invoke: Handler): Handler {
  const file = ts.createSourceFile(
    "preload.ts",
    preloadSource,
    ts.ScriptTarget.Latest,
    true,
  );
  let expression = "";
  function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === name) {
      expression = node.initializer.getText(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!expression) throw new Error(`Missing preload method: ${name}`);
  return evaluate(expression, { ipcRenderer: { invoke } });
}

describe("connection-scoped model reads", () => {
  it.each(["local", "remote"])(
    "routes explicit remote reads independently of active %s",
    (active) => {
      const { read, library, spies, connections } = harness(active);
      read(null, "work", "other");
      library(null, "other", "work");
      expect(spies.remoteGetModelConfig).toHaveBeenCalledWith({
        ...connections.other,
        profile: "work",
      });
      expect(spies.remoteListModels).toHaveBeenCalledWith({
        ...connections.other,
        profile: "work",
      });
      expect(spies.getModelConfig).not.toHaveBeenCalled();
      expect(spies.listModels).not.toHaveBeenCalled();
    },
  );

  it.each(["", "missing", null, false, 42, {}])(
    "rejects invalid/unknown explicit connection %j without reading any models",
    (connectionId) => {
      const { read, library, spies } = harness();
      expect(() => read(null, "work", connectionId)).toThrow(/connection/i);
      expect(() => library(null, connectionId, "work")).toThrow(/connection/i);
      for (const spy of Object.values(spies))
        expect(spy).not.toHaveBeenCalled();
    },
  );

  it("preserves omitted-connection behavior and local default profile", () => {
    const { read, library, spies } = harness("local");
    read(null, "work");
    library(null);
    expect(spies.getModelConfig).toHaveBeenCalledWith("work");
    expect(spies.listModels).toHaveBeenCalledWith("active-profile");
  });

  it("preserves omitted-argument remote reads", () => {
    const { read, library, spies, connections } = harness();
    read(null);
    library(null);
    expect(spies.remoteGetModelConfig).toHaveBeenCalledWith(connections.remote);
    expect(spies.remoteListModels).toHaveBeenCalledWith(connections.remote);
  });

  it("routes explicit SSH legacy reads without consulting the active remote", () => {
    const { read, library, spies, connections } = harness();
    read(null, "work", "legacy");
    library(null, "legacy", "work");
    expect(spies.sshGetModelConfig).toHaveBeenCalledWith(
      connections.legacy.ssh,
      "work",
    );
    expect(spies.sshListModels).toHaveBeenCalledWith(connections.legacy.ssh);
    expect(spies.remoteGetModelConfig).not.toHaveBeenCalled();
    expect(spies.remoteListModels).not.toHaveBeenCalled();
  });

  it("scopes unscoped SSH dashboard config reads to the supplied profile", () => {
    const { read, spies, connections } = harness("ssh");
    read(null, "work");
    expect(spies.remoteGetModelConfig).toHaveBeenCalledWith({
      ...connections.ssh,
      profile: "work",
    });
    expect(spies.getModelConfig).not.toHaveBeenCalled();
  });

  it("uses the active profile for SSH library calls without a supplied profile", () => {
    const { library, spies, connections } = harness("ssh");
    library(null);
    expect(spies.remoteListModels).toHaveBeenCalledWith({
      ...connections.ssh,
      profile: "active-profile",
    });
  });

  it("reads an explicit local library and supplied profile while remote is active", () => {
    const { library, spies } = harness();
    expect(library(null, "local", "work")).toBe("listModels");
    expect(spies.listModels).toHaveBeenCalledWith("work");
    expect(spies.remoteListModels).not.toHaveBeenCalled();
  });

  it("scopes the unscoped SSH dashboard library to the supplied profile", () => {
    const { library, spies, connections } = harness("ssh");
    library(null, undefined, "work");
    expect(spies.remoteListModels).toHaveBeenCalledWith({
      ...connections.ssh,
      profile: "work",
    });
    expect(spies.listModels).not.toHaveBeenCalled();
  });

  it.each([
    ["ssh", "auto"],
    ["ssh", "dashboard"],
    ["sshB", "auto"],
    ["sshB", "dashboard"],
  ])(
    "avoids the singleton tunnel for explicit SSH A reads with active %s (%s)",
    (active, transport) => {
      const { read, library, spies, connections } = harness(active);
      connections.ssh.sshChatTransport = transport;

      expect(read(null, "work", "ssh")).toBe("sshGetModelConfig");
      expect(library(null, "ssh", "work")).toBe("sshListModels");
      expect(spies.sshGetModelConfig).toHaveBeenCalledWith(
        connections.ssh.ssh,
        "work",
      );
      // The legacy library API intentionally has no profile parameter.
      expect(spies.sshListModels).toHaveBeenCalledWith(connections.ssh.ssh);
      expect(spies.ensureSshTunnel).not.toHaveBeenCalled();
      expect(spies.remoteGetModelConfig).not.toHaveBeenCalled();
      expect(spies.remoteListModels).not.toHaveBeenCalled();

      // Unscoped callers retain the active connection's dashboard path.
      read(null, "work");
      library(null, undefined, "work");
      expect(spies.ensureSshTunnel).toHaveBeenCalledTimes(2);
      expect(spies.ensureSshTunnel).toHaveBeenNthCalledWith(
        1,
        connections[active].ssh,
      );
      expect(spies.ensureSshTunnel).toHaveBeenNthCalledWith(
        2,
        connections[active].ssh,
      );
      expect(spies.remoteGetModelConfig).toHaveBeenCalledWith({
        ...connections[active],
        profile: "work",
      });
      expect(spies.remoteListModels).toHaveBeenCalledWith({
        ...connections[active],
        profile: "work",
      });
    },
  );

  it("does not acquire A's tunnel when scoped reads finish after selecting B", async () => {
    const { read, library, spies, connections, selectConnection } =
      harness("ssh");
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    spies.sshGetModelConfig.mockReturnValue(pending);
    spies.sshListModels.mockReturnValue(pending);
    const configRead = read(null, "work", "ssh");
    const libraryRead = library(null, "ssh", "work");
    selectConnection("sshB");
    finish();
    await Promise.all([configRead, libraryRead]);
    expect(spies.sshGetModelConfig).toHaveBeenCalledWith(
      connections.ssh.ssh,
      "work",
    );
    expect(spies.sshListModels).toHaveBeenCalledWith(connections.ssh.ssh);
    expect(spies.ensureSshTunnel).not.toHaveBeenCalled();
    expect(spies.remoteGetModelConfig).not.toHaveBeenCalled();
    expect(spies.remoteListModels).not.toHaveBeenCalled();

    read(null, "work");
    library(null, undefined, "work");
    expect(spies.ensureSshTunnel).toHaveBeenCalledTimes(2);
    expect(spies.ensureSshTunnel).toHaveBeenNthCalledWith(
      1,
      connections.sshB.ssh,
    );
    expect(spies.ensureSshTunnel).toHaveBeenNthCalledWith(
      2,
      connections.sshB.ssh,
    );
  });

  it("does not establish a dashboard tunnel for an inactive SSH library read", () => {
    const { library, spies, connections } = harness("sshB");
    expect(library(null, "ssh", "work")).toBe("sshListModels");
    expect(spies.sshListModels).toHaveBeenCalledWith(connections.ssh.ssh);
    expect(spies.ensureSshTunnel).not.toHaveBeenCalled();
  });

  it("forwards the library connection and profile through preload", () => {
    const invoke = vi.fn();
    preloadMethod("listModels", invoke)("local", "work");
    expect(invoke).toHaveBeenCalledWith("list-models", "local", "work");
  });

  it("reads an explicit local model config while a remote connection is active", () => {
    const { read, spies } = harness();
    expect(read(null, "work", "local")).toBe("getModelConfig");
    expect(spies.getModelConfig).toHaveBeenCalledWith("work");
    expect(spies.remoteGetModelConfig).not.toHaveBeenCalled();
  });

  it("forwards the model-config connection scope through preload", () => {
    const invoke = vi.fn();
    preloadMethod("getModelConfig", invoke)("work", "local");
    expect(invoke).toHaveBeenCalledWith("get-model-config", "work", "local");
  });
});
