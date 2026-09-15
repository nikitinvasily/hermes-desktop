import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { localListProjects } from "./projects";

// profileHome() builds on the import-time HERMES_HOME constant; mock ./utils
// per-test so the fixture dir acts as the agent home.
vi.mock("./utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils")>();
  return {
    ...actual,
    profileHome: (profile?: unknown) =>
      profile
        ? join(String(profile))
        : ((process.env.HERMES_HOME as string) ?? ""),
  };
});

// Project list read (issue #27): the local path reads the agent's projects.db
// read-only and maps rows+folders into ProjectInfo, matching the shape the
// remote/SSH paths produce from the dashboard tree.

function fixtureDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "hermes-projects-test-"));
  const db = new Database(join(dir, "projects.db"));
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT, icon TEXT, color TEXT, board_slug TEXT,
      primary_path TEXT, created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE project_folders (
      project_id TEXT NOT NULL, path TEXT NOT NULL, label TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, path)
    );
  `);
  db.prepare(
    "INSERT INTO projects (id, slug, name, primary_path, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("p_one", "one", "One", "/tmp/one", 1);
  db.prepare(
    "INSERT INTO project_folders (project_id, path, is_primary, added_at) VALUES (?, ?, 1, 1)",
  ).run("p_one", "/tmp/one");
  db.prepare(
    "INSERT INTO project_folders (project_id, path, is_primary, added_at) VALUES (?, ?, 0, 2)",
  ).run("p_one", "/tmp/one-extra");
  db.prepare(
    "INSERT INTO projects (id, slug, name, primary_path, created_at, archived) VALUES (?, ?, ?, ?, ?, 1)",
  ).run("p_arch", "arch", "Archived", "/tmp/arch", 2);
  return dir;
}

describe("localListProjects", () => {
  it("returns live projects with folders, dropping archived ones", () => {
    const dir = fixtureDb();
    process.env.HERMES_HOME = dir;
    try {
      const projects = localListProjects();
      expect(projects).toHaveLength(1);
      const project = projects[0]!;
      expect(project.id).toBe("p_one");
      expect(project.name).toBe("One");
      expect(project.primaryPath).toBe("/tmp/one");
      expect(project.folders).toEqual([
        { path: "/tmp/one", label: null, isPrimary: true },
        { path: "/tmp/one-extra", label: null, isPrimary: false },
      ]);
    } finally {
      delete process.env.HERMES_HOME;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when projects.db does not exist", () => {
    process.env.HERMES_HOME = "/nonexistent";
    try {
      expect(localListProjects()).toEqual([]);
    } finally {
      delete process.env.HERMES_HOME;
    }
  });
});
