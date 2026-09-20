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
    testHome: fs.mkdtempSync(path.join(os.tmpdir(), "hermes-subagent-list-")),
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

const { gatewayEpochRef } = vi.hoisted(() => ({
  gatewayEpochRef: { value: null as number | null },
}));
vi.mock("../src/main/hermes", () => ({
  tuiGatewayStartedAt: () => gatewayEpochRef.value,
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

import { closeDbConnection } from "../src/main/db";
import { listSubagentSessions } from "../src/main/sessions";

const databases: DatabaseSync[] = [];

function seedDb(): DatabaseSync {
  const db = new DatabaseSync(join(testHome, "state.db"));
  databases.push(db);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT DEFAULT 'desktop', started_at REAL,
      ended_at REAL, message_count INTEGER DEFAULT 1, model TEXT, title TEXT,
      parent_session_id TEXT, model_config TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
      timestamp REAL
    );
  `);
  return db;
}

function addSession(
  db: DatabaseSync,
  id: string,
  startedAt: number,
  extra: {
    parentSessionId?: string | null;
    modelConfig?: object | null;
    endedAt?: number | null;
    firstUserMessage?: string | null;
  } = {},
): void {
  db.prepare(
    "INSERT INTO sessions (id, started_at, ended_at, parent_session_id, model_config) VALUES (?, ?, ?, ?, ?)",
  ).run(
    id,
    startedAt,
    extra.endedAt ?? null,
    extra.parentSessionId ?? null,
    extra.modelConfig === undefined || extra.modelConfig === null
      ? null
      : JSON.stringify(extra.modelConfig),
  );
  if (extra.firstUserMessage !== null) {
    db.prepare(
      "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', ?, ?)",
    ).run(id, extra.firstUserMessage ?? `Goal for ${id}`, startedAt);
  }
}

beforeEach(() => mkdirSync(testHome, { recursive: true }));
afterEach(() => {
  closeDbConnection();
  for (const db of databases.splice(0)) db.close();
  rmSync(testHome, { recursive: true, force: true });
});

describe("listSubagentSessions (issue #122)", () => {
  it("lists delegate children of the parent with goal titles and status", () => {
    const db = seedDb();
    addSession(db, "parent", 100);
    addSession(db, "child-a", 200, {
      parentSessionId: "parent",
      modelConfig: { _delegate_from: "parent" },
      endedAt: 300,
      firstUserMessage: "Audit the fork diff for закладки",
    });
    addSession(db, "child-b", 250, {
      parentSessionId: "parent",
      modelConfig: { _delegate_from: "parent" },
    });

    const rows = listSubagentSessions("parent");

    expect(rows.map((r) => r.id)).toEqual(["child-a", "child-b"]);
    expect(rows[0]).toMatchObject({
      id: "child-a",
      startedAt: 200,
      endedAt: 300,
      title: "Audit the fork diff for закладки",
    });
    expect(rows[1].endedAt).toBeNull();
  });

  it("excludes non-delegate lineage children and other parents", () => {
    const db = seedDb();
    addSession(db, "parent", 100);
    // Branch/compression child: parent_session_id WITHOUT the delegate marker.
    addSession(db, "branch-child", 150, {
      parentSessionId: "parent",
      modelConfig: { _branched_from: "parent" },
    });
    // Delegate of a DIFFERENT parent.
    addSession(db, "other-child", 180, {
      parentSessionId: "other",
      modelConfig: { _delegate_from: "other" },
    });

    expect(listSubagentSessions("parent")).toEqual([]);
  });

  it("clamps long goals to a single line", () => {
    const db = seedDb();
    addSession(db, "parent", 100);
    addSession(db, "child", 200, {
      parentSessionId: "parent",
      modelConfig: { _delegate_from: "parent" },
      firstUserMessage: `${"x".repeat(120)}\n\nsecond line`,
    });

    const rows = listSubagentSessions("parent");
    expect(rows[0].title.length).toBe(80);
    expect(rows[0].title.endsWith("…")).toBe(true);
    expect(rows[0].title).not.toContain("\n");
  });

  it("returns [] on legacy schemas without lineage columns", () => {
    const db = new DatabaseSync(join(testHome, "state.db"));
    databases.push(db);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT DEFAULT 'desktop', started_at REAL,
        ended_at REAL, message_count INTEGER DEFAULT 1, model TEXT, title TEXT
      );
    `);

    expect(listSubagentSessions("parent")).toEqual([]);
  });

  it("marks never-ended children that predate the current gateway generation as died (issue #128)", () => {
    const db = seedDb();
    addSession(db, "parent", 100);
    // Old generation: started at t=200 (s), gateway restarted at t=250 (ms
    // epoch 250_000), row never got an ended_at → died with the restart.
    addSession(db, "child-dead", 200, {
      parentSessionId: "parent",
      modelConfig: { _delegate_from: "parent" },
    });
    // Current generation: started AFTER the restart, no ended_at yet — may
    // genuinely still be running, must NOT be marked died.
    addSession(db, "child-live", 300, {
      parentSessionId: "parent",
      modelConfig: { _delegate_from: "parent" },
    });
    // Old generation but properly ended — already settled, not died.
    addSession(db, "child-done", 150, {
      parentSessionId: "parent",
      modelConfig: { _delegate_from: "parent" },
      endedAt: 240,
    });

    gatewayEpochRef.value = 250_000;
    try {
      const rows = listSubagentSessions("parent");
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get("child-dead")?.died).toBe(true);
      expect(byId.get("child-live")?.died).toBe(false);
      expect(byId.get("child-done")?.died).toBe(false);
    } finally {
      gatewayEpochRef.value = null;
    }
  });

  it("marks nothing died while the gateway generation is unknown", () => {
    const db = seedDb();
    addSession(db, "parent", 100);
    addSession(db, "child", 200, {
      parentSessionId: "parent",
      modelConfig: { _delegate_from: "parent" },
    });

    gatewayEpochRef.value = null;
    const rows = listSubagentSessions("parent");
    expect(rows[0].died).toBe(false);
  });
});
