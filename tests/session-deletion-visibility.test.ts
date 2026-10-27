import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { SessionDeletionVisibility } from "../src/main/session-deletion-visibility";

const source = readFileSync(
  join(__dirname, "../src/main/ipc/register.ts"),
  "utf8",
);
type Handler = (...args: unknown[]) => Promise<unknown>;
type Row = { id: string; title: string };
type SearchRow = { sessionId: string; title: string };
interface Harness {
  rows: Row[];
  read: ReturnType<typeof vi.fn<() => Promise<Row[]>>>;
  remove: ReturnType<typeof vi.fn<(id?: string) => Promise<void>>>;
  tree: ReturnType<typeof vi.fn<() => Promise<{ groups: Map<string, Row[]> }>>>;
  search: ReturnType<typeof vi.fn<() => Promise<SearchRow[]>>>;
  call: (channel: string) => Handler;
}
function handler(
  channel: string,
  dependencies: Record<string, unknown>,
): Handler {
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
    )
      expression = node.arguments[1].getText(file);
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!expression) throw new Error(`Missing handler: ${channel}`);
  const js = ts.transpileModule(`const result = ${expression}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${js}; return result;`)(
    ...Object.values(dependencies),
  );
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(mode = "remote"): Harness {
  const rows = [
    { id: "deleted", title: "Deleted chat" },
    { id: "kept", title: "Kept chat" },
  ];
  const read = vi.fn(async () => rows);
  const remove = vi.fn(async (_id?: string): Promise<void> => undefined);
  const tree = vi.fn(async () => ({ groups: new Map([["/project", rows]]) }));
  const search = vi.fn(async () =>
    rows.map((row) => ({ sessionId: row.id, title: row.title })),
  );
  const dependencies = {
    sessionDeletionVisibility: new SessionDeletionVisibility(),
    sessionConnection: () => ({ mode, ssh: { host: "host" } }),
    activeSshProfile: (profile?: string) => profile || "default",
    getActiveConnection: () => ({ connectionId: "a" }),
    scopedRemoteSessionConfig: (conn: object, profile: string) => ({
      ...conn,
      profile,
    }),
    withSshDashboardSessions: (_conn: object, operation: Handler) =>
      operation({}),
    remoteListCachedSessions: read,
    remoteListSessions: read,
    sshListCachedSessions: read,
    sshListSessions: read,
    remoteDeleteSession: remove,
    remoteDeleteSessions: async (
      _config: object,
      ids: string[],
      onDeleted?: (id: string) => void,
    ) => {
      for (const id of ids) {
        await remove(id);
        onDeleted?.(id);
      }
      return { requested: ids.length, deleted: ids.length };
    },
    remoteProjectGroupSessions: tree,
    remoteSearchSessions: search,
    sshSearchSessions: search,
    mergeRemoteBindings: (list: unknown) => list,
    regroupTreeSessionsByBindings: (groups: Map<string, unknown>) =>
      Object.fromEntries(groups),
    getAllSessionContextFolders: () => new Map(),
    getAllSessionKeyContextFolders: () => new Map(),
  };
  return {
    rows,
    read,
    remove,
    tree,
    search,
    call: (channel: string) => handler(channel, dependencies),
  };
}

describe("confirmed deletion visibility across renderer remounts", () => {
  it.each(["remote", "ssh"])(
    "filters late and fresh stale list snapshots in %s",
    async (mode) => {
      const h = harness(mode);
      const pending = deferred<typeof h.rows>();
      h.read.mockReturnValueOnce(pending.promise);
      const beforeDelete = h.call("sync-session-cache")(null, "a", "work");
      await h.call("delete-session")(null, "deleted", "a", "work");
      pending.resolve(h.rows);
      expect(
        ((await beforeDelete) as Row[]).map((row: { id: string }) => row.id),
      ).toEqual(["kept"]);
      // A newly evaluated handler stands in for another mounted renderer.
      expect(
        (
          (await h.call("list-cached-sessions")(
            null,
            50,
            0,
            "a",
            "work",
          )) as Row[]
        ).map((row: { id: string }) => row.id),
      ).toEqual(["kept"]);
      expect(
        (
          (await h.call("list-sessions")(null, 50, 0, "a", "work")) as Row[]
        ).map((row: { id: string }) => row.id),
      ).toEqual(["kept"]);
    },
  );
  it.each(["remote", "ssh"])(
    "keeps receipts isolated by connection and profile in %s",
    async (mode) => {
      const h = harness(mode);
      await h.call("delete-session")(null, "deleted", "a", "work");
      for (const [connection, profile] of [
        ["b", "work"],
        ["a", "default"],
      ]) {
        expect(
          await h.call("sync-session-cache")(null, connection, profile),
        ).toEqual(h.rows);
      }
    },
  );

  it("does not hide a pending or rejected deletion", async () => {
    const h = harness();
    const pending = deferred<undefined>();
    h.remove.mockReturnValueOnce(pending.promise);
    const deletion = h.call("delete-session")(null, "deleted", "a", "work");
    expect(await h.call("sync-session-cache")(null, "a", "work")).toEqual(
      h.rows,
    );
    pending.resolve(undefined);
    await deletion;
    h.remove.mockRejectedValueOnce(new Error("409 conflict"));
    await expect(
      h.call("delete-session")(null, "kept", "a", "work"),
    ).rejects.toThrow("409 conflict");
    expect(await h.call("sync-session-cache")(null, "a", "work")).toEqual([
      h.rows[1],
    ]);
  });

  it.each(["remote", "ssh"])(
    "filters late tree and search replies in %s",
    async (mode) => {
      const h = harness(mode);
      const treeReply = deferred<{ groups: Map<string, typeof h.rows> }>();
      const searchReply =
        deferred<Array<{ sessionId: string; title: string }>>();
      h.tree.mockReturnValueOnce(treeReply.promise);
      h.search.mockReturnValueOnce(searchReply.promise);
      const tree = h.call("list-project-group-sessions")(null, "a", "work");
      const search = h.call("search-sessions")(null, "chat", 1, "a", "work");
      await h.call("delete-session")(null, "deleted", "a", "work");
      treeReply.resolve({ groups: new Map([["/project", h.rows]]) });
      searchReply.resolve(
        h.rows.map((row) => ({ sessionId: row.id, title: row.title })),
      );
      expect(await tree).toEqual({ "/project": [h.rows[1]] });
      expect(
        ((await search) as SearchRow[]).map(
          (row: { sessionId: string }) => row.sessionId,
        ),
      ).toEqual(["kept"]);
    },
  );

  it.each(["remote", "ssh"])(
    "returns confirmed bulk receipts when the next DELETE fails in %s",
    async (mode) => {
      const h = harness(mode);
      h.remove
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("409 conflict"));
      await expect(
        h.call("delete-sessions")(null, ["deleted", "kept"], "a", "work"),
      ).resolves.toEqual({
        requested: 2,
        deleted: 1,
        deletedIds: ["deleted"],
        error: "409 conflict",
      });
      expect(await h.call("sync-session-cache")(null, "a", "work")).toEqual([
        h.rows[1],
      ]);
    },
  );

  it.each(["remote", "ssh"])(
    "rejects bulk failure without confirmed receipts in %s",
    async (mode) => {
      const h = harness(mode);
      h.remove.mockRejectedValueOnce(new Error("409 conflict"));
      await expect(
        h.call("delete-sessions")(null, ["deleted", "kept"], "a", "work"),
      ).rejects.toThrow("409 conflict");
      expect(await h.call("sync-session-cache")(null, "a", "work")).toEqual(
        h.rows,
      );
    },
  );
});
