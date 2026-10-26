import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

function handler(connection: Record<string, unknown>): {
  read: (...args: unknown[]) => unknown;
  local: ReturnType<typeof vi.fn>;
  remote: ReturnType<typeof vi.fn>;
  ssh: ReturnType<typeof vi.fn>;
} {
  const source = readFileSync(
    join(__dirname, "../src/main/ipc/register.ts"),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "register.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let expression = "";
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "ipcMain.handle" &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "list-subagent-sessions"
    )
      expression = node.arguments[1].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const local = vi.fn().mockReturnValue(["local"]);
  const remote = vi.fn().mockResolvedValue(["remote"]);
  const ssh = vi.fn().mockResolvedValue(["ssh"]);
  const deps = {
    sessionConnection: vi.fn().mockReturnValue(connection),
    activeSshProfile: (profile: string): string => profile || "default",
    listSubagentSessions: local,
    remoteListSubagentSessions: remote,
    sshListSubagentSessions: ssh,
  };
  const js = ts.transpileModule(`const result = ${expression}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const read = new Function(...Object.keys(deps), `${js}; return result;`)(
    ...Object.values(deps),
  );
  return { read, local, remote, ssh };
}
describe("list-subagent-sessions IPC routing", () => {
  it("preserves local behavior", async () => {
    const h = handler({ mode: "local" });
    expect(await h.read(null, "parent", "local-id", "work")).toEqual(["local"]);
    expect(h.local).toHaveBeenCalledWith("parent", "work");
  });
  it("routes Remote with its full authenticated config and exact profile", async () => {
    const connection = {
      mode: "remote",
      remoteAuthMode: "oauth",
      remoteUrl: "https://remote",
    };
    const h = handler(connection);
    expect(await h.read(null, "parent", "remote-id", "work")).toEqual([
      "remote",
    ]);
    expect(h.remote).toHaveBeenCalledWith(connection, "parent", "work");
    expect(h.local).not.toHaveBeenCalled();
  });
  it("routes SSH independently of the singleton dashboard tunnel", async () => {
    const config = { host: "agent", username: "user" };
    const h = handler({ mode: "ssh", ssh: config });
    expect(await h.read(null, "parent", "ssh-id", "work")).toEqual(["ssh"]);
    expect(h.ssh).toHaveBeenCalledWith(config, "parent", "work");
    expect(h.local).not.toHaveBeenCalled();
    expect(h.remote).not.toHaveBeenCalled();
  });
});
