import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SshConfig } from "../src/main/ssh-tunnel";
import type { ConnectionConfig } from "../src/main/config";

const request = vi.hoisted(() => vi.fn());
const exec = vi.hoisted(() => vi.fn());
vi.mock("../src/main/remote-api", () => ({
  remoteDashboardRequestJson: request,
}));
vi.mock("../src/main/ssh-remote", () => ({
  sshExec: exec,
  shellQuote: (s: string): string => `'${s.replace(/'/g, "'\"'\"'")}'`,
}));
import {
  remoteListSubagentSessions,
  sshListSubagentSessions,
} from "../src/main/subagent-sessions-remote";
const connection = {
  mode: "remote",
  remoteUrl: "https://agent.example",
  remoteAuthMode: "oauth",
  apiKey: "",
} as ConnectionConfig;
const row = (id: string, started_at = 1): Record<string, unknown> => ({
  id,
  started_at,
  ended_at: null,
  title: "fallback",
  delegation_goal: "real\n goal",
  model: "model",
  message_count: 2,
  parent_session_id: "parent",
  delegation_parent_id: "parent",
});
beforeEach(() => vi.resetAllMocks());
describe("remote subagent sessions", () => {
  it.each([undefined, "other"])(
    "rejects absent/wrong server parent receipt %s",
    async (parent_id) => {
      request.mockResolvedValue({
        parent_id,
        sessions: [row("child")],
        total: 1,
      });
      expect(
        await remoteListSubagentSessions(connection, "parent", "work"),
      ).toEqual([]);
    },
  );
  it("fails closed for incomplete pagination instead of publishing a partial roster", async () => {
    request
      .mockResolvedValueOnce({
        parent_id: "parent",
        sessions: [row("first")],
        total: 2,
      })
      .mockResolvedValueOnce({ parent_id: "parent", sessions: [], total: 2 });
    await expect(
      remoteListSubagentSessions(connection, "parent", "work"),
    ).rejects.toThrow(/pagination/i);
  });
  it("rejects malformed totals rather than scanning indefinitely", async () => {
    request.mockResolvedValue({
      parent_id: "parent",
      sessions: [],
      total: "unknown",
    });
    await expect(
      remoteListSubagentSessions(connection, "parent", "work"),
    ).rejects.toThrow(/response/i);
  });
  it("does not request an empty parent or allow SSH profile traversal", async () => {
    request.mockResolvedValue({
      parent_id: "parent",
      sessions: [row("wrong")],
      total: 1,
    });
    exec.mockResolvedValue("[]");
    expect(await remoteListSubagentSessions(connection, "", "work")).toEqual(
      [],
    );
    await expect(
      sshListSubagentSessions({} as SshConfig, "parent", "../default"),
    ).rejects.toThrow(/profile/i);
    expect(request).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
  it("propagates authentication failures rather than returning local or empty data", async () => {
    const error = new Error("401: session_expired");
    request.mockRejectedValue(error);
    await expect(
      remoteListSubagentSessions(connection, "parent", "work"),
    ).rejects.toBe(error);
    expect(exec).not.toHaveBeenCalled();
  });
  it("SSH reads only delegate children in the selected profile, from agent-root cwd", async () => {
    const home = mkdtempSync(join(process.env.TMPDIR!, "subagents space "));
    try {
      const root = join(home, ".hermes/hermes-agent");
      mkdirSync(join(root, "venv/bin"), { recursive: true });
      const python = execFileSync("which", ["python3"], {
        encoding: "utf8",
      }).trim();
      writeFileSync(
        join(root, "venv/bin/python"),
        `#!/bin/sh\n[ "$PWD" = "$HOME/.hermes/hermes-agent" ] || exit 47\nexec '${python}' "$@"\n`,
        { mode: 0o755 },
      );
      mkdirSync(join(home, ".hermes/profiles/work"), { recursive: true });
      execFileSync(python, [
        "-c",
        `import sqlite3,sys,json
for profile in ("", "/profiles/work"):
 c=sqlite3.connect(sys.argv[1]+"/.hermes"+profile+"/state.db")
 c.executescript("CREATE TABLE sessions(id TEXT,parent_session_id TEXT,model_config TEXT,started_at REAL,ended_at REAL,title TEXT,model TEXT,message_count INTEGER); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT);")
 for id,parent,config in [("child" if profile else "wrong-profile","parent",json.dumps({"_delegate_from":"parent"})),("wrong-parent","other",json.dumps({"_delegate_from":"parent"})),("ordinary","parent","{}")]:
  c.execute("INSERT INTO sessions VALUES(?,?,?,1,NULL,'title','model',2)",(id,parent,config))
  c.execute("INSERT INTO messages VALUES(1,?,'user','delegation goal')",(id,))
 c.commit();c.close()
`,
        home,
      ]);
      exec.mockImplementation(
        async (
          _config: SshConfig,
          command: string,
          input: string,
        ): Promise<string> =>
          execFileSync("/bin/sh", ["-c", command], {
            input,
            env: { ...process.env, HOME: home },
            encoding: "utf8",
          }),
      );
      expect(
        await sshListSubagentSessions(
          { host: "test", username: "user", port: 22 } as SshConfig,
          "parent",
          "work",
        ),
      ).toEqual([
        {
          id: "child",
          startedAt: 1,
          endedAt: null,
          title: "delegation goal",
          model: "model",
          messageCount: 2,
        },
      ]);
      expect(request).not.toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it("collects every page before sorting newest-first with deterministic ties", async () => {
    request
      .mockResolvedValueOnce({
        parent_id: "parent",
        sessions: [
          row("z", 1),
          { ...row("noise"), parent_session_id: "other" },
        ],
        total: 4,
      })
      .mockResolvedValueOnce({
        parent_id: "parent",
        sessions: [
          row("b", 8),
          { ...row("a", 8), delegation_parent_id: "parent" },
        ],
        total: 4,
      });
    expect(
      (await remoteListSubagentSessions(connection, "parent", "work")).map(
        (s) => s.id,
      ),
    ).toEqual(["a", "b", "z"]);
    expect(request.mock.calls.map((c) => c[1])).toEqual([
      "/api/sessions?parent_id=parent&archived=include&limit=100&offset=0",
      "/api/sessions?parent_id=parent&archived=include&limit=100&offset=2",
    ]);
  });
  it("rejects unrelated and unverifiable rows on old servers ignoring parent_id", async () => {
    request.mockResolvedValue({
      parent_id: "parent",
      sessions: [
        row("valid"),
        { ...row("wrong-parent"), parent_session_id: "other" },
        { ...row("ordinary"), delegation_parent_id: null },
        { id: "legacy", title: "not proof" },
        { ...row("broken-json"), delegation_parent_id: "other" },
        { ...row("null-marker"), delegation_parent_id: null },
      ],
      total: 6,
    });
    expect(
      (await remoteListSubagentSessions(connection, "parent", "work")).map(
        (s) => s.id,
      ),
    ).toEqual(["valid"]);
  });
  it("uses the authenticated connection/profile boundary and normalizes a delegate", async () => {
    request.mockResolvedValue({
      parent_id: "parent",
      sessions: [row("child")],
      total: 1,
    });
    expect(
      await remoteListSubagentSessions(connection, "parent", "work"),
    ).toEqual([
      {
        id: "child",
        startedAt: 1,
        endedAt: null,
        title: "real goal",
        model: "model",
        messageCount: 2,
      },
    ]);
    expect(request).toHaveBeenCalledWith(
      connection,
      "/api/sessions?parent_id=parent&archived=include&limit=100&offset=0",
      {},
      "work",
    );
  });
});
