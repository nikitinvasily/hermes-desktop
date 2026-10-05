/**
 * Dedupe policy for persisting a chat's project (context-folder) binding.
 *
 * The persist effect in [[src/renderer/src/screens/Chat/Chat.tsx]] runs on
 * [hermesSessionId, contextFolder] changes, but a naive folder-only guard is
 * wrong: the runtime session can be RECREATED mid-send after a WebSocket drop
 * (the transport's recovery / recreate paths swap hermesSessionId A → B while
 * the project folder stays the same). A folder-only skip leaves the LIVE
 * session without its desktop binding, so a remote chat created from a
 * project's `+` silently falls into the flat Chats list (issue #162).
 */
export interface FolderPersistGuard {
  sessionId: string;
  folder: string | null;
}

/**
 * Whether the binding must be (re)written for this session/folder pair.
 * Returns false only for an exact (sessionId, folder) repeat — including the
 * no-session case (nothing to persist yet) — and true whenever EITHER
 * component changed, so a recreated session id re-persists the same folder.
 */
export function shouldPersistSessionFolder(
  guard: FolderPersistGuard | null,
  sessionId: string | null,
  folder: string | null,
): boolean {
  if (!sessionId) return false;
  if (guard && guard.sessionId === sessionId && guard.folder === folder) {
    return false;
  }
  return true;
}
