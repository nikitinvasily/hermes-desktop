import Database from "better-sqlite3";
import { existsSync } from "fs";
import { activeStateDbPath } from "./utils";

let cachedDb: Database.Database | null = null;
let cachedDbPath: string | null = null;
let cachedDbReadonly: boolean | null = null;

let cachedColumnsDb: Database.Database | null = null;
let cachedColumns: Array<{ name: string }> | null = null;

/** PRAGMA table_info(sessions), cached per database connection. */
function sessionTableColumns(db: Database.Database): Array<{ name: string }> {
  if (cachedColumnsDb !== db || !cachedColumns) {
    cachedColumns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string;
    }>;
    cachedColumnsDb = db;
  }
  return cachedColumns;
}

/** Older Agent databases predate native archiving; keep their lists readable. */
export function sessionVisibilityPredicate(db: Database.Database): string {
  return hasArchivedColumn(db) ? "s.archived = 0" : "1 = 1";
}

/**
 * Predicate hiding delegate-subagent runs from session lists: child rows carry
 * parent_session_id plus the agent's `_delegate_from` marker in model_config.
 * Mirrors the core's list_sessions_rich(include_children=False) so local and
 * SSH lists match what the dashboard REST already returns (branch/reset/
 * compression children are NOT hidden by this predicate). Older databases
 * without either column keep the legacy unfiltered behavior.
 */
export function sessionSubagentPredicate(db: Database.Database): string {
  if (!hasParentSessionColumn(db) || !hasModelConfigColumn(db)) return "1 = 1";
  return (
    "NOT (s.parent_session_id IS NOT NULL AND " +
    "json_extract(CASE WHEN json_valid(s.model_config) THEN s.model_config ELSE '{}' END, " +
    "'$._delegate_from') IS NOT NULL)"
  );
}

/**
 * True when the sessions table carries the lineage column the agent writes for
 * subagent runs, branches, and compression continuations.
 */
export function hasParentSessionColumn(db: Database.Database): boolean {
  return sessionTableColumns(db).some(
    (column) => column.name === "parent_session_id",
  );
}

/**
 * True when the sessions table carries the model_config JSON blob holding the
 * `_delegate_from` subagent marker.
 */
export function hasModelConfigColumn(db: Database.Database): boolean {
  return sessionTableColumns(db).some(
    (column) => column.name === "model_config",
  );
}

/**
 * True when the sessions table carries the agent's native `archived` column
 * (state.db schema of Sep 2026+). Archive mutations and archived-only listings
 * are no-ops on older databases rather than SQL errors.
 */
export function hasArchivedColumn(db: Database.Database): boolean {
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
    name: string;
  }>;
  return columns.some((column) => column.name === "archived");
}

/**
 * Return a cached database connection for the active profile state DB.
 * If the active profile database path or readonly status changes,
 * the old database connection is cleanly closed and a new one is established.
 */
export function getDbConnection(
  readonly = true,
  profile?: unknown,
): Database.Database | null {
  const dbPath = activeStateDbPath(profile);
  if (!existsSync(dbPath)) {
    closeDbConnection();
    return null;
  }

  // Reuse the existing cached connection if the path and mode match
  if (cachedDb && cachedDbPath === dbPath && cachedDbReadonly === readonly) {
    return cachedDb;
  }

  closeDbConnection();

  try {
    cachedDb = new Database(dbPath, readonly ? { readonly: true } : {});
    cachedDbPath = dbPath;
    cachedDbReadonly = readonly;
    return cachedDb;
  } catch (err) {
    console.error(`[db] Failed to open database at ${dbPath}:`, err);
    return null;
  }
}

/**
 * Close the cached database connection if open.
 */
export function closeDbConnection(): void {
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch (err) {
      console.error("[db] Error closing database connection:", err);
    }
    cachedDb = null;
    cachedDbPath = null;
    cachedDbReadonly = null;
  }
}
