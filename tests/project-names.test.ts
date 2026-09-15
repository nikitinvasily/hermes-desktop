import http from "http";
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, rmSync } from "fs";

// The local projects.db read uses the real better-sqlite3 driver against a
// fixture file.

vi.mock("../src/main/utils", () => ({
  profileHome: (profile?: unknown) =>
    `/tmp/hermes-project-names-test-${profile ?? "default"}`,
}));

import Database from "better-sqlite3";
import {
  localProjectFolderNames,
  mergeDesktopBindingsIntoRemoteList,
  remoteProjectFolderNames,
} from "../src/main/project-names";
import type { RemoteSessionConfig } from "../src/main/remote-sessions";
import type { CachedSession } from "../src/main/session-cache";

const HOME = "/tmp/hermes-project-names-test-default";

function seedProjectsDb(): void {
  mkdirSync(HOME, { recursive: true });
  const db = new Database(`${HOME}/projects.db`);
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      description TEXT, icon TEXT, color TEXT, board_slug TEXT,
      primary_path TEXT, created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE project_folders (
      project_id TEXT NOT NULL, path TEXT NOT NULL, label TEXT,
      is_primary INTEGER NOT NULL, added_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, path)
    );
  `);
  db.prepare(
    `INSERT INTO projects (id, slug, name, primary_path, created_at)
     VALUES ('p1', 'infra', 'Инфраструктура', '/Users/me/Documents/Hermes/infrastructure', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO project_folders (project_id, path, is_primary, added_at)
     VALUES ('p1', '/Users/me/Documents/Hermes/infrastructure', 1, 1)`,
  ).run();
  // Archived project: name must NOT leak into the mapping.
  db.prepare(
    `INSERT INTO projects (id, slug, name, primary_path, created_at, archived)
     VALUES ('p2', 'old', 'Old project', '/Users/me/old', 1, 1)`,
  ).run();
  db.close();
}

describe("localProjectFolderNames", () => {
  it("maps every live project's folders to its human name", () => {
    seedProjectsDb();
    try {
      const names = localProjectFolderNames();
      expect(names["/Users/me/Documents/Hermes/infrastructure"]).toBe(
        "Инфраструктура",
      );
      // Archived rows are excluded.
      expect(names["/Users/me/old"]).toBeUndefined();
    } finally {
      rmSync(HOME, { recursive: true, force: true });
    }
  });

  it("returns an empty map when projects.db does not exist", () => {
    rmSync(HOME, { recursive: true, force: true });
    expect(localProjectFolderNames()).toEqual({});
  });
});

// @lat: [[connections#Test specifications#Connection-explicit session browsing#Remote project names map folder paths to labels]]
describe("remoteProjectFolderNames", () => {
  it("maps project and repo folder paths to the tree's labels", async () => {
    // Serve the same shape GET /api/profiles/projects/tree returns; the
    // mapping must cover both the project's own path and its repo folder
    // paths (sessions group by either spelling).
    const server = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          projects: [
            {
              id: "/home/hermes/.hermes/workspace/diy",
              label: "DIY и мастерская",
              path: "/home/hermes/.hermes/workspace/diy",
              repos: [
                {
                  id: "/home/hermes/projects/andrei",
                  label: "ignored-repo-label",
                  groups: [],
                },
              ],
            },
            { id: "no-path", label: "No path project" },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address() as { port: number };
    const config: RemoteSessionConfig = {
      remoteUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "test-key",
    };

    try {
      const names = await remoteProjectFolderNames(config);
      expect(names["/home/hermes/.hermes/workspace/diy"]).toBe(
        "DIY и мастерская",
      );
      // Repo folders inherit the PROJECT label (the human name), not a repo id.
      expect(names["/home/hermes/projects/andrei"]).toBe("DIY и мастерская");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns an empty map when the tree endpoint fails", async () => {
    const config: RemoteSessionConfig = {
      remoteUrl: "http://127.0.0.1:1",
      apiKey: "test-key",
    };
    // A failed probe must resolve (not reject): names are display sugar.
    await expect(remoteProjectFolderNames(config)).resolves.toEqual({});
  });
});

// @lat: [[connections#Test specifications#Connection-explicit session browsing#Manual Move-to-project survives a Remote sync]]
describe("mergeDesktopBindingsIntoRemoteList", () => {
  const session = (
    id: string,
    contextFolder: string | null,
  ): CachedSession => ({
    id,
    title: id,
    startedAt: 1,
    source: "chat",
    messageCount: 1,
    model: "m",
    contextFolder,
  });

  it("applies explicit bindings and sentinels over derived remote folders", () => {
    const sessions = [
      session("derived", "/remote/cwd-folder"),
      session("moved", "/remote/cwd-folder"),
      session("unlinked", "/remote/cwd-folder"),
    ];
    const merged = mergeDesktopBindingsIntoRemoteList(
      sessions,
      new Map([
        // Explicit Move-to-project: overrides the derived folder.
        ["moved", "/Users/me/Documents/Hermes/mac"],
        // Deliberate unlink sentinel: derived folder must not resurrect.
        ["unlinked", ""],
      ]),
    );

    // Absent binding keeps the derived folder.
    expect(merged[0].contextFolder).toBe("/remote/cwd-folder");
    // Explicit binding wins.
    expect(merged[1].contextFolder).toBe("/Users/me/Documents/Hermes/mac");
    // Sentinel unlinks.
    expect(merged[2].contextFolder).toBeNull();
  });

  it("returns the list unchanged when no bindings are stored", () => {
    const sessions = [session("a", "/x")];
    expect(mergeDesktopBindingsIntoRemoteList(sessions, new Map())).toBe(
      sessions,
    );
  });
});
