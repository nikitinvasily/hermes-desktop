import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { profileHome, getActiveProfileNameSync, safeWriteFile } from "./utils";
import Database from "better-sqlite3";
import { t } from "../shared/i18n";
import {
  isSessionTitleUniqueViolation,
  MAX_SESSION_TITLE_LENGTH,
  normalizeSessionTitle,
  validateNormalizedSessionTitle,
} from "../shared/session-title";
import { getAppLocale } from "./locale";
import {
  getDbConnection,
  sessionSubagentPredicate,
  sessionVisibilityPredicate,
} from "./db";
import {
  hasLastActivityColumn,
  hasLastReadColumn,
  sessionUnread,
} from "./sessions";
import { getSessionContextFolders } from "./session-context-folder-store";
import {
  filterDerivedWorkspaceFolders,
  localKnownProjectFolders,
  localWorkspaceHomes,
} from "./workspace-folder";

// Re-export for callers/docs that historically imported the cap from here.
export { MAX_SESSION_TITLE_LENGTH } from "../shared/session-title";

/**
 * The session cache lives alongside its own profile's data so profiles
 * don't share a single cache file. The default profile keeps
 * ~/.hermes/desktop/sessions.json; named profiles use
 * ~/.hermes/profiles/<name>/desktop/sessions.json (issue #311).
 */
function cacheFilePath(profile?: unknown): string {
  const selectedProfile =
    profile === undefined || profile === ""
      ? getActiveProfileNameSync()
      : profile;
  return join(profileHome(selectedProfile), "desktop", "sessions.json");
}

export interface CachedSession {
  id: string;
  title: string;
  startedAt: number;
  /** By-modification ordering key (issue #74): last activity, startedAt fallback. */
  lastActivityAt: number;
  /** True when activity postdates the `last_read_at` watermark (issue #90). */
  unread?: boolean;
  source: string;
  messageCount: number;
  model: string;
  contextFolder: string | null;
}

interface CacheData {
  sessions: CachedSession[];
  lastSync: number;
  /** True after the one-time read-state baseline ran (issue #90). */
  readBaselineDone?: boolean;
}

// Generate a short, readable title from the first user message (like ChatGPT/Claude)
function generateTitle(message: string): string {
  if (!message || !message.trim())
    return t("sessions.newConversation", getAppLocale());

  // Clean up the message
  let text = message.trim();

  // Remove markdown formatting
  text = text.replace(/[#*_`~[\]()]/g, "");
  // Remove URLs
  text = text.replace(/https?:\/\/\S+/g, "");
  // Remove extra whitespace
  text = text.replace(/\s+/g, " ").trim();

  if (!text) return t("sessions.newConversation", getAppLocale());

  // If short enough, use as-is
  if (text.length <= 50) return text;

  // Take first meaningful chunk — aim for ~40-50 chars at word boundary
  const words = text.split(" ");
  let title = "";
  for (const word of words) {
    if ((title + " " + word).trim().length > 45) break;
    title = (title + " " + word).trim();
  }

  return title || text.slice(0, 45) + "...";
}

function readCache(profile?: unknown): CacheData {
  const file = cacheFilePath(profile);
  try {
    if (!existsSync(file)) return { sessions: [], lastSync: 0 };
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as CacheData;
    return {
      lastSync: typeof parsed.lastSync === "number" ? parsed.lastSync : 0,
      readBaselineDone: parsed.readBaselineDone === true,
      sessions: Array.isArray(parsed.sessions)
        ? parsed.sessions.map((s) => ({
            ...s,
            startedAt: typeof s.startedAt === "number" ? s.startedAt : 0,
            // Caches written before issue #74 carry no lastActivityAt —
            // degrade to startedAt until the next sync refreshes the field.
            lastActivityAt:
              typeof s.lastActivityAt === "number"
                ? s.lastActivityAt
                : typeof s.startedAt === "number"
                  ? s.startedAt
                  : 0,
            unread: s.unread === true,
            contextFolder:
              typeof s.contextFolder === "string" ? s.contextFolder : null,
          }))
        : [],
    };
  } catch {
    return { sessions: [], lastSync: 0 };
  }
}

function writeCache(data: CacheData, profile?: unknown): void {
  try {
    safeWriteFile(cacheFilePath(profile), JSON.stringify(data));
  } catch {
    // non-fatal
  }
}

function getDb(profile?: unknown): Database.Database | null {
  return getDbConnection(true, profile);
}

/**
 * Session-rows-to-workspace grouping fallback: when a session has no desktop
 * folder binding (created outside the desktop — CLI, gateway), derive the
 * sidebar project folder from the backend's own workspace data, mirroring
 * hermes-agent's `hermes_state_sessions._workspace_group_key`: git repo root
 * when present, else cwd (issue #15).
 */
function workspaceFolderFromRow(row: {
  git_repo_root?: string | null;
  cwd?: string | null;
}): string | null {
  const repoRoot = row.git_repo_root?.trim();
  if (repoRoot) return repoRoot;
  return row.cwd?.trim() || null;
}

// Attach each session's linked folder in a single batched store read, so a
// full sync stays a couple of queries rather than two per row. The result is
// written into the JSON cache by `syncSessionCache`, which lets the renderer's
// fast read path (`listCachedSessions`) stay DB-free.
//
// Folder precedence per session: an explicit desktop binding wins; an empty
// sentinel row means the user deliberately unlinked the session (it must NOT
// fall back to the derived cwd/repo folder); no row at all means derive from
// the session's own workspace columns (issue #15).
function attachContextFolders(
  sessions: CachedSession[],
  folders: Map<string, string>,
  derived: Map<string, string | null>,
): CachedSession[] {
  return sessions.map((session) => {
    if (folders.has(session.id)) {
      return { ...session, contextFolder: folders.get(session.id) || null };
    }
    return { ...session, contextFolder: derived.get(session.id) ?? null };
  });
}

// Reconcile visible session metadata; archive changes do not update started_at.
export function syncSessionCache(profile?: unknown): CachedSession[] {
  const cache = readCache(profile);
  if (!cache.readBaselineDone) {
    // One-time read-state baseline (issue #90): the agent treats
    // `last_read_at` NULL as "read", so on an existing install where nothing
    // ever wrote the watermark, no session can ever light up as unread.
    // Stamp NULL rows with their own last activity once, recorded in the
    // desktop cache file (per profile) so it never runs again. New sessions
    // minted after this point start NULL and only get a watermark when the
    // user actually opens them or views their finished turn.
    //
    // Runs on a WRITER connection BEFORE the read-only listing connection is
    // taken: getDbConnection caches one connection, so doing this inside the
    // reader's scope would throw SQLITE_READONLY (silently swallowed by the
    // sync's catch, freezing the whole cache — the shipped fork.1535 bug).
    try {
      const writer = getDbConnection(false, profile);
      if (writer && hasLastReadColumn(writer)) {
        writer
          .prepare(
            `UPDATE sessions SET last_read_at = COALESCE(last_activity_at, started_at)
             WHERE last_read_at IS NULL`,
          )
          .run();
      }
    } catch {
      // Baseline is best-effort; a locked DB retries on the next sync.
    }
  }
  const db = getDb(profile);
  if (!db) return cache.sessions;

  try {
    // Read the complete visible set so old sessions can disappear on archive
    // and reappear on unarchive. Reuse cached titles to avoid rereading messages.
    const rows = db
      .prepare(
        `SELECT s.id, s.started_at, s.source, s.message_count, s.model, s.title,
                s.cwd, s.git_repo_root
                ${hasLastActivityColumn(db) ? ", s.last_activity_at" : ""}
                ${hasLastReadColumn(db) ? ", s.last_read_at" : ""}
         FROM sessions s
         WHERE ${sessionVisibilityPredicate(db)}
           AND ${sessionSubagentPredicate(db)}
         ORDER BY ${
           hasLastActivityColumn(db)
             ? "COALESCE(s.last_activity_at, s.started_at)"
             : "s.started_at"
         } DESC`,
      )
      .all() as Array<{
      id: string;
      started_at: number;
      source: string;
      message_count: number;
      model: string;
      title: string | null;
      cwd: string | null;
      git_repo_root: string | null;
      last_activity_at?: number | null;
      last_read_at?: number | null;
    }>;

    // Index existing sessions by id once so the per-row update below is
    // O(1) instead of O(N). Without this, syncing N existing sessions
    // against N new rows is O(N²) and visibly slows app startup once a
    // user has accumulated thousands of sessions (issue #16).
    const existingById = new Map<string, CachedSession>();
    for (const s of cache.sessions) existingById.set(s.id, s);
    const visibleSessions: CachedSession[] = [];

    for (const row of rows) {
      const existing = existingById.get(row.id);
      if (existing) {
        visibleSessions.push({
          ...existing,
          messageCount: row.message_count,
          model: row.model || existing.model,
          title: row.title || existing.title,
          lastActivityAt: row.last_activity_at ?? row.started_at,
          unread: sessionUnread(
            row.last_read_at,
            row.last_activity_at ?? row.started_at ?? 0,
          ),
        });
        continue;
      }

      let title = row.title || "";
      if (!title) {
        try {
          const msg = db
            .prepare(
              `SELECT content FROM messages
               WHERE session_id = ? AND role = 'user' AND content IS NOT NULL
               ORDER BY timestamp, id LIMIT 1`,
            )
            .get(row.id) as { content: string } | undefined;
          title = msg
            ? generateTitle(msg.content)
            : t("sessions.newConversation", getAppLocale());
        } catch {
          title = t("sessions.newConversation", getAppLocale());
        }
      }

      visibleSessions.push({
        id: row.id,
        title,
        startedAt: row.started_at,
        lastActivityAt: row.last_activity_at ?? row.started_at,
        unread: sessionUnread(
          row.last_read_at,
          row.last_activity_at ?? row.started_at ?? 0,
        ),
        source: row.source,
        messageCount: row.message_count,
        model: row.model || "",
        // Filled in below by the single batched `attachContextFolders` pass
        // over the merged set, so we don't query the store once per new row.
        contextFolder: null,
      });
    }

    // Rows absent from the visible set are removed only from the desktop
    // cache. Their session/message data and linked folders remain in the DB.
    const bindings = getSessionContextFolders(
      visibleSessions.map((s) => s.id),
      profile,
    );
    const derived = new Map<string, string | null>(
      rows.map((row) => [row.id, workspaceFolderFromRow(row)]),
    );
    let allSessions = attachContextFolders(visibleSessions, bindings, derived);
    // Derived folders pointing at never-a-workspace dirs (agent home, `/`,
    // `/home`, HERMES_HOME) must not clump sessions into a pseudo-project:
    // they fall back to the flat Chats list. Explicit bindings already won
    // above; folders owned by a real project are spared (issue #47).
    allSessions = filterDerivedWorkspaceFolders(
      allSessions,
      localWorkspaceHomes(profile),
      localKnownProjectFolders(profile),
    );
    allSessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

    const updated: CacheData = {
      sessions: allSessions,
      lastSync: Math.floor(Date.now() / 1000),
      readBaselineDone: true,
    };
    writeCache(updated, profile);
    return updated.sessions;
  } catch {
    return cache.sessions;
  }
}

// Fast read from cache only (no DB access). `contextFolder` is persisted into
// the cache by `syncSessionCache`, and folder changes trigger a re-sync (the
// renderer fires `hermes-session-context-folder-changed`), so the cached value
// stays current without this path touching the DB.
export function listCachedSessions(
  limit = 50,
  offset = 0,
  profile?: unknown,
): CachedSession[] {
  const cache = readCache(profile);
  return cache.sessions.slice(offset, offset + limit);
}

/**
 * Persist a user-chosen session title to state.db, then mirror it into the
 * desktop sessions.json cache.
 *
 * Order matters: the durable DB write must succeed before the cache is
 * updated. The previous cache-first + swallow-errors approach left the UI
 * looking renamed while the next syncSessionCache restored the old DB title
 * (Hermes enforces UNIQUE non-NULL titles via idx_sessions_title_unique).
 */
export function updateSessionTitle(
  sessionId: string,
  title: string,
  profile?: unknown,
): void {
  const locale = getAppLocale();
  const normalized = normalizeSessionTitle(title);
  const validation = validateNormalizedSessionTitle(normalized);
  switch (validation) {
    case "empty":
      throw new Error(t("sessions.renameInvalid", locale));
    case "too_long":
      throw new Error(
        t("sessions.renameTooLong", locale, {
          max: String(MAX_SESSION_TITLE_LENGTH),
        }),
      );
    case null:
      break;
    default: {
      const _exhaustive: never = validation;
      throw new Error(String(_exhaustive));
    }
  }

  const db = getDbConnection(false, profile);
  if (!db) {
    throw new Error(t("sessions.renameUnavailable", locale));
  }

  // Match Hermes SessionDB.set_session_title: reject conflicts before write so
  // we never partially update the JSON cache on a UNIQUE constraint failure.
  const conflict = db
    .prepare("SELECT id FROM sessions WHERE title = ? AND id != ?")
    .get(normalized, sessionId) as { id: string } | undefined;
  if (conflict) {
    throw new Error(
      t("sessions.renameDuplicate", locale, { title: normalized }),
    );
  }

  let changes = 0;
  try {
    const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string;
    }>;
    const titleSource = columns.some((column) => column.name === "title_source")
      ? ", title_source = 'user'"
      : "";
    changes = db
      .prepare(`UPDATE sessions SET title = ?${titleSource} WHERE id = ?`)
      .run(normalized, sessionId).changes;
  } catch (err) {
    if (isSessionTitleUniqueViolation(err)) {
      throw new Error(
        t("sessions.renameDuplicate", locale, { title: normalized }),
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  }

  if (changes === 0) {
    throw new Error(t("sessions.renameNotFound", locale));
  }

  const cache = readCache(profile);
  const idx = cache.sessions.findIndex((s) => s.id === sessionId);
  if (idx >= 0) {
    cache.sessions[idx].title = normalized;
    writeCache(cache, profile);
  }
}

// Remove a session entry from the local cache. Called after the underlying
// row in state.db is deleted so the renderer's fast-path cache doesn't keep
// surfacing a session that no longer exists.
export function removeSessionFromCache(
  sessionId: string,
  profile?: unknown,
): void {
  const cache = readCache(profile);
  const next = cache.sessions.filter((s) => s.id !== sessionId);
  if (next.length !== cache.sessions.length) {
    cache.sessions = next;
    writeCache(cache, profile);
  }
}
