import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listArchivedSessions, setSessionArchived } from "./sessions";

// profileHome() builds on the import-time HERMES_HOME constant; mock ./utils
// per-test so the fixture dir acts as the agent home (pattern: projects.test.ts).
vi.mock("./utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils")>();
  return {
    ...actual,
    profileHome: (profile?: unknown) =>
      profile
        ? join(String(profile))
        : ((process.env.HERMES_HOME as string) ?? ""),
    activeStateDbPath: () => join(process.env.HERMES_HOME ?? "", "state.db"),
  };
});

// Session archiving (issue #34): the local path flips the agent's own
// `archived` flag in state.db and lists archived rows newest-first. Older
// databases without the column are a no-op (false / []) rather than an error.

let home = "";

function fixtureDb(withArchivedColumn: boolean): void {
  const db = new Database(join(home, "state.db"));
  const archivedColumn = withArchivedColumn
    ? ", archived INTEGER NOT NULL DEFAULT 0"
    : "";
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT, started_at INTEGER NOT NULL,
      ended_at INTEGER, message_count INTEGER NOT NULL DEFAULT 0,
      model TEXT, title TEXT, cwd TEXT, git_repo_root TEXT${archivedColumn}
    );
  `);
  db.prepare(
    "INSERT INTO sessions (id, source, started_at, message_count, title) VALUES (?, 'cli', ?, 2, ?)",
  ).run("s_old", 100, "Older chat");
  db.prepare(
    "INSERT INTO sessions (id, source, started_at, message_count, title) VALUES (?, 'cli', ?, 1, ?)",
  ).run("s_new", 200, "Newer chat");
  db.close();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hermes-archive-test-"));
  process.env.HERMES_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.HERMES_HOME;
});

describe("setSessionArchived", () => {
  it("flips the archived flag and reports rows changed", () => {
    fixtureDb(true);
    expect(setSessionArchived("s_new", true)).toBe(true);
    const db = new Database(join(home, "state.db"), { readonly: true });
    const row = db
      .prepare("SELECT archived FROM sessions WHERE id = ?")
      .get("s_new") as { archived: number };
    db.close();
    expect(row.archived).toBe(1);
  });

  it("returns false for an unknown session id", () => {
    fixtureDb(true);
    expect(setSessionArchived("s_missing", true)).toBe(false);
  });

  it("is a no-op on databases without the archived column", () => {
    fixtureDb(false);
    expect(setSessionArchived("s_new", true)).toBe(false);
  });
});

describe("listArchivedSessions", () => {
  it("lists only archived sessions, newest first", () => {
    fixtureDb(true);
    setSessionArchived("s_old", true);
    setSessionArchived("s_new", true);
    const rows = listArchivedSessions();
    expect(rows.map((r) => r.id)).toEqual(["s_new", "s_old"]);
    expect(rows[0]).toMatchObject({
      title: "Newer chat",
      startedAt: 200,
      messageCount: 1,
    });
  });

  it("returns [] on databases without the archived column", () => {
    fixtureDb(false);
    expect(listArchivedSessions()).toEqual([]);
  });

  it("derives contextFolder as git_repo_root || cwd (issue #64)", () => {
    fixtureDb(true);
    const db = new Database(join(home, "state.db"));
    db.prepare(
      "UPDATE sessions SET cwd = ?, git_repo_root = ? WHERE id = 's_old'",
    ).run("/Users/x/work/repo", "/Users/x/work/repo");
    db.prepare(
      "UPDATE sessions SET cwd = ?, git_repo_root = NULL WHERE id = 's_new'",
    ).run("/Users/x/other");
    db.close();
    setSessionArchived("s_old", true);
    setSessionArchived("s_new", true);
    const rows = listArchivedSessions();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("s_old")?.contextFolder).toBe("/Users/x/work/repo");
    expect(byId.get("s_new")?.contextFolder).toBe("/Users/x/other");
  });
});
