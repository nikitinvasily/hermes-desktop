import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../components/useI18n";
import { ArchiveBox, ArchiveRestore, Trash, X } from "../../assets/icons";

export interface ArchivedSession {
  id: string;
  title: string | null;
  startedAt: number;
  /** Sidebar grouping folder (issue #64); null/undefined = unbound (Chats). */
  contextFolder?: string | null;
}

/**
 * Which archived chats the dialog shows (issue #64): all of them, only one
 * project's, or only the unbound ones (what the Chats-section icon means).
 */
export type ArchiveFilter =
  | { kind: "all" }
  | { kind: "project"; folder: string }
  | { kind: "unbound" };

/**
 * Modal listing the current connection's archived chats (issue #34). Opened
 * from the Archive button in the sidebar's Chats header, or with a project
 * filter from a project row's archive icon (issue #64). The row itself is
 * display-only (user decision, 2026-09-18): restoring happens ONLY through
 * the hover icon, which restores the chat AND opens it as the active chat
 * (then the dialog closes). Delete goes through the shared confirmation
 * dialog.
 */
function ArchiveDialog({
  connectionId,
  activeProfile,
  filter = { kind: "all" },
  projectName,
  onRestored,
  onOpen,
  onDeleteRequest,
  onClose,
}: {
  /** Stable connection registry id used to route every session operation. */
  connectionId: string;
  /** Active profile — the archived list is per-profile. */
  activeProfile: string;
  /** Restrict the list: all chats, one project's chats, or unbound only. */
  filter?: ArchiveFilter;
  /** Display name for the project heading when filtering by a project. */
  projectName?: string;
  /** Notify the parent after a successful restore so it refreshes the list. */
  onRestored: () => void;
  /** Open the restored session as the active chat (Restore icon click). */
  onOpen: (sessionId: string) => void;
  /** Surface deletion through the parent's shared confirmation dialog. */
  onDeleteRequest: (sessionId: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<ArchivedSession[] | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const closeRef = useRef<HTMLButtonElement>(null);

  // Load on open; connection/profile changes are impossible while open (the
  // dialog is modal), so a single effect keyed on the mount suffices.
  useEffect(() => {
    let cancelled = false;
    setSessions(null);
    void window.hermesAPI
      .listArchivedSessions(200, 0, connectionId, activeProfile)
      .then((list) => {
        if (!cancelled) setSessions(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, activeProfile]);

  // Project-scoped / unbound views (issue #64) are a client-side filter of the
  // loaded list — the folder semantics are computed main-side, the dialog only
  // selects rows. Note the remote path clamps the fetch to 100 rows, so a very
  // large archive's tail may fall outside a filtered view.
  const visible =
    sessions === null
      ? null
      : filter.kind === "project"
        ? sessions.filter((s) => (s.contextFolder ?? null) === filter.folder)
        : filter.kind === "unbound"
          ? sessions.filter((s) => !(s.contextFolder ?? null))
          : sessions;

  // Focus the close button so Escape has an obvious target; the overlay
  // itself handles Escape below.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const withBusy = (id: string, fn: () => Promise<void>): void => {
    setBusyIds((prev) => new Set(prev).add(id));
    void fn().finally(() => {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    });
  };

  const restoreAndOpen = (id: string): void => {
    withBusy(id, async () => {
      await window.hermesAPI.setSessionArchived(
        id,
        false,
        connectionId,
        activeProfile,
      );
      onRestored();
      onOpen(id);
      onClose();
    });
  };

  return createPortal(
    <div
      className="sidebar-session-delete-overlay"
      role="presentation"
      onClick={() => onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        className="sidebar-project-dialog archive-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sidebar-session-delete-header">
          <h3 id="archive-dialog-title">
            {filter.kind === "project"
              ? t("navigation.archiveProjectTitle", {
                  project: projectName || filter.folder,
                })
              : filter.kind === "unbound"
                ? t("navigation.archiveUnboundTitle")
                : t("navigation.archiveSection")}
          </h3>
          <button
            ref={closeRef}
            type="button"
            className="btn-ghost sidebar-session-delete-close"
            onClick={() => onClose()}
            aria-label={t("navigation.sessionMenu.deleteCancel")}
          >
            <X size={16} />
          </button>
        </div>
        {visible === null ? (
          <div className="sidebar-recent-empty">{t("common.loadingShort")}</div>
        ) : visible.length === 0 ? (
          <div className="sidebar-recent-empty">
            {t("navigation.archiveEmpty")}
          </div>
        ) : (
          <div className="archive-dialog-list">
            {visible.map((s) => {
              const busy = busyIds.has(s.id);
              return (
                <div
                  key={s.id}
                  className="archive-dialog-row"
                  title={s.title || t("sessions.newConversation")}
                >
                  <ArchiveBox size={13} className="archive-dialog-row-icon" />
                  <span className="archive-dialog-row-title">
                    {s.title || t("sessions.newConversation")}
                  </span>
                  <span className="archive-dialog-row-date">
                    {formatArchiveDate(s.startedAt)}
                  </span>
                  <div className="archive-dialog-row-actions">
                    <button
                      type="button"
                      className="sidebar-recent-session-options"
                      disabled={busy}
                      aria-label={t("navigation.archiveRestore")}
                      title={t("navigation.archiveRestore")}
                      onClick={(e) => {
                        e.stopPropagation();
                        restoreAndOpen(s.id);
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <ArchiveRestore size={15} />
                    </button>
                    <button
                      type="button"
                      className="sidebar-recent-session-options"
                      disabled={busy}
                      aria-label={t("navigation.sessionMenu.delete")}
                      title={t("navigation.sessionMenu.delete")}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteRequest(s.id);
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <Trash size={15} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Compact locale date for the archived row (e.g. "Sep 16"). */
function formatArchiveDate(startedAt: number): string {
  const date = new Date(startedAt * 1000);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
}

export default ArchiveDialog;
