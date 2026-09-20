import type { ChatMessage } from "./types";

/** Tool names the agent's todo tool is registered under (`todo_list`, plus
 * the legacy `todo` alias for pre-rename replays — mirrors the backend's
 * `_TODO_TOOL_NAMES`). */
const TODO_TOOL_NAMES = new Set(["todo_list", "todo"]);

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface TodoSnapshot {
  items: TodoItem[];
  revision: number;
}

/** Max tool-result length we bother parsing — mirrors the backend's
 * `MAX_TODO_RESULT_CHARS` guard in tools/todo_tool.py. */
const MAX_TODO_RESULT_CHARS = 20_000;

function normalizeStatus(value: unknown): TodoItem["status"] {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  return s === "in_progress" || s === "completed" || s === "cancelled"
    ? s
    : "pending";
}

function parseSnapshot(raw: string): TodoSnapshot | null {
  if (raw.length > MAX_TODO_RESULT_CHARS || !raw.includes('"todos"')) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const todos = (parsed as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return null;
  const items = todos
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t, i) => ({
      id:
        typeof t.id === "string" || typeof t.id === "number"
          ? String(t.id)
          : String(i + 1),
      content: typeof t.content === "string" ? t.content : "(invalid item)",
      status: normalizeStatus(t.status),
    }));
  const revision =
    typeof (parsed as { revision?: unknown }).revision === "number"
      ? Math.max(0, (parsed as { revision: number }).revision)
      : 0;
  return { items, revision };
}

/**
 * Latest todo snapshot from a chat transcript (issue #126): the newest tool
 * result of the agent's `todo_list` tool IS the current task list — the same
 * derivation the backend's `_todo_state_from_history` performs on resume.
 * Returns null when the chat never used the todo tool.
 */
export function todoFromMessages(messages: ChatMessage[]): TodoSnapshot | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind !== "tool_result") continue;
    if (!TODO_TOOL_NAMES.has(m.name)) continue;
    const snapshot = parseSnapshot(m.content);
    if (snapshot !== null) return snapshot;
  }
  return null;
}

/** Live `todo.updated` event payload → snapshot (same shape as the tool
 * result). Returns null for malformed frames. */
export function todoFromEvent(payload: unknown): TodoSnapshot | null {
  if (payload === null || typeof payload !== "object") return null;
  try {
    return parseSnapshot(JSON.stringify(payload));
  } catch {
    return null;
  }
}
