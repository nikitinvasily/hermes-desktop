import { homedir } from "os";
import { existsSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
import { profileHome } from "./utils";

/**
 * Junk-workspace filter for DERIVED sidebar grouping folders (issue #47).
 *
 * Sessions created outside the desktop (Telegram, cron, CLI) carry the cwd the
 * agent process had — commonly the agent user's home (`/home/hermes`). The
 * derived grouping (`git_repo_root || cwd`, issue #15) turned those into a
 * pseudo-project group ("hermes") that no project in the agent's projects.db
 * owns. The agent core already solves this for its own tree
 * (`tui_gateway/methods_projects.py::_is_session_cwd_junk`): the home dir, its
 * parent, `/`, `/home`, `/Users`, and HERMES_HOME itself are never workspaces —
 * such sessions stay in the flat Recents list. This module mirrors that policy
 * on the desktop side for all three session-list paths.
 *
 * Rules:
 *  - Only equality is junk: a DESCENDANT of HERMES_HOME may be an intentional
 *    workspace (`~/.hermes/workspace/trading`), mirroring the backend's
 *    narrower cwd policy.
 *  - A folder owned by a real project (projects.db / the dashboard tree)
 *    always wins — user-created projects pointing at a "junk" dir are honored.
 *  - Explicit desktop bindings are applied by the callers AFTER this filter,
 *    so a manual Move-to-project is never undone.
 */

export interface WorkspaceHomes {
  /** The agent user's home directory (e.g. `/home/hermes`). */
  agentHome: string | null;
  /** The agent's HERMES_HOME (profile dir), e.g. `/home/hermes/.hermes`. */
  hermesHome: string | null;
}

/** Never-a-workspace dirs on any POSIX host (both spellings; mirrors the
 * backend's `_non_workspace_dirs` minus the dynamic entries). */
const STATIC_JUNK_DIRS = new Set(["/", "/home", "/Users"]);

function normPath(p: string): string {
  let v = p.trim();
  while (v.length > 1 && (v.endsWith("/") || v.endsWith("\\"))) {
    v = v.slice(0, -1);
  }
  return v;
}

/** Local connection: both homes are knowable exactly. */
export function localWorkspaceHomes(profile?: unknown): WorkspaceHomes {
  return { agentHome: homedir(), hermesHome: profileHome(profile) };
}

export function isJunkWorkspaceFolder(
  folder: string,
  homes: WorkspaceHomes,
): boolean {
  const c = normPath(folder);
  if (!c) return true;
  if (STATIC_JUNK_DIRS.has(c)) return true;
  if (homes.agentHome) {
    const home = normPath(homes.agentHome);
    if (c === home || c === dirname(home)) return true;
  }
  if (homes.hermesHome && c === normPath(homes.hermesHome)) return true;
  return false;
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  if (i <= 0) return "/";
  return p.slice(0, i);
}

/**
 * Infer the agent's homes for Remote/SSH-dashboard connections, where no
 * filesystem access exists. Any path containing a `/.hermes` segment pins
 * HERMES_HOME (`/home/hermes/.hermes/workspace/diy` → homes
 * `/home/hermes` + `/home/hermes/.hermes`). The strict pass only accepts
 * remainders the agent itself creates (`/workspace/…`, `/profiles/…`, or the
 * `.hermes` dir itself) so an unrelated repo that happens to contain a
 * `.hermes` folder cannot poison the inference; the loose pass is a fallback.
 */
export function inferAgentHomes(paths: readonly unknown[]): WorkspaceHomes {
  const scan = (strict: boolean): WorkspaceHomes => {
    for (const raw of paths) {
      if (typeof raw !== "string") continue;
      const p = normPath(raw);
      if (!p.startsWith("/")) continue;
      const idx = p.indexOf("/.hermes/");
      let hermesHome: string | null = null;
      let agentHome: string | null = null;
      if (idx > 0) {
        hermesHome = p.slice(0, idx + "/.hermes".length);
        agentHome = p.slice(0, idx);
      } else if (p.endsWith("/.hermes") && p.length > "/.hermes".length) {
        hermesHome = p;
        agentHome = p.slice(0, -"/.hermes".length);
      }
      if (!hermesHome || !agentHome) continue;
      const rest = p.slice(hermesHome.length);
      if (
        strict &&
        !(
          rest === "" ||
          rest.startsWith("/workspace") ||
          rest.startsWith("/profiles")
        )
      ) {
        continue;
      }
      return { agentHome, hermesHome };
    }
    return { agentHome: null, hermesHome: null };
  };
  const strict = scan(true);
  return strict.agentHome ? strict : scan(false);
}

/**
 * Null the derived contextFolder of sessions whose folder is a
 * never-a-workspace dir. Folders owned by a known project are spared.
 */
export function filterDerivedWorkspaceFolders<
  T extends { contextFolder: string | null },
>(
  sessions: readonly T[],
  homes: WorkspaceHomes,
  knownProjectFolders?: ReadonlySet<string>,
): T[] {
  const known = knownProjectFolders ?? new Set<string>();
  return sessions.map((session) => {
    const f = session.contextFolder?.trim() ?? "";
    if (!f) return session;
    if (known.has(f) || known.has(normPath(f))) return session;
    if (!isJunkWorkspaceFolder(f, homes)) return session;
    return { ...session, contextFolder: null };
  });
}

/**
 * Local projects.db read: every folder path owned by a live (non-archived)
 * project. Mirrors `localProjectFolderNames` coverage but returns a set —
 * used to keep a deliberate project at a "junk" path groupable.
 */
export function localKnownProjectFolders(profile?: unknown): Set<string> {
  try {
    const dbPath = join(profileHome(profile), "projects.db");
    if (!existsSync(dbPath)) return new Set<string>();
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(
          `SELECT p.primary_path AS ppath, f.path AS fpath
           FROM projects p
           LEFT JOIN project_folders f ON f.project_id = p.id
           WHERE p.archived = 0`,
        )
        .all() as Array<{ ppath: string | null; fpath: string | null }>;
      const out = new Set<string>();
      for (const row of rows) {
        for (const value of [row.ppath, row.fpath]) {
          if (typeof value === "string" && value.trim()) out.add(value.trim());
        }
      }
      return out;
    } finally {
      db.close();
    }
  } catch {
    // No projects.db / unreadable — nothing to rescue.
    return new Set<string>();
  }
}
