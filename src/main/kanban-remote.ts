import { getConnectionConfig } from "./config";
import { isRemoteOnlyMode } from "./hermes";
import {
  RemoteDashboardApiError,
  remoteDashboardRequestJson,
} from "./remote-api";
import type {
  CreateTaskInput,
  KanbanBoard,
  KanbanComment,
  KanbanEvent,
  KanbanResult,
  KanbanRun,
  KanbanTask,
  KanbanTaskDetail,
} from "./kanban";

/**
 * Direct-Remote (HTTP) Kanban: thin adapter over the backend dashboard's kanban
 * plugin (``/api/plugins/kanban/*``, plugins/kanban/dashboard/plugin_api.py).
 *
 * Every request goes through {@link remoteDashboardRequestJson} — the auth-mode
 * aware boundary (oauth cookie partition vs session token) shared by all
 * remote-parity screens. Never call remoteRequestJson directly here.
 *
 * The plugin's JSON shapes differ from the CLI ``--json`` shapes the local/SSH
 * paths parse, so each read maps through a format adapter below; the renderer
 * keeps seeing the CLI-shaped types from kanban.ts.
 */

const KANBAN_API = "/api/plugins/kanban";

interface RemoteCallOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
}

async function kanbanJson<T>(
  path: string,
  opts: RemoteCallOpts = {},
): Promise<T> {
  const conn = getConnectionConfig();
  return remoteDashboardRequestJson<T>(conn, `${KANBAN_API}${path}`, opts);
}

// A 404 here means the server's dashboard has no kanban plugin (agent older
// than plugins/kanban) — a mode-level gap the renderer renders as its
// "update the agent" notice, not a generic failure.
function remoteFailure<T>(err: unknown): KanbanResult<T> {
  if (err instanceof RemoteDashboardApiError && err.statusCode === 404) {
    return {
      success: false,
      unsupportedMode: true,
      error:
        "The remote dashboard does not expose the kanban API " +
        "(agent older than the kanban plugin). Update the agent on the " +
        "remote host, or switch to SSH tunnel mode.",
    };
  }
  return {
    success: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

// --- Format adapters ---------------------------------------------------------
// The plugin returns full rows (asdict of kanban_db.Task etc.) with extras
// (age, latest_summary, link_counts, ...) the CLI JSON also carries or ignores.
// The renderer reads only the CLI-shape fields, so a structural pass-through
// with defaults for missing optional fields is enough.

interface RemoteTaskRow {
  id?: string;
  title?: string;
  body?: string | null;
  assignee?: string | null;
  status?: string;
  priority?: number;
  tenant?: string | null;
  workspace_kind?: string;
  workspace_path?: string | null;
  created_by?: string | null;
  created_at?: number | null;
  started_at?: number | null;
  completed_at?: number | null;
  result?: string | null;
  skills?: string[] | null;
  max_retries?: number | null;
  [key: string]: unknown;
}

function adaptTaskRow(row: RemoteTaskRow): KanbanTask {
  return {
    id: String(row.id ?? ""),
    title: String(row.title ?? ""),
    body: row.body ?? null,
    assignee: row.assignee ?? null,
    status: String(row.status ?? "todo"),
    priority: Number(row.priority ?? 0),
    tenant: row.tenant ?? null,
    workspace_kind: String(row.workspace_kind ?? "scratch"),
    workspace_path: row.workspace_path ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at ?? null,
    started_at: row.started_at ?? null,
    completed_at: row.completed_at ?? null,
    result: row.result ?? null,
    skills: Array.isArray(row.skills) ? row.skills : [],
    max_retries: row.max_retries ?? null,
  };
}

interface RemoteBoardRow {
  slug?: string;
  name?: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  is_current?: boolean;
  archived?: boolean;
  total?: number;
  counts?: Record<string, number>;
  db_path?: string;
  [key: string]: unknown;
}

export function adaptBoardRow(row: RemoteBoardRow): KanbanBoard {
  return {
    slug: String(row.slug ?? ""),
    name: String(row.name ?? row.slug ?? ""),
    description: row.description ?? null,
    icon: row.icon ?? null,
    color: row.color ?? null,
    is_current: Boolean(row.is_current),
    archived: Boolean(row.archived),
    total: Number(row.total ?? 0),
    counts: row.counts ?? {},
    db_path: row.db_path,
  };
}

interface RemoteRunRow {
  id?: number;
  task_id?: string;
  profile?: string | null;
  status?: string | null;
  outcome?: string | null;
  summary?: string | null;
  error?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
  last_heartbeat_at?: number | null;
  [key: string]: unknown;
}

function adaptRunRow(row: RemoteRunRow): KanbanRun {
  return {
    id: Number(row.id ?? 0),
    task_id: String(row.task_id ?? ""),
    profile: row.profile ?? null,
    status: row.status ?? null,
    outcome: row.outcome ?? null,
    summary: row.summary ?? null,
    error: row.error ?? null,
    started_at: row.started_at ?? null,
    ended_at: row.ended_at ?? null,
    last_heartbeat_at: row.last_heartbeat_at ?? null,
  };
}

interface RemoteCommentRow {
  id?: number;
  task_id?: string;
  author?: string | null;
  body?: string;
  created_at?: number;
  [key: string]: unknown;
}

function adaptCommentRow(row: RemoteCommentRow): KanbanComment {
  return {
    id: Number(row.id ?? 0),
    task_id: String(row.task_id ?? ""),
    author: row.author ?? null,
    body: String(row.body ?? ""),
    created_at: Number(row.created_at ?? 0),
  };
}

interface RemoteEventRow {
  id?: number;
  task_id?: string;
  kind?: string;
  payload?: Record<string, unknown> | null;
  created_at?: number;
  run_id?: number | null;
  [key: string]: unknown;
}

function adaptEventRow(row: RemoteEventRow): KanbanEvent {
  return {
    id: Number(row.id ?? 0),
    task_id: String(row.task_id ?? ""),
    kind: String(row.kind ?? ""),
    payload: row.payload ?? null,
    created_at: Number(row.created_at ?? 0),
    run_id: row.run_id ?? null,
  };
}

// --- Boards -------------------------------------------------------------------

export interface RemoteBoardsPayload {
  boards: KanbanBoard[];
  current: string;
}

export async function remoteListBoards(
  includeArchived: boolean,
): Promise<KanbanResult<KanbanBoard[]>> {
  try {
    const data = await kanbanJson<{ boards?: RemoteBoardRow[] }>(
      `/boards${includeArchived ? "?include_archived=true" : ""}`,
    );
    return { success: true, data: (data.boards ?? []).map(adaptBoardRow) };
  } catch (err) {
    return remoteFailure(err);
  }
}

export async function remoteCurrentBoard(): Promise<KanbanResult<string>> {
  try {
    // /boards already carries the active slug; one round-trip, no /board probe.
    const data = await kanbanJson<{ current?: string }>(`/boards`);
    return { success: true, data: String(data.current ?? "") };
  } catch (err) {
    return remoteFailure(err);
  }
}

export async function remoteSwitchBoard(
  slug: string,
): Promise<KanbanResult<void>> {
  if (!slug) return { success: false, error: "Missing board slug" };
  try {
    await kanbanJson(`/boards/${encodeURIComponent(slug)}/switch`, {
      method: "POST",
    });
    return { success: true };
  } catch (err) {
    return remoteFailure(err);
  }
}

export async function remoteCreateBoard(
  slug: string,
  name?: string,
  switchAfter = false,
): Promise<KanbanResult<void>> {
  if (!slug) return { success: false, error: "Missing board slug" };
  try {
    await kanbanJson(`/boards`, {
      method: "POST",
      body: { slug, name: name || null, switch: switchAfter },
    });
    return { success: true };
  } catch (err) {
    return remoteFailure(err);
  }
}

export async function remoteRemoveBoard(
  slug: string,
  hardDelete = false,
): Promise<KanbanResult<void>> {
  if (!slug) return { success: false, error: "Missing board slug" };
  try {
    await kanbanJson(
      `/boards/${encodeURIComponent(slug)}${hardDelete ? "?delete=true" : ""}`,
      { method: "DELETE" },
    );
    return { success: true };
  } catch (err) {
    return remoteFailure(err);
  }
}

// --- Tasks (reads) -------------------------------------------------------------

export async function remoteListTasks(opts: {
  status?: string;
  assignee?: string;
  tenant?: string;
  includeArchived?: boolean;
}): Promise<KanbanResult<KanbanTask[]>> {
  try {
    // The plugin's /board view groups by column; flatten preserving the
    // plugin's canonical column order and its per-column ordering
    // (priority DESC, created_at ASC), then apply the client-side filters
    // the CLI list flags express.
    const data = await kanbanJson<{
      columns?: Array<{ name?: string; tasks?: RemoteTaskRow[] }>;
    }>(`/board${opts.includeArchived ? "?include_archived=true" : ""}`);
    let tasks = (data.columns ?? []).flatMap((c) => c.tasks ?? []);
    if (opts.status) tasks = tasks.filter((t) => t.status === opts.status);
    if (opts.assignee)
      tasks = tasks.filter((t) => (t.assignee ?? null) === opts.assignee);
    if (opts.tenant)
      tasks = tasks.filter((t) => (t.tenant ?? null) === opts.tenant);
    return { success: true, data: tasks.map(adaptTaskRow) };
  } catch (err) {
    return remoteFailure(err);
  }
}

export async function remoteGetTask(
  taskId: string,
): Promise<KanbanResult<KanbanTaskDetail>> {
  if (!taskId) return { success: false, error: "Missing task ID" };
  try {
    const data = await kanbanJson<{
      task?: RemoteTaskRow;
      comments?: RemoteCommentRow[];
      events?: RemoteEventRow[];
      runs?: RemoteRunRow[];
      links?: { parents?: string[]; children?: string[] };
    }>(`/tasks/${encodeURIComponent(taskId)}`);
    if (!data.task) {
      return { success: false, error: `no such task: ${taskId}` };
    }
    const links = data.links ?? {};
    const detail: KanbanTaskDetail = {
      task: adaptTaskRow(data.task),
      comments: (data.comments ?? []).map(adaptCommentRow),
      events: (data.events ?? []).map(adaptEventRow),
      parents: links.parents ?? [],
      children: links.children ?? [],
      runs: (data.runs ?? []).map(adaptRunRow),
      latest_summary: (data.task.latest_summary as string | undefined) ?? null,
    };
    return { success: true, data: detail };
  } catch (err) {
    return remoteFailure(err);
  }
}

// --- Tasks (writes) -------------------------------------------------------------

export async function remoteCreateTask(
  input: CreateTaskInput,
): Promise<KanbanResult<{ id: string }>> {
  if (!input.title?.trim())
    return { success: false, error: "Title is required" };
  try {
    // workspace: "scratch" | "worktree" | "dir:<path>" (CLI syntax) maps to
    // the plugin's workspace_kind / workspace_path pair.
    let workspaceKind: string | undefined;
    let workspacePath: string | undefined;
    if (input.workspace === "scratch" || input.workspace === "worktree") {
      workspaceKind = input.workspace;
    } else if (input.workspace?.startsWith("dir:")) {
      workspaceKind = "dir";
      workspacePath = input.workspace.slice(4);
    }
    const body: Record<string, unknown> = {
      title: input.title,
      body: input.body ?? null,
      assignee: input.assignee ?? null,
      tenant: input.tenant ?? null,
      priority: input.priority ?? 0,
      triage: Boolean(input.triage),
    };
    if (workspaceKind) body.workspace_kind = workspaceKind;
    if (workspacePath) body.workspace_path = workspacePath;
    if (input.skills?.length) body.skills = input.skills;
    // NOTE: CLI --max-retries has no plugin create field; it is ignored here.
    const data = await kanbanJson<{ task?: { id?: string } }>(`/tasks`, {
      method: "POST",
      body,
    });
    const id = data.task?.id ?? "";
    if (!id) {
      return { success: false, error: "Kanban create returned no task id" };
    }
    return { success: true, data: { id } };
  } catch (err) {
    return remoteFailure(err);
  }
}

async function remotePatchTask(
  taskId: string,
  body: Record<string, unknown>,
): Promise<KanbanResult<void>> {
  try {
    await kanbanJson(`/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body,
    });
    return { success: true };
  } catch (err) {
    return remoteFailure(err);
  }
}

export function remoteAssignTask(
  taskId: string,
  assignee: string | null,
): Promise<KanbanResult<void>> {
  // "" unassigns on the plugin (assignee is Optional[str]); null → "".
  return remotePatchTask(taskId, { assignee: assignee || "" });
}

export function remoteCompleteTask(
  taskId: string,
  result?: string,
): Promise<KanbanResult<void>> {
  return remotePatchTask(taskId, {
    status: "done",
    ...(result !== undefined ? { result } : {}),
  });
}

export function remoteBlockTask(
  taskId: string,
  reason?: string,
): Promise<KanbanResult<void>> {
  return remotePatchTask(taskId, {
    status: "blocked",
    ...(reason !== undefined ? { block_reason: reason } : {}),
  });
}

export function remoteUnblockTask(taskId: string): Promise<KanbanResult<void>> {
  // unblock → ready: the plugin's ready handler routes blocked/scheduled →
  // unblock_task, exactly the CLI verb's effect.
  return remotePatchTask(taskId, { status: "ready" });
}

export function remoteArchiveTask(taskId: string): Promise<KanbanResult<void>> {
  return remotePatchTask(taskId, { status: "archived" });
}

export function remotePromoteTask(taskId: string): Promise<KanbanResult<void>> {
  // CLI promote (todo/blocked → ready) == PATCH status ready.
  return remotePatchTask(taskId, { status: "ready" });
}

export function remoteScheduleTask(
  taskId: string,
  reason?: string,
): Promise<KanbanResult<void>> {
  return remotePatchTask(taskId, {
    status: "scheduled",
    ...(reason !== undefined ? { block_reason: reason } : {}),
  });
}

export async function remoteSpecifyTask(
  taskId: string,
): Promise<KanbanResult<void>> {
  try {
    // Non-OK is NOT an HTTP error on this route — the plugin returns
    // {ok, reason} so the UI can render the reason inline.
    const data = await kanbanJson<{ ok?: boolean; reason?: string }>(
      `/tasks/${encodeURIComponent(taskId)}/specify`,
      { method: "POST", body: {} },
    );
    if (!data.ok) {
      return { success: false, error: data.reason || "specify failed" };
    }
    return { success: true };
  } catch (err) {
    return remoteFailure(err);
  }
}

export async function remoteReclaimTask(
  taskId: string,
  reason?: string,
): Promise<KanbanResult<void>> {
  try {
    await kanbanJson(`/tasks/${encodeURIComponent(taskId)}/reclaim`, {
      method: "POST",
      body: { reason: reason ?? null },
    });
    return { success: true };
  } catch (err) {
    return remoteFailure(err);
  }
}

export function remoteCommentTask(
  taskId: string,
  body: string,
): Promise<KanbanResult<void>> {
  if (!body.trim()) {
    return Promise.resolve({ success: false, error: "Empty comment" });
  }
  // POST /tasks/:id/comments — never PATCH: the patch route's ``body`` field
  // edits the task description itself.
  return kanbanJson(`/tasks/${encodeURIComponent(taskId)}/comments`, {
    method: "POST",
    body: { body, author: "desktop" },
  }).then(
    (): KanbanResult<void> => ({ success: true }),
    (err: unknown): KanbanResult<void> => remoteFailure<void>(err),
  );
}

export async function remoteDispatchOnce(
  dryRun = false,
): Promise<KanbanResult<unknown>> {
  try {
    const data = await kanbanJson<unknown>(
      `/dispatch${dryRun ? "?dry_run=true" : ""}`,
      { method: "POST" },
    );
    return { success: true, data };
  } catch (err) {
    return remoteFailure(err);
  }
}

// --- Guard ---------------------------------------------------------------------

/**
 * True when the caller should route through the remote plugin adapter instead
 * of the local CLI/SSH exec path.
 */
export function shouldUseRemoteKanban(): boolean {
  return isRemoteOnlyMode();
}
