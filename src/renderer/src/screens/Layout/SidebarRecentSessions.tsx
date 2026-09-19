import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  memo,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../components/useI18n";
import {
  ArchiveBox,
  ChevronDown,
  ChevronRight,
  Circle,
  Folder,
  Loader,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Trash,
  X,
} from "../../assets/icons";
import { confirmSessionRename } from "../Sessions/confirmSessionRename";
import SidebarSessionMenu, {
  type SidebarMenuProject,
  type SidebarMenuTarget,
} from "./SidebarSessionMenu";
import ArchiveDialog, { type ArchiveFilter } from "./ArchiveDialog";
import ProjectDialog, { type ProjectDialogState } from "./ProjectDialog";
import type { ProjectInfo } from "../../../../shared/projects";

interface RecentSession {
  id: string;
  title: string;
  contextFolder?: string | null;
  /** Recency timestamp when known (cached/tree rows); absent on pending rows. */
  startedAt?: number;
  /** By-modification ordering key (issue #74); startedAt fallback. */
  lastActivityAt?: number;
  /** Finished-but-not-viewed bullet (issue #90): activity postdates the
   *  agent's last_read_at watermark. */
  unread?: boolean;
}

/** Recency key for sidebar ordering (issue #74): last activity, startedAt fallback. */
function activityKey(s: RecentSession): number {
  return s.lastActivityAt ?? s.startedAt ?? 0;
}

// ChatGPT-style paged conversation list under the pinned app navigation.
export const RECENT_SESSIONS_PAGE_SIZE = 30;

// Re-sync cadence while the list is visible. Deliberately slower than the
// Sessions screen (30s) — the sidebar is always on screen, so this interval
// runs for the whole app lifetime when the section is expanded.
const RECENT_REFRESH_MS = 60_000;

// Minimum gap between event-driven refreshes (focus, session switch) so a
// burst of focus/blur events doesn't hammer state.db.
const REFRESH_THROTTLE_MS = 5_000;
const INFINITE_SCROLL_THRESHOLD_PX = 180;
const PROJECTS_OPEN_KEY = "hermes.sidebar.projectsOpen";
const CHATS_OPEN_KEY = "hermes.sidebar.chatsOpen";
const FOLDERS_CLOSED_KEY = "hermes.sidebar.closedProjectFolders";
const PINNED_OPEN_KEY = "hermes.sidebar.pinnedOpen";
// Pinned session ids live in localStorage like the disclosure state — pinning
// is a desktop-only UI affordance, not part of the agent session schema.
const PINNED_IDS_KEY = "hermes.sidebar.pinnedSessions";

function readStoredPinned(): Set<string> {
  try {
    const raw = localStorage.getItem(PINNED_IDS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter(String) : []);
  } catch {
    return new Set();
  }
}

function storePinned(ids: Set<string>): void {
  try {
    localStorage.setItem(PINNED_IDS_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    /* ignore persistence failures */
  }
}

function readStoredOpen(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "false";
  } catch {
    return true;
  }
}

function readStoredClosedFolders(): Set<string> {
  try {
    const raw = localStorage.getItem(FOLDERS_CLOSED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter(String) : []);
  } catch {
    return new Set();
  }
}

function storeClosedFolders(paths: Set<string>): void {
  try {
    localStorage.setItem(FOLDERS_CLOSED_KEY, JSON.stringify(Array.from(paths)));
  } catch {
    /* ignore persistence failures */
  }
}

function sameSessions(a: RecentSession[], b: RecentSession[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].id !== b[i].id ||
      a[i].title !== b[i].title ||
      (a[i].contextFolder ?? null) !== (b[i].contextFolder ?? null) ||
      a[i].unread !== b[i].unread
    ) {
      return false;
    }
  }
  return true;
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || path;
}

/** Normalize separators/trailing slashes so paths compare reliably. */
function normalizeFolderPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function groupSessionsByWorkspace(sessions: RecentSession[]): {
  projectGroups: Array<{
    path: string;
    name: string;
    sessions: RecentSession[];
  }>;
  chats: RecentSession[];
} {
  const projects = new Map<string, RecentSession[]>();
  const chats: RecentSession[] = [];

  for (const session of sessions) {
    const contextFolder = session.contextFolder?.trim();
    if (!contextFolder) {
      chats.push(session);
      continue;
    }
    const existing = projects.get(contextFolder);
    if (existing) existing.push(session);
    else projects.set(contextFolder, [session]);
  }

  return {
    projectGroups: Array.from(projects.entries()).map(([path, list]) => ({
      path,
      name: folderName(path),
      sessions: list,
    })),
    chats,
  };
}

/**
 * Recent-sessions list rendered under the "Sessions" nav item in the sidebar
 * (like ChatGPT's sidebar chat list). Owns its own data so Layout re-renders
 * (view switches, update banners, …) never trigger fetches, and `memo` keeps
 * it off the render hot path entirely.
 *
 * Fetch strategy, cheapest first:
 *  - on open: instant read from the sessions.json cache (no DB), then one
 *    sync against state.db to pick up sessions created since the last sync
 *  - while open: refresh on window focus and on a slow interval, throttled
 *  - closed (collapsed section or icon-only sidebar): zero work, renders null
 */
const SidebarRecentSessions = memo(function SidebarRecentSessions({
  open,
  connectionId,
  activeProfile,
  currentSessionId,
  loadingSessionIds,
  approvalSessionIds,
  resumingSessionId,
  onSelect,
  onNewChatInProject,
  onSessionDeleted,
  scrollRootRef,
}: {
  open: boolean;
  /** Stable connection registry id used to route every session operation. */
  connectionId: string;
  /** Active profile — the list is per-profile, so switching forces a reload. */
  activeProfile: string;
  currentSessionId: string | null;
  /** Session ids of every run currently generating (multiple run at once). */
  loadingSessionIds: Set<string>;
  /** Session ids with a pending command approval (issue #90 bullets). */
  approvalSessionIds: Set<string>;
  /** A session whose history is being fetched for resume (transient spinner). */
  resumingSessionId: string | null;
  onSelect: (sessionId: string) => void;
  /** Start a new chat bound to a project folder (project `+`) or unbound
   *  (Chats header `+`, folder = null). */
  onNewChatInProject?: (folder: string | null) => void;
  /** Notifies Layout when a row is deleted so it can leave a stale active chat. */
  onSessionDeleted?: (sessionId: string) => void;
  /** Scroll container owned by Layout; nearing its bottom loads the next page. */
  scrollRootRef: RefObject<HTMLDivElement | null>;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  // True when the profile has more cache rows than the sidebar has loaded.
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(() =>
    readStoredOpen(PROJECTS_OPEN_KEY),
  );
  const [chatsOpen, setChatsOpen] = useState(() =>
    readStoredOpen(CHATS_OPEN_KEY),
  );
  const [closedProjectFolders, setClosedProjectFolders] = useState<Set<string>>(
    () => readStoredClosedFolders(),
  );
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() =>
    readStoredPinned(),
  );
  const [pinnedOpen, setPinnedOpen] = useState(() =>
    readStoredOpen(PINNED_OPEN_KEY),
  );
  // Archive modal (issue #34): opened from the Chats header Archive button;
  // the modal owns the archived list, the parent only supplies routing.
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  // Which archived chats the modal shows (issue #64): the Chats header icon
  // means UNBOUND chats only, a project row's archive icon scopes to that
  // project's folder.
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>({
    kind: "unbound",
  });
  const [archiveProjectName, setArchiveProjectName] = useState<
    string | undefined
  >(undefined);

  const openArchive = (filter: ArchiveFilter, projectName?: string): void => {
    setArchiveFilter(filter);
    setArchiveProjectName(projectName);
    setArchiveDialogOpen(true);
  };
  // Remount counter for the archive modal: bumped after a confirmed delete
  // from the archive so the modal reloads its list (the delete confirmation
  // lives in the parent and the modal's list is child-local state).
  const [archiveDialogNonce, setArchiveDialogNonce] = useState(0);
  // True when the shared delete-confirmation dialog was opened FROM the
  // archive modal — routes the confirm to the archive delete path.
  const [pendingDeleteIsArchived, setPendingDeleteIsArchived] = useState(false);
  // Folder path → human project name from the agent's projects.db / the
  // dashboard projects tree (issue #23). Empty until loaded; the folder-slug
  // fallback covers the gap.
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  // Agent-side projects (issue #27): every project with its folders, including
  // zero-session ones, so the Projects section can render empty groups and
  // offer edit/delete. Undefined until the first successful load.
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  // Project dialog (create/edit) and pending delete-project confirmation.
  const [projectDialog, setProjectDialog] = useState<ProjectDialogState | null>(
    null,
  );
  const [pendingDeleteProject, setPendingDeleteProject] =
    useState<ProjectInfo | null>(null);
  // Complete per-project session lists from the agent's projects tree
  // (issue #57, stage 2). Over Remote/SSH the 50-row recency window truncates
  // group membership; this map carries the full membership per folder. Empty
  // until loaded and on local connections (the window already covers local).
  const [projectGroupSessions, setProjectGroupSessions] = useState<
    Record<string, RecentSession[]>
  >({});
  const [deletingProject, setDeletingProject] = useState(false);
  const [projectError, setProjectError] = useState("");
  // Active connection mode — drives the dialog's folder picker (native vs
  // text input for paths on the agent host).
  const [connectionMode, setConnectionMode] = useState<
    "local" | "remote" | "ssh"
  >("local");
  // Row whose context menu is open, anchored to viewport coordinates.
  const [menuTarget, setMenuTarget] = useState<SidebarMenuTarget | null>(null);
  // Inline rename: the row id being edited and its working title.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const editingIdRef = useRef<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [renameSaving, setRenameSaving] = useState(false);
  const renameContext = `${connectionId}\0${activeProfile}`;
  const renameContextRef = useRef(renameContext);
  useEffect(() => {
    renameContextRef.current = renameContext;
  }, [renameContext]);
  // Pending delete confirmation (small inline dialog in a portal-free overlay).
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const lastRefreshRef = useRef(0);
  const sessionsRef = useRef<RecentSession[]>([]);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  useEffect(() => {
    editingIdRef.current = editingId;
  }, [editingId]);

  useEffect(() => {
    storePinned(pinnedIds);
  }, [pinnedIds]);

  const normalizeRows = useCallback(
    (
      list: Array<{
        id: string;
        title: string;
        contextFolder?: string | null;
        startedAt?: number;
        lastActivityAt?: number;
        unread?: boolean;
      }>,
      limit = RECENT_SESSIONS_PAGE_SIZE,
    ): RecentSession[] =>
      list
        .slice(0, limit)
        .map(
          ({
            id,
            title,
            contextFolder,
            startedAt,
            lastActivityAt,
            unread,
          }) => ({
            id,
            title,
            contextFolder: contextFolder ?? null,
            startedAt,
            lastActivityAt: lastActivityAt ?? startedAt,
            unread: unread === true,
          }),
        ),
    [],
  );

  const applyFirstPage = useCallback(
    (
      list: Array<{
        id: string;
        title: string;
        contextFolder?: string | null;
      }>,
    ): void => {
      setHasMore(list.length > RECENT_SESSIONS_PAGE_SIZE);
      const next = normalizeRows(list);
      // Skip the state update (and re-render) when nothing changed — the
      // common case for periodic refreshes.
      setSessions((prev) => (sameSessions(prev, next) ? prev : next));
    },
    [normalizeRows],
  );

  const applyLoadedWindow = useCallback(
    (
      list: Array<{
        id: string;
        title: string;
        contextFolder?: string | null;
      }>,
    ): void => {
      const loadedLimit = Math.max(
        RECENT_SESSIONS_PAGE_SIZE,
        sessionsRef.current.length,
      );
      setHasMore(list.length > loadedLimit);
      const next = normalizeRows(list, loadedLimit);
      setSessions((prev) => (sameSessions(prev, next) ? prev : next));
    },
    [normalizeRows],
  );

  const appendPage = useCallback(
    (
      list: Array<{
        id: string;
        title: string;
        contextFolder?: string | null;
      }>,
    ): void => {
      setHasMore(list.length > RECENT_SESSIONS_PAGE_SIZE);
      const page = normalizeRows(list);
      if (page.length === 0) return;
      setSessions((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        const next = [...prev];
        for (const session of page) {
          if (!seen.has(session.id)) next.push(session);
        }
        return sameSessions(prev, next) ? prev : next;
      });
    },
    [normalizeRows],
  );

  const refresh = useCallback(
    async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastRefreshRef.current < REFRESH_THROTTLE_MS) return;
      lastRefreshRef.current = now;
      try {
        const synced = await window.hermesAPI.syncSessionCache(
          connectionId,
          activeProfile,
        );
        applyLoadedWindow(synced);
      } catch {
        // keep whatever we had — the list is best-effort UI sugar
      }
    },
    [activeProfile, applyLoadedWindow, connectionId],
  );

  const loadNextPage = useCallback(async (): Promise<void> => {
    if (!open || !hasMoreRef.current || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const nextPage = await window.hermesAPI.listCachedSessions(
        RECENT_SESSIONS_PAGE_SIZE + 1,
        sessionsRef.current.length,
        connectionId,
        activeProfile,
      );
      appendPage(nextPage);
    } catch {
      // keep the current list; scrolling can retry on the next event
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [activeProfile, appendPage, connectionId, open]);

  const maybeLoadNextPage = useCallback((): void => {
    const root = scrollRootRef.current;
    if (!projectsOpen && !chatsOpen) return;
    if (!root || !hasMoreRef.current || loadingMoreRef.current) return;
    const remaining = root.scrollHeight - root.scrollTop - root.clientHeight;
    if (remaining <= INFINITE_SCROLL_THRESHOLD_PX) void loadNextPage();
  }, [chatsOpen, loadNextPage, projectsOpen, scrollRootRef]);

  // Initial load when the section opens: paint from the JSON cache
  // immediately (no DB access), then sync once for anything new.
  // Sequenced so sync always wins over cache (avoids race where stale
  // cache overwrites fresh sync if sync resolves first).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const cached = await window.hermesAPI.listCachedSessions(
          // One over the page size so the cache read alone can decide whether
          // another page exists without a separate count query.
          RECENT_SESSIONS_PAGE_SIZE + 1,
          0,
          connectionId,
          activeProfile,
        );
        if (!cancelled) applyFirstPage(cached);
      } catch {
        /* ignore cache read errors */
      }
      lastRefreshRef.current = Date.now();
      try {
        const synced = await window.hermesAPI.syncSessionCache(
          connectionId,
          activeProfile,
        );
        if (!cancelled) applyFirstPage(synced);
      } catch {
        // cache read above already painted something
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, connectionId, activeProfile, applyFirstPage]);

  // While open: pick up background sessions (gateway, cron, other devices)
  // on focus and on a slow timer. No listeners or timers at all when closed.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void refresh(), RECENT_REFRESH_MS);
    const onFocus = (): void => {
      void refresh();
    };
    const onContextFolderChanged = (): void => {
      void refresh(true);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(
      "hermes-session-context-folder-changed",
      onContextFolderChanged,
    );
    // A turn finished somewhere (issue #90): the session may now be unread —
    // refresh past the throttle so the sidebar bullet appears immediately.
    window.addEventListener("hermes-sessions-maybe-changed", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("hermes-sessions-maybe-changed", onFocus);
      window.removeEventListener(
        "hermes-session-context-folder-changed",
        onContextFolderChanged,
      );
    };
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const root = scrollRootRef.current;
    if (!root) return;
    const onScroll = (): void => {
      maybeLoadNextPage();
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    maybeLoadNextPage();
    return () => {
      root.removeEventListener("scroll", onScroll);
    };
  }, [maybeLoadNextPage, open, scrollRootRef]);

  // If the first page does not fill the sidebar, keep paging until the scroll
  // container has real overflow or the cache runs out.
  useEffect(() => {
    if (open) maybeLoadNextPage();
  }, [hasMore, maybeLoadNextPage, open, sessions.length]);

  // Resuming/switching sessions reorders recency — refresh (throttled).
  // Also refreshes when going to "New Chat" (currentSessionId becomes null)
  // so the just-left session appears in the list immediately.
  useEffect(() => {
    if (open) void refresh();
  }, [open, currentSessionId, refresh]);

  // Switching agent points the list at a different profile's DB. Force a
  // reload immediately (bypassing the throttle) so the list isn't stale.
  const prevProfileRef = useRef(activeProfile);
  useEffect(() => {
    if (prevProfileRef.current === activeProfile) return;
    prevProfileRef.current = activeProfile;
    void refresh(true);
  }, [activeProfile, refresh]);

  // Load folder→name once the section is open; reloaded on connection/profile
  // switch so a different agent's projects get their own names (issue #23).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void window.hermesAPI
      .listProjectFolderNames(connectionId, activeProfile)
      .then((names) => {
        if (!cancelled) setProjectNames(names ?? {});
      })
      .catch(() => {
        /* slug fallback stays in effect */
      });
    return () => {
      cancelled = true;
    };
  }, [open, connectionId, activeProfile]);

  // Load the complete per-project session lists (issue #57, stage 2) on the
  // same triggers as the names map. A failure or local connection leaves an
  // empty map — the window-derived groups stay in effect untouched.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setProjectGroupSessions({});
    void window.hermesAPI
      .listProjectGroupSessions(connectionId, activeProfile)
      .then((groups) => {
        if (cancelled) return;
        // Key every row by its own (binding-merged) folder, not the tree
        // node's folder: the main side re-homes rows per desktop bindings
        // (issue #66), so a moved chat must leave the original project's
        // list and land in the destination folder's list.
        const next: Record<string, RecentSession[]> = {};
        for (const [folder, list] of Object.entries(groups ?? {})) {
          for (const s of Array.isArray(list) ? list : []) {
            const rowFolder = s.contextFolder ?? folder;
            (next[rowFolder] ??= []).push({
              id: s.id,
              title: s.title,
              contextFolder: rowFolder,
              startedAt: s.startedAt,
              lastActivityAt: s.lastActivityAt,
            });
          }
        }
        for (const list of Object.values(next)) {
          list.sort((a, b) => activityKey(b) - activityKey(a));
        }
        setProjectGroupSessions(next);
      })
      .catch(() => {
        /* window-derived groups remain */
      });
    return () => {
      cancelled = true;
    };
  }, [open, connectionId, activeProfile]);

  // Load the agent's project list (issue #27) — same triggers as the names
  // map, plus an explicit refresh() after mutations. The registry read gives
  // the active connection mode for the dialog's folder picker.
  const refreshProjects = useCallback(async (): Promise<void> => {
    try {
      const list = await window.hermesAPI.listProjects(
        connectionId,
        activeProfile,
      );
      setProjects(Array.isArray(list) ? list : []);
    } catch {
      /* leave the previous list; the section falls back to session groups */
    }
  }, [connectionId, activeProfile]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setProjects(null);
    void refreshProjects();
    void window.hermesAPI
      .getConnectionRegistry()
      .then((registry) => {
        if (cancelled) return;
        const active = registry.connections.find(
          (c) => c.connectionId === registry.activeConnectionId,
        );
        setConnectionMode(active?.mode ?? "local");
      })
      .catch(() => {
        /* default local stays */
      });
    return () => {
      cancelled = true;
    };
  }, [open, connectionId, activeProfile, refreshProjects]);

  // Projects also refresh on the slow background cadence, so a project
  // created by another surface (agent CLI, dashboard) shows up without a
  // section remount.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void refreshProjects(), RECENT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [open, refreshProjects]);

  const handleProjectMutate = useCallback(
    async (
      mutation: import("../../../../shared/projects").ProjectMutation,
    ): Promise<unknown> => {
      return window.hermesAPI.projectMutate(
        mutation,
        connectionId,
        activeProfile,
      );
    },
    [connectionId, activeProfile],
  );

  const handleProjectChanged = useCallback((): void => {
    void refreshProjects();
    // Project names may change too (create/rename) — reload the name map so
    // the group heading updates without waiting for the next section open.
    void window.hermesAPI
      .listProjectFolderNames(connectionId, activeProfile)
      .then((names) => setProjectNames(names ?? {}))
      .catch(() => undefined);
  }, [connectionId, activeProfile, refreshProjects]);

  const confirmDeleteProject = useCallback(async (): Promise<void> => {
    if (!pendingDeleteProject) return;
    setDeletingProject(true);
    setProjectError("");
    try {
      await handleProjectMutate({
        op: "delete",
        id: pendingDeleteProject.id,
      });
      setPendingDeleteProject(null);
      handleProjectChanged();
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingProject(false);
    }
  }, [pendingDeleteProject, handleProjectMutate, handleProjectChanged]);

  // Keep the wrapper mounted so the collapse/expand animates with CSS grid
  // tracks. Effects above are still gated on `open`, so a collapsed sidebar
  // does no fetching while keeping the last-loaded list ready to animate.
  const expanded = open;

  // Pinned rows are pulled out of the normal grouping and shown in their own
  // section at the top (ChatGPT-style), preserving recency order.
  const pinnedSessions = useMemo(
    () => sessions.filter((s) => pinnedIds.has(s.id)),
    [sessions, pinnedIds],
  );
  const { projectGroups, chats } = useMemo(() => {
    const base = groupSessionsByWorkspace(
      sessions.filter((s) => !pinnedIds.has(s.id)),
    );
    // Inside-group order is by-modification (issue #74): the main side sorts
    // its lists, but re-sorting here keeps groups correct even when a window
    // arrives unsorted (remote fallback paths).
    let groups = base.projectGroups.map((g) => ({
      ...g,
      sessions: [...g.sessions].sort((a, b) => activityKey(b) - activityKey(a)),
    }));
    // Complete per-project membership from the agent's projects tree (issue
    // #57, stage 2): window rows and tree rows merge per folder, deduped by
    // session id (window rows win — they carry fresher titles), recency order
    // kept by last activity descending (issue #74).
    const treeFolders = Object.keys(projectGroupSessions);
    if (treeFolders.length > 0) {
      const merged = groups.map((g) => {
        const extra = projectGroupSessions[g.path];
        if (!extra || extra.length === 0) return g;
        const seen = new Set(g.sessions.map((s) => s.id));
        const combined = [
          ...g.sessions,
          ...extra.filter((s) => !seen.has(s.id)),
        ];
        combined.sort((a, b) => activityKey(b) - activityKey(a));
        return { ...g, sessions: combined };
      });
      const known = new Set(merged.map((g) => g.path));
      const unseen: Array<{
        path: string;
        name: string;
        sessions: RecentSession[];
      }> = [];
      for (const folder of treeFolders) {
        if (known.has(folder) || projectGroupSessions[folder].length === 0)
          continue;
        unseen.push({
          path: folder,
          name: folderName(folder),
          sessions: [...projectGroupSessions[folder]],
        });
      }
      groups = [...merged, ...unseen];
    }
    // Projects-only rule (issue #68): a folder with sessions but NO project
    // record is not a project — its sessions belong to the flat Chats list,
    // not a pseudo-group without edit/delete affordances. Applied only when
    // the project list has LOADED (non-null): while it is still loading (or
    // failed, e.g. a remote 401), keep the old behavior so groups do not
    // vanish during transient errors.
    if (projects !== null) {
      const knownFolders = new Set<string>();
      for (const p of projects) {
        for (const f of p.folders) {
          if (f.path) knownFolders.add(normalizeFolderPath(f.path));
        }
        if (p.primaryPath) knownFolders.add(normalizeFolderPath(p.primaryPath));
      }
      const kept: typeof groups = [];
      let demoted: RecentSession[] = [];
      for (const g of groups) {
        if (knownFolders.has(normalizeFolderPath(g.path))) {
          kept.push(g);
        } else {
          demoted = demoted.concat(g.sessions);
        }
      }
      groups = kept;
      if (demoted.length > 0) base.chats.push(...demoted);
    }
    if (projects && projects.length > 0) {
      const known = new Set(groups.map((g) => g.path));
      const extra: Array<{
        path: string;
        name: string;
        sessions: RecentSession[];
      }> = [];
      for (const p of projects) {
        for (const f of p.folders) {
          if (f.path && !known.has(f.path)) {
            known.add(f.path);
            extra.push({
              path: f.path,
              name: folderName(f.path),
              sessions: [],
            });
          }
        }
        if (p.primaryPath && !known.has(p.primaryPath)) {
          known.add(p.primaryPath);
          extra.push({
            path: p.primaryPath,
            name: folderName(p.primaryPath),
            sessions: [],
          });
        }
      }
      groups = [...groups, ...extra];
    }
    // Flat Chats list: by-modification order (issue #74).
    base.chats.sort((a, b) => activityKey(b) - activityKey(a));
    return { projectGroups: groups, chats: base.chats };
  }, [sessions, pinnedIds, projects, projectGroupSessions]);
  // Resolve each group's display name: the agent project's human name when
  // projects.db/the dashboard tree knows this folder, else the path's last
  // segment (issue #23). The projects list is a second name source so a
  // just-created project shows its name before the names map reloads.
  const projectNamesFromList = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of projects ?? []) {
      for (const f of p.folders) {
        if (f.path) map[f.path] = p.name;
      }
      if (p.primaryPath) map[p.primaryPath] = p.name;
    }
    return map;
  }, [projects]);
  const displayName = useCallback(
    (path: string): string =>
      projectNames[path] || projectNamesFromList[path] || folderName(path),
    [projectNames, projectNamesFromList],
  );

  // Stable alphabetical project order (issue #74): archiving a chat must not
  // reshuffle the Projects section, so groups sort by display name
  // (locale-aware), not by their sessions' recency.
  const sortedProjectGroups = useMemo(
    () =>
      [...projectGroups].sort((a, b) => {
        const na = displayName(a.path);
        const nb = displayName(b.path);
        return (
          na.localeCompare(nb, undefined, { sensitivity: "base" }) ||
          a.path.localeCompare(b.path)
        );
      }),
    [projectGroups, displayName],
  );

  // Choices for "Move to project": EVERY loaded agent project (zero-session
  // ones included — the same source as the Projects section, issue #36).
  // Projects-only (issue #68): session-derived folders with no project
  // record are no longer offered — a chat cannot be moved into a folder
  // that is not a project. The session-derived pass below stays only as a
  // fallback while the project list has not loaded (null), matching the
  // Projects-section filter's graceful degradation.
  const projectChoices = useMemo<SidebarMenuProject[]>(() => {
    const byPath = new Map<string, SidebarMenuProject>();
    if (projects === null) {
      for (const s of sessions) {
        const folder = s.contextFolder?.trim();
        if (folder && !byPath.has(folder)) {
          byPath.set(folder, {
            path: folder,
            name: projectNames[folder] || folderName(folder),
          });
        }
      }
    }
    for (const p of projects ?? []) {
      const add = (path: string | null | undefined): void => {
        const key = path?.trim();
        if (!key || byPath.has(key)) return;
        byPath.set(key, { path: key, name: p.name || folderName(key) });
      };
      add(p.primaryPath);
      for (const f of p.folders) add(f.path);
    }
    return Array.from(byPath.values());
  }, [sessions, projectNames, projects]);

  const togglePinned = (): void => {
    setPinnedOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PINNED_OPEN_KEY, String(next));
      } catch {
        /* ignore persistence failures */
      }
      return next;
    });
  };

  const handleTogglePin = useCallback((id: string): void => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const startRename = useCallback(
    (s: RecentSession): void => {
      if (renameSaving) return;
      setEditingId(s.id);
      setEditingTitle(s.title || "");
      setTimeout(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      }, 0);
    },
    [renameSaving],
  );

  const cancelRename = useCallback((): void => {
    setEditingId(null);
    setEditingTitle("");
  }, []);

  const confirmRename = useCallback(
    async (id: string, value: string): Promise<void> => {
      const previous =
        sessionsRef.current.find((s) => s.id === id)?.title ?? "";
      await confirmSessionRename({
        sessionId: id,
        value,
        currentTitle: previous,
        isCurrentContext: () => renameContextRef.current === renameContext,
        setSaving: setRenameSaving,
        isStillEditing: () => editingIdRef.current === id,
        applyOptimistic: (title) =>
          setSessions((prev) =>
            prev.map((s) => (s.id === id ? { ...s, title } : s)),
          ),
        rollback: () =>
          setSessions((prev) =>
            prev.map((s) => (s.id === id ? { ...s, title: previous } : s)),
          ),
        clearEditing: cancelRename,
        inputRef: renameInputRef,
        fallbackErrorMessage: t("sessions.renameFailed"),
        persist: (sessionId, title) =>
          window.hermesAPI.updateSessionTitle(
            sessionId,
            title,
            connectionId,
            activeProfile,
          ),
      });
    },
    [cancelRename, t, connectionId, activeProfile, renameContext],
  );

  const handleMoveToProject = useCallback(
    async (id: string, folder: string | null): Promise<void> => {
      const normalized = folder?.trim() || null;
      const current = sessionsRef.current.find((s) => s.id === id);
      if ((current?.contextFolder ?? null) === normalized) return;
      const previous = current?.contextFolder ?? null;
      setSessions((prev) =>
        prev.map((s) =>
          s.id === id ? { ...s, contextFolder: normalized } : s,
        ),
      );
      // The tree-derived group map (issue #57 stage 2) is served from a
      // server-cached tree and is not refetched on this action; re-home the
      // row optimistically so a moved chat leaves its original project
      // group immediately instead of lingering there until the next tree
      // refetch (issue #66).
      setProjectGroupSessions((prev) => {
        if (Object.keys(prev).length === 0) return prev;
        const next: Record<string, RecentSession[]> = {};
        let changed = false;
        let moved: RecentSession | null = null;
        for (const [folder, list] of Object.entries(prev)) {
          const row = list.find((s) => s.id === id) ?? null;
          if (row) {
            moved = row;
            changed = true;
          }
          if (folder !== normalized)
            next[folder] = list.filter((s) => s.id !== id);
        }
        if (normalized && moved) {
          next[normalized] = [
            { ...moved, contextFolder: normalized },
            ...(next[normalized] ?? []),
          ];
        }
        return changed ? next : prev;
      });
      try {
        await window.hermesAPI.setSessionContextFolder(
          id,
          normalized,
          connectionId,
          activeProfile,
        );
        // Other surfaces (chat view, Sessions screen) listen for this to
        // refresh their own grouping.
        window.dispatchEvent(
          new CustomEvent("hermes-session-context-folder-changed", {
            detail: { sessionId: id, folder: normalized },
          }),
        );
      } catch (err) {
        console.error("Failed to move session to project", id, err);
        setSessions((prev) =>
          prev.map((s) =>
            s.id === id ? { ...s, contextFolder: previous } : s,
          ),
        );
      }
    },
    [activeProfile, connectionId],
  );

  const confirmDelete = useCallback(
    async (id: string): Promise<void> => {
      setDeleting(true);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setPinnedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      // The tree-derived group map (issue #57 stage 2) is not refetched after
      // a delete; drop the row there too or the deleted chat resurrects in
      // its project group from the stale tree until the next connection/
      // profile change or restart (issue #80). Mirrors handleArchive.
      setProjectGroupSessions((prev) => {
        if (Object.keys(prev).length === 0) return prev;
        const next: Record<string, RecentSession[]> = {};
        let changed = false;
        for (const [folder, list] of Object.entries(prev)) {
          const filtered = list.filter((s) => s.id !== id);
          if (filtered.length !== list.length) changed = true;
          next[folder] = filtered;
        }
        return changed ? next : prev;
      });
      try {
        await window.hermesAPI.deleteSession(id, connectionId, activeProfile);
        onSessionDeleted?.(id);
      } catch (err) {
        console.error("Failed to delete session", id, err);
      } finally {
        setDeleting(false);
        setPendingDeleteId(null);
        void refresh(true);
      }
    },
    [activeProfile, connectionId, onSessionDeleted, refresh],
  );

  // Archive (issue #34). Optimistic: the row disappears from the list
  // immediately; on failure it comes back via refresh. The active chat is
  // intentionally left open when archived — archiving only removes it from
  // the sidebar list.
  const handleArchive = useCallback(
    async (id: string): Promise<void> => {
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setPinnedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      // The tree-derived group map (issue #57 stage 2) is not refetched on
      // this action; drop the row optimistically so an archived chat does
      // not resurrect in its project group from the stale tree cache.
      setProjectGroupSessions((prev) => {
        if (Object.keys(prev).length === 0) return prev;
        const next: Record<string, RecentSession[]> = {};
        let changed = false;
        for (const [folder, list] of Object.entries(prev)) {
          const filtered = list.filter((s) => s.id !== id);
          if (filtered.length !== list.length) changed = true;
          next[folder] = filtered;
        }
        return changed ? next : prev;
      });
      try {
        await window.hermesAPI.setSessionArchived(
          id,
          true,
          connectionId,
          activeProfile,
        );
      } catch (err) {
        console.error("Failed to archive session", id, err);
        void refresh(true);
      }
    },
    [activeProfile, connectionId, refresh],
  );

  const openMenuForSession = useCallback(
    (s: RecentSession, x: number, y: number): void => {
      setMenuTarget({
        id: s.id,
        title: s.title,
        contextFolder: s.contextFolder ?? null,
        x,
        y,
      });
    },
    [],
  );

  const toggleProjects = (): void => {
    setProjectsOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PROJECTS_OPEN_KEY, String(next));
      } catch {
        /* ignore persistence failures */
      }
      return next;
    });
  };

  const toggleChats = (): void => {
    setChatsOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CHATS_OPEN_KEY, String(next));
      } catch {
        /* ignore persistence failures */
      }
      return next;
    });
  };

  const toggleProjectFolder = (path: string): void => {
    setClosedProjectFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      storeClosedFolders(next);
      return next;
    });
  };

  const renderSessionButton = (
    s: RecentSession,
    project = false,
    visible = expanded,
    pinned = false,
  ): React.JSX.Element => {
    const title = s.title || t("sessions.newConversation");
    const loading = resumingSessionId === s.id || loadingSessionIds.has(s.id);
    const awaitingApproval = approvalSessionIds.has(s.id);
    const unread = s.unread === true && !loading && !awaitingApproval;
    // The active highlight persists while the agent works (loading) — the
    // spinner already signals activity, dropping the highlight made the
    // current chat look unfocused on every command run (issue #72).
    const active = currentSessionId === s.id;
    const editing = editingId === s.id;
    const menuOpen = menuTarget?.id === s.id;

    if (editing) {
      return (
        <div
          key={s.id}
          className={`sidebar-recent-session ${
            project ? "project-child" : ""
          } editing`}
        >
          <input
            ref={renameInputRef}
            disabled={renameSaving}
            className="sidebar-recent-session-rename"
            type="text"
            value={editingTitle}
            onChange={(e) => setEditingTitle(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                void confirmRename(s.id, editingTitle);
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelRename();
              }
            }}
            onBlur={() => void confirmRename(s.id, editingTitle)}
            tabIndex={visible ? 0 : -1}
          />
        </div>
      );
    }

    // `div role=button` (not <button>) so the trailing "options" control can be
    // a real nested button without invalid button-in-button markup.
    return (
      <div
        key={s.id}
        role="button"
        tabIndex={visible ? 0 : -1}
        className={`sidebar-recent-session ${project ? "project-child" : ""} ${
          active ? "active" : ""
        } ${menuOpen ? "menu-open" : ""}`}
        onClick={() => {
          // Read-state bullet (issue #90): opening a session marks it read —
          // optimistic local clear plus the durable watermark write.
          if (s.unread) {
            setSessions((prev) =>
              prev.map((row) =>
                row.id === s.id ? { ...row, unread: false } : row,
              ),
            );
            void window.hermesAPI
              .markSessionRead(s.id, connectionId, activeProfile)
              .catch(() => undefined);
          }
          onSelect(s.id);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(s.id);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenuForSession(s, e.clientX, e.clientY);
        }}
        title={title}
      >
        {awaitingApproval ? (
          <Circle
            className="sidebar-recent-session-dot sidebar-recent-session-dot--approval"
            size={7}
            fill="currentColor"
            strokeWidth={0}
          />
        ) : loading ? (
          <Loader
            className="sidebar-recent-session-dot sidebar-recent-session-dot--loading"
            size={13}
          />
        ) : unread ? (
          <Circle
            className="sidebar-recent-session-dot sidebar-recent-session-dot--unread"
            size={7}
            fill="currentColor"
            strokeWidth={0}
          />
        ) : pinned ? (
          <Pin className="sidebar-recent-session-dot" size={11} />
        ) : (
          <Circle className="sidebar-recent-session-dot" size={7} fill="none" />
        )}
        <span className="sidebar-recent-session-title">{title}</span>
        <button
          type="button"
          className="sidebar-recent-session-options"
          tabIndex={visible ? 0 : -1}
          aria-label={t("navigation.sessionMenu.options")}
          title={t("navigation.sessionMenu.options")}
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            openMenuForSession(s, rect.right, rect.bottom + 4);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <MoreHorizontal size={15} />
        </button>
      </div>
    );
  };

  return (
    <div
      className={`sidebar-recent-sessions-wrap ${expanded ? "expanded" : ""}`}
      aria-hidden={!expanded}
    >
      <div className="sidebar-recent-sessions">
        {pinnedSessions.length > 0 && (
          <div className="sidebar-recent-section">
            <button
              type="button"
              className="sidebar-recent-section-toggle"
              onClick={togglePinned}
              aria-expanded={pinnedOpen}
              tabIndex={expanded ? 0 : -1}
            >
              <span>{t("navigation.pinned")}</span>
              {pinnedOpen ? (
                <ChevronDown
                  className="sidebar-recent-disclosure-icon"
                  size={13}
                />
              ) : (
                <ChevronRight
                  className="sidebar-recent-disclosure-icon"
                  size={13}
                />
              )}
            </button>
            <div
              className={`sidebar-recent-collapse ${
                pinnedOpen ? "expanded" : ""
              }`}
            >
              <div className="sidebar-recent-collapse-inner">
                {pinnedSessions.map((s) =>
                  renderSessionButton(s, false, expanded && pinnedOpen, true),
                )}
              </div>
            </div>
          </div>
        )}
        {projectGroups.length > 0 && (
          <div className="sidebar-recent-section">
            <div className="sidebar-recent-section-row">
              <button
                type="button"
                className="sidebar-recent-section-toggle"
                onClick={toggleProjects}
                aria-expanded={projectsOpen}
                tabIndex={expanded ? 0 : -1}
              >
                <span>{t("navigation.projects")}</span>
                {projectsOpen ? (
                  <ChevronDown
                    className="sidebar-recent-disclosure-icon"
                    size={13}
                  />
                ) : (
                  <ChevronRight
                    className="sidebar-recent-disclosure-icon"
                    size={13}
                  />
                )}
              </button>
              <button
                type="button"
                className="sidebar-recent-new-chat"
                title={t("navigation.projectDialog.createTitle")}
                aria-label={t("navigation.projectDialog.createTitle")}
                onClick={(e) => {
                  e.stopPropagation();
                  setProjectError("");
                  setProjectDialog({ mode: "create" });
                }}
                tabIndex={expanded ? 0 : -1}
              >
                <Plus size={13} />
              </button>
            </div>
            <div
              className={`sidebar-recent-collapse ${
                projectsOpen ? "expanded" : ""
              }`}
            >
              <div className="sidebar-recent-collapse-inner">
                {sortedProjectGroups.map((group) => {
                  const projectOpen = !closedProjectFolders.has(group.path);
                  const visible = expanded && projectsOpen && projectOpen;
                  // The agent-side project record for this group, when the
                  // project list has loaded (issue #27) — enables edit/delete.
                  const projectRecord = projects?.find(
                    (p) =>
                      p.folders.some((f) => f.path === group.path) ||
                      p.primaryPath === group.path,
                  );
                  return (
                    <div className="sidebar-recent-project" key={group.path}>
                      <div className="sidebar-recent-project-row">
                        <button
                          type="button"
                          className="sidebar-recent-project-heading"
                          title={group.path}
                          onClick={() => toggleProjectFolder(group.path)}
                          aria-expanded={projectOpen}
                          tabIndex={expanded && projectsOpen ? 0 : -1}
                        >
                          <Folder size={13} />
                          <span>{displayName(group.path)}</span>
                        </button>
                        {projectRecord && (
                          <>
                            <button
                              type="button"
                              className="sidebar-recent-new-chat"
                              title={t("navigation.projectDialog.editTitle")}
                              aria-label={t(
                                "navigation.projectDialog.editTitle",
                              )}
                              onClick={(e) => {
                                e.stopPropagation();
                                setProjectError("");
                                setProjectDialog({
                                  mode: "edit",
                                  project: projectRecord,
                                });
                              }}
                              tabIndex={expanded && projectsOpen ? 0 : -1}
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              type="button"
                              className="sidebar-recent-new-chat"
                              title={t("navigation.projectDialog.deleteTitle")}
                              aria-label={t(
                                "navigation.projectDialog.deleteTitle",
                              )}
                              onClick={(e) => {
                                e.stopPropagation();
                                setProjectError("");
                                setPendingDeleteProject(projectRecord);
                              }}
                              tabIndex={expanded && projectsOpen ? 0 : -1}
                            >
                              <Trash size={12} />
                            </button>
                          </>
                        )}
                        {onNewChatInProject && (
                          <button
                            type="button"
                            className="sidebar-recent-new-chat"
                            title={t("navigation.newChatInProject", {
                              project: displayName(group.path),
                            })}
                            aria-label={t("navigation.newChatInProject", {
                              project: displayName(group.path),
                            })}
                            onClick={(e) => {
                              e.stopPropagation();
                              onNewChatInProject(group.path);
                            }}
                            tabIndex={expanded && projectsOpen ? 0 : -1}
                          >
                            <Plus size={13} />
                          </button>
                        )}
                        <button
                          type="button"
                          className="sidebar-recent-new-chat"
                          title={t("navigation.archiveProjectTooltip", {
                            project: displayName(group.path),
                          })}
                          aria-label={t("navigation.archiveProjectTooltip", {
                            project: displayName(group.path),
                          })}
                          onClick={(e) => {
                            e.stopPropagation();
                            openArchive(
                              { kind: "project", folder: group.path },
                              displayName(group.path),
                            );
                          }}
                          tabIndex={expanded && projectsOpen ? 0 : -1}
                        >
                          <ArchiveBox size={12} />
                        </button>
                      </div>
                      <div
                        className={`sidebar-recent-collapse ${
                          projectOpen ? "expanded" : ""
                        }`}
                      >
                        <div className="sidebar-recent-collapse-inner">
                          {group.sessions.length > 0 ? (
                            group.sessions.map((s) =>
                              renderSessionButton(s, true, visible),
                            )
                          ) : (
                            <div className="sidebar-recent-empty">
                              {t("navigation.projectDialog.noSessions")}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
        <div className="sidebar-recent-section">
          <div className="sidebar-recent-section-row">
            <button
              type="button"
              className="sidebar-recent-section-toggle"
              onClick={toggleChats}
              aria-expanded={chatsOpen}
              tabIndex={expanded ? 0 : -1}
            >
              <span>{t("navigation.chats")}</span>
              {chatsOpen ? (
                <ChevronDown
                  className="sidebar-recent-disclosure-icon"
                  size={13}
                />
              ) : (
                <ChevronRight
                  className="sidebar-recent-disclosure-icon"
                  size={13}
                />
              )}
            </button>
            {onNewChatInProject && (
              <button
                type="button"
                className="sidebar-recent-new-chat"
                title={t("navigation.newChat")}
                aria-label={t("navigation.newChat")}
                onClick={(e) => {
                  e.stopPropagation();
                  onNewChatInProject(null);
                }}
                tabIndex={expanded ? 0 : -1}
              >
                <Plus size={13} />
              </button>
            )}
            <button
              type="button"
              className="sidebar-recent-new-chat"
              title={t("navigation.archiveSection")}
              aria-label={t("navigation.archiveSection")}
              onClick={(e) => {
                e.stopPropagation();
                openArchive({ kind: "unbound" });
              }}
              tabIndex={expanded ? 0 : -1}
            >
              <ArchiveBox size={13} />
            </button>
          </div>
          <div
            className={`sidebar-recent-collapse ${chatsOpen ? "expanded" : ""}`}
          >
            <div className="sidebar-recent-collapse-inner">
              {chats.length > 0 ? (
                chats.map((s) =>
                  renderSessionButton(s, false, expanded && chatsOpen),
                )
              ) : (
                <div className="sidebar-recent-empty">
                  {t("navigation.noChats")}
                </div>
              )}
            </div>
          </div>
        </div>
        {loadingMore && (
          <div className="sidebar-recent-loading" aria-live="polite">
            <Loader
              className="sidebar-recent-session-dot sidebar-recent-session-dot--loading"
              size={11}
            />
            <span>{t("common.loadingShort")}</span>
          </div>
        )}
      </div>
      {expanded && menuTarget && (
        <SidebarSessionMenu
          target={menuTarget}
          isPinned={pinnedIds.has(menuTarget.id)}
          projects={projectChoices}
          scrollContainer={scrollRootRef.current}
          onClose={() => setMenuTarget(null)}
          onTogglePin={() => handleTogglePin(menuTarget.id)}
          onRename={() => {
            const s = sessions.find((row) => row.id === menuTarget.id);
            if (s) startRename(s);
          }}
          onCopySessionId={(sessionId) => {
            void window.hermesAPI
              .copyToClipboard(sessionId)
              .catch(() => undefined);
          }}
          onMoveToProject={(path) =>
            void handleMoveToProject(menuTarget.id, path)
          }
          onArchive={() => void handleArchive(menuTarget.id)}
          onDelete={() => setPendingDeleteId(menuTarget.id)}
        />
      )}
      {pendingDeleteId &&
        createPortal(
          <div
            className="sidebar-session-delete-overlay"
            role="presentation"
            onClick={() => {
              if (!deleting) {
                setPendingDeleteId(null);
                setPendingDeleteIsArchived(false);
              }
            }}
          >
            <div
              className="sidebar-session-delete-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="sidebar-session-delete-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sidebar-session-delete-header">
                <h3 id="sidebar-session-delete-title">
                  {t("navigation.sessionMenu.deleteConfirmTitle")}
                </h3>
                <button
                  type="button"
                  className="btn-ghost sidebar-session-delete-close"
                  onClick={() => {
                    setPendingDeleteId(null);
                    setPendingDeleteIsArchived(false);
                  }}
                  disabled={deleting}
                  aria-label={t("navigation.sessionMenu.deleteCancel")}
                >
                  <X size={16} />
                </button>
              </div>
              <p className="sidebar-session-delete-body">
                {t("navigation.sessionMenu.deleteConfirm")}
              </p>
              <div className="sidebar-session-delete-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setPendingDeleteId(null);
                    setPendingDeleteIsArchived(false);
                  }}
                  disabled={deleting}
                >
                  {t("navigation.sessionMenu.deleteCancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    // The shared confirm dialog serves both surfaces; the flag
                    // says it was opened FROM the archive modal (whose list is
                    // refreshed by the modal itself, not by the main refresh).
                    if (pendingDeleteIsArchived) {
                      void (async () => {
                        setDeleting(true);
                        try {
                          await window.hermesAPI.deleteSession(
                            pendingDeleteId,
                            connectionId,
                            activeProfile,
                          );
                          // The archive modal keeps its own list state; the
                          // shared confirm dialog lives in the parent, so the
                          // modal never learns the row is gone. Bump its key
                          // to remount it with a fresh list (issue #64).
                          setArchiveDialogNonce((n) => n + 1);
                        } catch (err) {
                          console.error(
                            "Failed to delete archived session",
                            pendingDeleteId,
                            err,
                          );
                        } finally {
                          setDeleting(false);
                          setPendingDeleteId(null);
                          setPendingDeleteIsArchived(false);
                        }
                      })();
                    } else {
                      void confirmDelete(pendingDeleteId);
                    }
                  }}
                  disabled={deleting}
                >
                  {deleting
                    ? t("navigation.sessionMenu.deleting")
                    : t("navigation.sessionMenu.deleteConfirmAction")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
      {archiveDialogOpen &&
        createPortal(
          <ArchiveDialog
            key={archiveDialogNonce}
            connectionId={connectionId}
            activeProfile={activeProfile}
            filter={archiveFilter}
            projectName={archiveProjectName}
            onRestored={() => void refresh(true)}
            onOpen={(sessionId) => onSelect(sessionId)}
            onDeleteRequest={(sessionId) => {
              setPendingDeleteIsArchived(true);
              setPendingDeleteId(sessionId);
            }}
            onClose={() => setArchiveDialogOpen(false)}
          />,
          document.body,
        )}
      {projectDialog &&
        createPortal(
          <ProjectDialog
            state={projectDialog}
            connectionMode={connectionMode}
            connectionId={connectionId}
            activeProfile={activeProfile}
            onClose={() => setProjectDialog(null)}
            onMutate={handleProjectMutate}
            onChanged={handleProjectChanged}
            existingProjects={projects ?? undefined}
          />,
          document.body,
        )}
      {pendingDeleteProject &&
        createPortal(
          <div
            className="sidebar-session-delete-overlay"
            role="presentation"
            onClick={() => {
              if (!deletingProject) setPendingDeleteProject(null);
            }}
          >
            <div
              className="sidebar-session-delete-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="sidebar-project-delete-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sidebar-session-delete-header">
                <h3 id="sidebar-project-delete-title">
                  {t("navigation.projectDialog.deleteTitle")}
                </h3>
                <button
                  type="button"
                  className="btn-ghost sidebar-session-delete-close"
                  onClick={() => setPendingDeleteProject(null)}
                  disabled={deletingProject}
                  aria-label={t("navigation.sessionMenu.deleteCancel")}
                >
                  <X size={16} />
                </button>
              </div>
              <p className="sidebar-session-delete-body">
                {t("navigation.projectDialog.deleteConfirm", {
                  project: pendingDeleteProject.name,
                })}
              </p>
              {projectError && (
                <div className="sidebar-project-dialog-error">
                  {projectError}
                </div>
              )}
              <div className="sidebar-session-delete-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setPendingDeleteProject(null)}
                  disabled={deletingProject}
                >
                  {t("navigation.sessionMenu.deleteCancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void confirmDeleteProject()}
                  disabled={deletingProject}
                >
                  {deletingProject
                    ? t("navigation.sessionMenu.deleting")
                    : t("navigation.sessionMenu.deleteConfirmAction")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
});

export default SidebarRecentSessions;
