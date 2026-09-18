import type { RemoteSessionConfig } from "./remote-sessions";
import { remoteRequestJson } from "./remote-sessions";
import type { CachedSession } from "./session-cache";

/**
 * Complete per-project session lists for Remote/SSH sidebars (issue #57).
 *
 * The sidebar's own list is a 50-row recency window over /api/profiles/sessions,
 * so a project group built from it shows only the sessions that happen to sit
 * inside the window — counts "breathe" as unrelated sessions churn. The
 * dashboard's projects tree (/api/profiles/projects/tree) is built by the agent
 * core from the FULL unarchived session set with cron/kanban excluded, and
 * carries per-project `previewSessions` slices — `preview_limit` rows per
 * project, recency-sorted. Requesting a large limit yields every session the
 * core's grouping claims for each project, which is exactly the stable group
 * membership the sidebar needs; the window list then only enriches it with
 * rows the tree already implies.
 *
 * Rows are best-effort: titles/models fall back the same way the window list's
 * do, and any failure returns an empty list (callers keep the window-derived
 * groups).
 */

const PREVIEW_LIMIT = 500;

interface TreeSessionRow {
  id?: unknown;
  title?: unknown;
  preview?: unknown;
  started_at?: unknown;
  last_active?: unknown;
  source?: unknown;
  message_count?: unknown;
  model?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function rowTitle(row: TreeSessionRow, id: string): string {
  const title = typeof row.title === "string" ? row.title.trim() : "";
  if (title) return title;
  const preview = typeof row.preview === "string" ? row.preview.trim() : "";
  if (preview) return preview.slice(0, 80);
  return `Session ${id.slice(-6)}`;
}

function normalizeTreeSession(row: TreeSessionRow): CachedSession | null {
  const id = stringValue(row.id);
  if (!id) return null;
  return {
    id,
    title: rowTitle(row, id),
    startedAt: numberValue(row.last_active, numberValue(row.started_at)),
    source: stringValue(row.source, "chat"),
    messageCount: numberValue(row.message_count),
    model: stringValue(row.model),
    // The group folder is set by the caller from the project node's folders.
    contextFolder: null,
  };
}

export interface ProjectGroupSessions {
  /** Group folder path → every non-archived, non-cron/kanban session the
   * agent's own grouping claims for it (recency-sorted, capped per project). */
  groups: Map<string, CachedSession[]>;
}

/**
 * Fetch the agent-side project tree and collect each project's complete
 * session list from its `previewSessions` (with a large `preview_limit` so
 * the slice IS the full membership).
 */
export async function remoteProjectGroupSessions(
  config: RemoteSessionConfig,
): Promise<ProjectGroupSessions> {
  const groups = new Map<string, CachedSession[]>();
  try {
    const data = (await remoteRequestJson(
      config,
      `/api/profiles/projects/tree?preview_limit=${PREVIEW_LIMIT}`,
    )) as { projects?: unknown };
    const projects = asArray(asRecord(data)?.projects);
    for (const projectRow of projects) {
      const project = asRecord(projectRow);
      if (!project) continue;
      // Explicit projects and auto groups both carry their folder as `path`;
      // the synthetic Home bucket has none and belongs to the flat Chats list.
      const path = stringValue(project.path).trim();
      if (!path) continue;
      const rows = asArray(project.previewSessions);
      const sessions: CachedSession[] = [];
      for (const row of rows) {
        const normalized = normalizeTreeSession(
          asRecord(row) as TreeSessionRow,
        );
        if (normalized) sessions.push({ ...normalized, contextFolder: path });
      }
      if (sessions.length > 0) groups.set(path, sessions);
    }
  } catch {
    // Best-effort: an unreachable dashboard leaves the caller with the
    // window-derived groups.
  }
  return { groups };
}
