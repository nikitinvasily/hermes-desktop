// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";

const { testHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path");
  return {
    testHome: fs.mkdtempSync(path.join(os.tmpdir(), "hermes-subagents-")),
  };
});

vi.mock("../src/main/installer", () => ({ HERMES_HOME: testHome }));
vi.mock("../src/main/locale", () => ({ getAppLocale: () => "en" }));
vi.mock("../src/shared/i18n", () => ({ t: (key: string) => key }));
vi.mock("../src/main/utils", () => ({
  profileHome: (profile?: unknown) =>
    profile && profile !== "default"
      ? join(testHome, "profiles", String(profile))
      : testHome,
  activeStateDbPath: (profile?: unknown) =>
    join(
      profile && profile !== "default"
        ? join(testHome, "profiles", String(profile))
        : testHome,
      "state.db",
    ),
  getActiveProfileNameSync: () => "default",
  safeWriteFile: (path: string, data: string) => writeFileSync(path, data),
}));

// Execute the real queries with Node 22's SQLite engine. The application
// rebuilds better-sqlite3 for Electron, whose ABI differs from the test runner.
vi.mock("better-sqlite3", () => ({
  default: class {
    private db: DatabaseSync;
    constructor(path: string, options?: { readonly?: boolean }) {
      this.db = new DatabaseSync(path, { readOnly: options?.readonly });
    }
    prepare(sql: string): ReturnType<DatabaseSync["prepare"]> {
      return this.db.prepare(sql);
    }
    close(): void {
      this.db.close();
    }
  },
}));

import { closeDbConnection, sessionSubagentPredicate } from "../src/main/db";
import { listSessions } from "../src/main/sessions";
import {
  listCachedSessions,
  syncSessionCache,
} from "../src/main/session-cache";

const databases: DatabaseSync[] = [];

function seedProfile(
  options: { lineageColumns?: boolean; archivedColumn?: boolean } = {},
): DatabaseSync {
  const { lineageColumns = true, archivedColumn = true } = options;
  mkdirSync(join(testHome, "desktop"), { recursive: true });
  const db = new DatabaseSync(join(testHome, "state.db"));
  databases.push(db);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT DEFAULT 'desktop', started_at REAL,
      ended_at REAL, message_count INTEGER DEFAULT 1,
      model TEXT DEFAULT 'test-model', title TEXT,
      cwd TEXT, git_repo_root TEXT
      ${archivedColumn ? ", archived INTEGER NOT NULL DEFAULT 0" : ""}
      ${
        lineageColumns
          ? ", parent_session_id TEXT, model_config TEXT"
          : ""
      }
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
      timestamp REAL, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
      reasoning TEXT, reasoning_content TEXT, reasoning_details TEXT,
      display_kind TEXT
    );
  `);
  return db;
}

function addSession(
  db: DatabaseSync,
  id: string,
  startedAt: number,
  extra: { parentSessionId?: string; modelConfig?: object | null } = {},
): void {
  db.prepare(
    `INSERT INTO sessions (id, started_at${
      "parentSessionId" in extra || "modelConfig" in extra
        ? ", parent_session_id, model_config"
        : ""
    }) VALUES (?, ?${
      "parentSessionId" in extra || "modelConfig" in extra ? ", ?, ?" : ""
    })`,
  ).run(
    id,
    startedAt,
    ...("parentSessionId" in extra || "modelConfig" in extra
      ? [
          extra.parentSessionId ?? null,
          extra.modelConfig === undefined || extra.modelConfig === null
            ? null
            : JSON.stringify(extra.modelConfig),
        ]
      : []),
  );
  db.prepare(
    "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', ?, ?)",
  ).run(id, `Message for ${id}`, startedAt);
}

beforeEach(() => mkdirSync(testHome, { recursive: true }));
afterEach(() => {
  closeDbConnection();
  for (const db of databases.splice(0)) db.close();
  rmSync(testHome, { recursive: true, force: true });
});

describe("subagent session visibility (issue #95)", () => {
  it("hides delegate subagent rows from the local list and cache sync", () => {
    const db = seedProfile();
    addSession(db, "root", 100);
    addSession(db, "sub", 200, {
      parentSessionId: "root",
      modelConfig: { _delegate_from: "root" },
    });
    // Branch child: parent_session_id set but a different marker — stays visible.
    addSession(db, "branch", 300, {
      parentSessionId: "root",
      modelConfig: { _branched_from: "root" },
    });
    // Lineage child WITHOUT the delegate marker (e.g. legacy rows): visible.
    addSession(db, "untagged", 400, { parentSessionId: "root" });

    const listed = listSessions(50, 0).map((s) => s.id);
    expect(listed).toEqual(["untagged", "branch", "root"]);
    expect(listed).not.toContain("sub");

    syncSessionCache();
    const cached = listCachedSessions().map((s) => s.id);
    expect(cached).toEqual(["untagged", "branch", "root"]);
    expect(cached).not.toContain("sub");
  });

  it("keeps malformed model_config JSON from crashing the list", () => {
    const db = seedProfile();
    addSession(db, "root", 100);
    db.prepare(
      "INSERT INTO sessions (id, started_at, parent_session_id, model_config) VALUES (?, ?, ?, ?)",
    ).run("broken", 200, "root", "not-json{{{");
    db.prepare(
      "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', ?, ?)",
    ).run("broken", "msg", 200);

    const listed = listSessions(50, 0).map((s) => s.id);
    // Malformed JSON has no _delegate_from marker → not a subagent → visible.
    expect(listed).toContain("broken");
    expect(listed).toContain("root");
  });

  it("returns a pass-through predicate for legacy schemas without lineage columns", () => {
    seedProfile({ lineageColumns: false });
    const db = new DatabaseSync(join(testHome, "state.db"));
    expect(sessionSubagentPredicate(db as never)).toBe("1 = 1");
    db.close();
  });
});
