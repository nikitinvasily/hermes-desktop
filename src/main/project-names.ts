import { join } from "path";
import { existsSync } from "fs";
import WebSocket from "ws";
import Database from "better-sqlite3";
import { profileHome } from "./utils";
import { remoteRequestJson, type RemoteSessionConfig } from "./remote-sessions";
import { freshDashboardWebSocketUrl } from "./dashboard";
import type { CachedSession } from "./session-cache";

/**
 * Folder path → human project name mapping (issue #23).
 *
 * The agent core keeps user-defined projects in `projects.db`
 * (`projects.name`, `projects.primary_path`, `project_folders.path`). The
 * sidebar groups sessions by folder path, so without this mapping it shows
 * the raw path's last segment (a slug like `infrastructure`) instead of the
 * user's chosen name (`Инфраструктура`).
 *
 * Sources, by connection mode:
 *  - Local: query `projects.db` directly (one tiny SELECT).
 *  - Remote/SSH dashboard: GET `/api/profiles/projects/tree` — every
 *    project node carries `label` (the name) plus its folder path and repo
 *    paths, so the mapping covers every folder spelling.
 *  - SSH legacy fallback: parse the remote `projects.db` with python3.
 */

export type ProjectFolderNames = Record<string, string>;

function mergeInto(
  target: ProjectFolderNames,
  path: unknown,
  name: unknown,
): void {
  const key = typeof path === "string" ? path.trim() : "";
  const value = typeof name === "string" ? name.trim() : "";
  if (key && value) target[key] = value;
}

/** Local `projects.db` read: project name plus every linked folder path. */
export function localProjectFolderNames(profile?: unknown): ProjectFolderNames {
  const result: ProjectFolderNames = {};
  try {
    const dbPath = join(profileHome(profile), "projects.db");
    if (!existsSync(dbPath)) return result;
    // better-sqlite3 is already a main-process dependency (state.db access);
    // opening projects.db read-only keeps this side-effect free.
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(
          `SELECT p.name AS name, p.primary_path AS ppath, f.path AS fpath
           FROM projects p
           LEFT JOIN project_folders f ON f.project_id = p.id
           WHERE p.archived = 0`,
        )
        .all() as Array<{
        name: string;
        ppath: string | null;
        fpath: string | null;
      }>;
      for (const row of rows) {
        mergeInto(result, row.ppath, row.name);
        mergeInto(result, row.fpath, row.name);
      }
    } finally {
      db.close();
    }
  } catch {
    // Names are display sugar — a missing/corrupt db leaves the slug fallback.
  }
  return result;
}

/**
 * Merge desktop-side Move-to-project bindings into a Remote/SSH session
 * list. Remote rows derive their folder from the agent's own workspace data
 * (issue #15); the desktop binding store is local-only, so without this
 * merge a manual Move-to-project over SSH silently reverts on the next sync
 * (issue #23). Precedence mirrors the Local sync: explicit binding wins,
 * empty sentinel = deliberate unlink, absent = keep the derived folder.
 */
export function mergeDesktopBindingsIntoRemoteList(
  sessions: CachedSession[],
  bindings: Map<string, string>,
): CachedSession[] {
  if (bindings.size === 0) return sessions;
  return sessions.map((session) => {
    if (!bindings.has(session.id)) return session;
    const bound = bindings.get(session.id) || null;
    return bound === session.contextFolder
      ? session
      : { ...session, contextFolder: bound };
  });
}

/**
 * Re-home a session's workspace ON THE AGENT (issue #23): calls the gateway
 * JSON-RPC `session.workspace.move` over the dashboard WebSocket, which
 * rewrites the session's `cwd`/`git_branch`/`git_repo_root` in the agent's
 * own state.db. This is what actually moves the chat's working directory —
 * the desktop-side binding only controls sidebar grouping.
 *
 * Best-effort by design: when the dashboard is unreachable the caller keeps
 * the desktop-side grouping change, and the remote cwd stays as it was.
 */
export async function moveSessionWorkspaceOnAgent(
  profile: string | undefined,
  connectionId: string | undefined,
  sessionId: string,
  folder: string | null,
): Promise<boolean> {
  if (!folder) return false; // Unlink is desktop-side only; nothing to move.
  let wsUrl: string;
  try {
    wsUrl = await freshDashboardWebSocketUrl(profile, connectionId);
  } catch {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const socket = new WebSocket(wsUrl);
    const requestId = 1;
    const timer = setTimeout(() => {
      socket.terminate();
      resolve(false);
    }, 15_000);
    timer.unref?.();
    const finish = (ok: boolean): void => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(ok);
    };
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method: "session.workspace.move",
          params: { session_key: sessionId, cwd: folder },
        }),
      );
    });
    socket.on("message", (data) => {
      try {
        const frame = JSON.parse(String(data)) as {
          id?: number;
          error?: { message?: string };
        };
        if (frame.id !== requestId) return;
        finish(!frame.error);
      } catch {
        /* ignore non-JSON frames */
      }
    });
    socket.on("error", () => finish(false));
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Dashboard `/api/profiles/projects/tree` read for Remote/SSH connections:
 * folder path → project label. Matches the Local mapping's coverage (project
 * path + repo/folder paths).
 */
export async function remoteProjectFolderNames(
  config: RemoteSessionConfig,
): Promise<ProjectFolderNames> {
  const result: ProjectFolderNames = {};
  try {
    const data = (await remoteRequestJson(
      config,
      "/api/profiles/projects/tree?preview_limit=1",
    )) as { projects?: unknown };
    const projects = Array.isArray(data?.projects) ? data.projects : [];
    for (const project of projects) {
      if (!project || typeof project !== "object") continue;
      const row = project as Record<string, unknown>;
      mergeInto(result, row.path, row.label);
      mergeInto(result, row.id, row.label);
      const repos = Array.isArray(row.repos) ? row.repos : [];
      for (const repo of repos) {
        if (!repo || typeof repo !== "object") continue;
        const repoRow = repo as Record<string, unknown>;
        mergeInto(result, repoRow.path, row.label);
        mergeInto(result, repoRow.id, row.label);
      }
    }
  } catch {
    // Display sugar — a failed probe leaves the slug fallback.
  }
  return result;
}
