import { join } from "path";
import { existsSync } from "fs";
import WebSocket from "ws";
import Database from "better-sqlite3";
import { profileHome } from "./utils";
import { remoteRequestJson, type RemoteSessionConfig } from "./remote-sessions";
import { freshDashboardWebSocketUrl } from "./dashboard";
import { sshPython } from "./ssh-remote";
import type { SshConfig } from "./ssh-tunnel";
import type {
  ProjectFolderInfo,
  ProjectInfo,
  ProjectMutation,
} from "../shared/projects";

/**
 * Project management over the agent's projects.db (issue #27): create,
 * rename, delete, and folder management (add/remove/set primary) for the
 * sidebar's Projects section.
 *
 * The agent core owns the data (tui_gateway `projects.*` JSON-RPC over the
 * dashboard WebSocket, backed by hermes_cli/projects_db.py). The desktop never
 * writes projects.db directly:
 *  - Reads: local reads the sqlite file (cheap, no dashboard round trip);
 *    remote/SSH ask the dashboard `/api/profiles/projects/tree`.
 *  - Writes (all modes): `projects.*` JSON-RPC over the dashboard WebSocket —
 *    the same transport moveSessionWorkspaceOnAgent uses. Validation lives in
 *    one place (the agent): e.g. create refuses a primary folder already
 *    owned by another project, and the dialog surfaces that error.
 *
 * SSH legacy transport (dashboard unreachable) has no RPC channel: reads fall
 * back to parsing the remote projects.db with python3, writes fail with a
 * clear error.
 */

export type { ProjectFolderInfo, ProjectInfo, ProjectMutation };

function folderFromRemote(row: Record<string, unknown>): ProjectFolderInfo {
  return {
    path: typeof row.path === "string" ? row.path : "",
    label: typeof row.label === "string" ? row.label : null,
    isPrimary: Boolean(row.is_primary),
  };
}

function folderFromLocal(row: {
  path: string;
  label: string | null;
  is_primary: number;
}): ProjectFolderInfo {
  return {
    path: row.path,
    label: row.label,
    isPrimary: Boolean(row.is_primary),
  };
}

/** Local projects.db read (non-archived projects with all folders). */
export function localListProjects(profile?: unknown): ProjectInfo[] {
  const result: ProjectInfo[] = [];
  try {
    const dbPath = join(profileHome(profile), "projects.db");
    if (!existsSync(dbPath)) return result;
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(
          `SELECT p.id AS id, p.slug AS slug, p.name AS name,
                  p.primary_path AS ppath, f.path AS fpath, f.label AS flabel,
                  f.is_primary AS fprimary
           FROM projects p
           LEFT JOIN project_folders f ON f.project_id = p.id
           WHERE p.archived = 0
           ORDER BY p.created_at ASC, f.is_primary DESC, f.added_at ASC`,
        )
        .all() as Array<{
        id: string;
        slug: string;
        name: string;
        ppath: string | null;
        fpath: string | null;
        flabel: string | null;
        fprimary: number;
      }>;
      const byId = new Map<string, ProjectInfo>();
      for (const row of rows) {
        let project = byId.get(row.id);
        if (!project) {
          project = {
            id: row.id,
            slug: row.slug,
            name: row.name,
            primaryPath: row.ppath,
            folders: [],
          };
          byId.set(row.id, project);
        }
        if (row.fpath) {
          project.folders.push(
            folderFromLocal({
              path: row.fpath,
              label: row.flabel,
              is_primary: row.fprimary,
            }),
          );
        }
      }
      return Array.from(byId.values());
    } finally {
      db.close();
    }
  } catch {
    return result;
  }
}

/** Dashboard `/api/profiles/projects/tree` read (remote + SSH dashboard). */
export async function remoteListProjects(
  config: RemoteSessionConfig,
): Promise<ProjectInfo[]> {
  const result: ProjectInfo[] = [];
  try {
    const data = (await remoteRequestJson(
      config,
      "/api/profiles/projects/tree?preview_limit=1",
    )) as { projects?: unknown };
    const projects = Array.isArray(data?.projects) ? data.projects : [];
    for (const project of projects) {
      if (!project || typeof project !== "object") continue;
      const row = project as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id : "";
      const name = typeof row.label === "string" ? row.label : "";
      if (!id || !id.startsWith("p_")) continue; // auto/synthetic groups
      const folders: ProjectFolderInfo[] = [];
      const repos = Array.isArray(row.repos) ? row.repos : [];
      for (const repo of repos) {
        if (!repo || typeof repo !== "object") continue;
        folders.push(folderFromRemote(repo as Record<string, unknown>));
      }
      const primary = folders.find((f) => f.isPrimary) ?? folders[0] ?? null;
      result.push({
        id,
        slug: typeof row.slug === "string" ? row.slug : id,
        name,
        primaryPath:
          typeof row.path === "string" && row.path
            ? row.path
            : (primary?.path ?? null),
        folders,
      });
    }
  } catch {
    // A failed probe leaves an empty list; the sidebar shows the slug groups.
  }
  return result;
}

/** SSH legacy fallback: parse the remote projects.db via python3. */
export async function sshListProjects(
  config: SshConfig,
  profile?: string,
): Promise<ProjectInfo[]> {
  const script = `
import sqlite3, json, os
profile = ${JSON.stringify(profile ?? "")}
db = os.path.expanduser(f"~/.hermes/profiles/{profile}/projects.db" if profile and profile != "default" else "~/.hermes/projects.db")
if not os.path.exists(db):
    print("[]"); raise SystemExit
conn = sqlite3.connect(db)
conn.row_factory = sqlite3.Row
rows = conn.execute(
    "SELECT p.id AS id, p.slug AS slug, p.name AS name, p.primary_path AS ppath, "
    "f.path AS fpath, f.label AS flabel, f.is_primary AS fprimary "
    "FROM projects p LEFT JOIN project_folders f ON f.project_id = p.id "
    "WHERE p.archived = 0 ORDER BY p.created_at ASC, f.is_primary DESC, f.added_at ASC"
).fetchall()
projects = {}
for r in rows:
    pid = r["id"]
    if pid not in projects:
        projects[pid] = {"id": pid, "slug": r["slug"], "name": r["name"],
                         "primaryPath": r["ppath"], "folders": []}
    if r["fpath"]:
        projects[pid]["folders"].append({"path": r["fpath"], "label": r["flabel"],
                                         "isPrimary": bool(r["fprimary"])})
print(json.dumps(list(projects.values())))
conn.close()
`;
  try {
    const out = await sshPython(config, script);
    const parsed = JSON.parse(out.trim() || "[]") as Array<
      Record<string, unknown>
    >;
    return parsed.map((row) => ({
      id: String(row.id ?? ""),
      slug: String(row.slug ?? ""),
      name: String(row.name ?? ""),
      primaryPath: typeof row.primaryPath === "string" ? row.primaryPath : null,
      folders: Array.isArray(row.folders)
        ? (row.folders as Array<Record<string, unknown>>).map((f) => ({
            path: String(f.path ?? ""),
            label: typeof f.label === "string" ? f.label : null,
            isPrimary: Boolean(f.isPrimary),
          }))
        : [],
    }));
  } catch {
    return [];
  }
}

/**
 * Create a directory on the SSH agent host (issue #27 follow-up). Refuses
 * paths outside the remote user's home — the desktop should not be able to
 * mint arbitrary directories on a server it merely chats with. `~` and
 * `$HOME` prefixes expand on the remote. Returns the absolute created path.
 */
export async function sshCreateDirectory(
  config: SshConfig,
  path: string,
): Promise<string> {
  const script = `
import json, os, sys
payload = json.loads(sys.stdin.read() or "{}")
raw = str(payload.get("path") or "")
if raw.startswith("~/"):
    raw = os.path.join(os.path.expanduser("~"), raw[2:])
elif raw.startswith("$HOME/"):
    raw = os.path.join(os.path.expanduser("~"), raw[6:])
path = os.path.abspath(os.path.expanduser(raw))
home = os.path.expanduser("~")
if path != home and not path.startswith(home + os.sep):
    print(json.dumps({"error": "refusing to create a directory outside the remote home"}))
    sys.exit(1)
os.makedirs(path, exist_ok=True)
print(json.dumps({"path": path}))
`;
  const out = await sshPython(config, script, JSON.stringify({ path }));
  const parsed = JSON.parse(out.trim()) as { path?: string; error?: string };
  if (parsed.error) throw new Error(parsed.error);
  if (!parsed.path) throw new Error("Directory creation returned no path.");
  return parsed.path;
}

function rpcParamsForMutation(m: ProjectMutation): {
  method: string;
  params: Record<string, unknown>;
} {
  switch (m.op) {
    case "create":
      return {
        method: "projects.create",
        params: {
          name: m.name,
          folders: m.folders,
          ...(m.primaryPath ? { primary_path: m.primaryPath } : {}),
        },
      };
    case "update":
      return {
        method: "projects.update",
        params: {
          id: m.id,
          ...(m.name !== undefined ? { name: m.name } : {}),
        },
      };
    case "delete":
      return { method: "projects.delete", params: { id: m.id } };
    case "add_folder":
      return {
        method: "projects.add_folder",
        params: {
          id: m.id,
          path: m.path,
          ...(m.isPrimary ? { is_primary: true } : {}),
        },
      };
    case "remove_folder":
      return {
        method: "projects.remove_folder",
        params: { id: m.id, path: m.path },
      };
    case "set_primary":
      return {
        method: "projects.set_primary",
        params: { id: m.id, path: m.path },
      };
  }
}

/**
 * Run one `projects.*` mutation against the agent's JSON-RPC over the
 * dashboard WebSocket (issue #27). Throws with the backend's error message on
 * failure (e.g. "folder already belongs to project '...'"), so the dialog can
 * show it.
 */
export async function projectRpc(
  profile: string | undefined,
  connectionId: string | undefined,
  mutation: ProjectMutation,
): Promise<unknown> {
  const { method, params } = rpcParamsForMutation(mutation);
  let wsUrl: string;
  try {
    wsUrl = await freshDashboardWebSocketUrl(profile, connectionId);
  } catch (err) {
    throw new Error(
      `Project operation requires the dashboard connection: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const requestId = Math.floor(Math.random() * 1_000_000);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Project operation timed out."));
    }, 15_000);
    timer.unref?.();
    const finishOk = (value: unknown): void => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    const finishErr = (message: string): void => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      reject(new Error(message));
    };
    socket.on("open", () => {
      socket.send(
        JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      );
    });
    socket.on("message", (data) => {
      try {
        const frame = JSON.parse(String(data)) as {
          id?: number;
          result?: unknown;
          error?: { message?: string; data?: unknown };
        };
        if (frame.id !== requestId) return;
        if (frame.error) {
          const detail =
            typeof frame.error.data === "string" && frame.error.data
              ? frame.error.data
              : "";
          finishErr(
            frame.error.message
              ? `${frame.error.message}${detail ? `: ${detail}` : ""}`
              : "Project operation failed.",
          );
          return;
        }
        finishOk(frame.result);
      } catch {
        /* ignore non-JSON frames */
      }
    });
    socket.on("error", () => finishErr("Dashboard WebSocket error."));
    socket.on("close", () => {
      clearTimeout(timer);
      reject(new Error("Dashboard WebSocket closed unexpectedly."));
    });
  });
}
