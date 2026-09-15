import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../components/useI18n";
import { Folder, Plus, X } from "../../assets/icons";
import type {
  ProjectFolderInfo,
  ProjectInfo,
  ProjectMutation,
} from "../../../../shared/projects";

/**
 * Create/edit-project dialog for the sidebar's Projects section (issue #27).
 *
 * One component, two modes:
 *  - `create`: name + folder chips; submit runs the `create` project mutation.
 *  - `edit`: rename + folder management (add/remove/set primary), each an
 *    immediate mutation (the backend applies them one at a time, so partial
 *    progress is visible and a failure surfaces without losing the rest).
 *
 * Folder selection depends on the connection mode: a local agent gets the
 * native directory picker (defaultPath ~/Documents); remote/ssh agents need a
 * path on THEIR filesystem, so the picker would lie — a text input instead.
 */

export interface ProjectDialogFolder {
  path: string;
  isPrimary: boolean;
}

export interface ProjectDialogState {
  mode: "create" | "edit";
  /** Edit mode: the project being edited. */
  project?: ProjectInfo;
}

interface ProjectDialogProps {
  state: ProjectDialogState;
  /** "local" → native picker; anything else → text input. */
  connectionMode: "local" | "remote" | "ssh";
  onClose: () => void;
  /** Run a mutation; resolves on success, throws with the backend error. */
  onMutate: (mutation: ProjectMutation) => Promise<unknown>;
  /** Called after any successful mutation so the sidebar refreshes. */
  onChanged: () => void;
  /** All known projects — used to warn when a folder already belongs to one
   * (the backend only refuses duplicate PRIMARY folders, so a folder can
   * silently join two projects; surface that before submit). */
  existingProjects?: ProjectInfo[];
}

export default function ProjectDialog({
  state,
  connectionMode,
  onClose,
  onMutate,
  onChanged,
  existingProjects,
}: ProjectDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const isEdit = state.mode === "edit";
  const project = state.project;

  const [name, setName] = useState(isEdit ? (project?.name ?? "") : "");
  const [folders, setFolders] = useState<ProjectDialogFolder[]>(
    isEdit
      ? (project?.folders ?? []).map((f: ProjectFolderInfo) => ({
          path: f.path,
          isPrimary: f.isPrimary,
        }))
      : [],
  );
  const [manualPath, setManualPath] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Remote/ssh folder browser state (issue #27 follow-up): the agent host's
  // directories, read through the existing read-directory IPC (ssh exec or
  // local readdir; HTTP-remote returns null → falls back to manual input).
  const [browsePath, setBrowsePath] = useState("~");
  const [browseEntries, setBrowseEntries] = useState<
    { name: string; isDirectory: boolean }[] | null
  >(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseFailed, setBrowseFailed] = useState(false);

  const loadBrowse = useCallback(async (path: string): Promise<void> => {
    setBrowseLoading(true);
    setBrowseFailed(false);
    try {
      const entries = await window.hermesAPI.readDirectory(path);
      if (!entries) {
        setBrowseFailed(true);
        setBrowseEntries(null);
        return;
      }
      setBrowsePath(path);
      setBrowseEntries(entries.filter((e) => e.isDirectory));
    } catch {
      setBrowseFailed(true);
      setBrowseEntries(null);
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  // Open the browser at the agent's home on first render in remote modes.
  useEffect(() => {
    if (connectionMode !== "local") void loadBrowse("~");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- initial load only

  useEffect(() => {
    nameRef.current?.focus();
    if (state.mode === "create") nameRef.current?.select();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- focus once per open

  const primary = folders.find((f) => f.isPrimary) ?? folders[0] ?? null;

  // The backend refuses only duplicate PRIMARY folders; a folder can still
  // belong to another project as a secondary one. Warn before submit so the
  // user knowingly shares (or re-picks) the folder.
  const conflictingFolder = useMemo(() => {
    const owner = new Map<string, string>();
    for (const p of existingProjects ?? []) {
      if (isEdit && p.id === project?.id) continue;
      for (const f of p.folders) {
        if (f.path) owner.set(f.path, p.name);
      }
    }
    if (owner.size === 0) return null;
    const hit = folders.find((f) => owner.has(f.path));
    return hit ? { path: hit.path, project: owner.get(hit.path) ?? "" } : null;
  }, [existingProjects, folders, isEdit, project?.id]);

  function addFolder(path: string): void {
    const trimmed = path.trim();
    if (!trimmed) return;
    if (folders.some((f) => f.path === trimmed)) {
      setError(t("navigation.projectDialog.folderDuplicate"));
      return;
    }
    setError("");
    setFolders((prev) => [
      ...prev,
      { path: trimmed, isPrimary: prev.length === 0 },
    ]);
    setManualPath("");
  }

  async function handlePickFolder(): Promise<void> {
    try {
      const folder = await window.hermesAPI.selectFolder();
      if (folder) addFolder(folder);
    } catch {
      /* picker cancelled or unavailable */
    }
  }

  function removeFolder(path: string): void {
    setError("");
    setFolders((prev) => {
      const next = prev.filter((f) => f.path !== path);
      // Keep exactly one primary: if the removed one was primary, the first
      // remaining folder takes over (mirrors create_project's rule).
      if (next.length > 0 && !next.some((f) => f.isPrimary)) {
        next[0] = { ...next[0], isPrimary: true };
      }
      return next;
    });
  }

  function makePrimary(path: string): void {
    setFolders((prev) =>
      prev.map((f) => ({ ...f, isPrimary: f.path === path })),
    );
  }

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (state.mode === "create" && folders.length === 0) {
      setError(t("navigation.projectDialog.folderRequired"));
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      if (state.mode === "create") {
        await onMutate({
          op: "create",
          name: trimmed,
          folders: folders.map((f) => f.path),
          primaryPath: primary?.path,
        });
      } else if (project) {
        if (trimmed !== project.name)
          await onMutate({ op: "update", id: project.id, name: trimmed });
        // Folder diff: adds, removals, and primary moves as separate mutations.
        const before = new Map(
          project.folders.map((f) => [f.path, f.isPrimary]),
        );
        const after = new Map(folders.map((f) => [f.path, f.isPrimary]));
        for (const f of folders) {
          if (!before.has(f.path))
            await onMutate({ op: "add_folder", id: project.id, path: f.path });
        }
        for (const f of project.folders) {
          if (!after.has(f.path))
            await onMutate({
              op: "remove_folder",
              id: project.id,
              path: f.path,
            });
        }
        const newPrimary = folders.find((f) => f.isPrimary)?.path;
        if (newPrimary && before.get(newPrimary) !== true)
          await onMutate({
            op: "set_primary",
            id: project.id,
            path: newPrimary,
          });
      }
      onChanged();
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("navigation.projectDialog.operationFailed"),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      className="sidebar-session-delete-overlay"
      role="presentation"
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      <div
        className="sidebar-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sidebar-project-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sidebar-session-delete-header">
          <h3 id="sidebar-project-dialog-title">
            {t(
              isEdit
                ? "navigation.projectDialog.editTitle"
                : "navigation.projectDialog.createTitle",
            )}
          </h3>
          <button
            type="button"
            className="btn-ghost sidebar-session-delete-close"
            onClick={onClose}
            disabled={submitting}
            aria-label={t("navigation.sessionMenu.deleteCancel")}
          >
            <X size={16} />
          </button>
        </div>

        <label
          className="sidebar-project-dialog-label"
          htmlFor="sidebar-project-dialog-name"
        >
          {t("navigation.projectDialog.nameLabel")}
        </label>
        <input
          id="sidebar-project-dialog-name"
          ref={nameRef}
          className="sidebar-project-dialog-input"
          type="text"
          value={name}
          disabled={submitting}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />

        <div className="sidebar-project-dialog-label">
          {t("navigation.projectDialog.foldersLabel")}
        </div>
        {folders.length === 0 && (
          <div className="sidebar-project-dialog-empty">
            {t("navigation.projectDialog.foldersEmpty")}
          </div>
        )}
        <div className="sidebar-project-dialog-folders">
          {folders.map((f) => (
            <div className="sidebar-project-dialog-folder" key={f.path}>
              <Folder size={13} />
              <span
                className="sidebar-project-dialog-folder-path"
                title={f.path}
              >
                {f.path}
              </span>
              {f.isPrimary ? (
                <span className="sidebar-project-dialog-primary-badge">
                  {t("navigation.projectDialog.primaryBadge")}
                </span>
              ) : (
                <button
                  type="button"
                  className="sidebar-project-dialog-folder-action"
                  disabled={submitting}
                  onClick={() => makePrimary(f.path)}
                  title={t("navigation.projectDialog.makePrimary")}
                >
                  {t("navigation.projectDialog.makePrimary")}
                </button>
              )}
              <button
                type="button"
                className="sidebar-project-dialog-folder-action"
                disabled={submitting}
                onClick={() => removeFolder(f.path)}
                aria-label={t("navigation.projectDialog.removeFolder")}
                title={t("navigation.projectDialog.removeFolder")}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>

        {connectionMode === "local" ? (
          <button
            type="button"
            className="btn btn-secondary sidebar-project-dialog-add"
            disabled={submitting}
            onClick={() => void handlePickFolder()}
          >
            <Plus size={13} />
            {t("navigation.projectDialog.addFolder")}
          </button>
        ) : (
          <div className="sidebar-project-dialog-browser">
            {!browseFailed && (
              <>
                <div className="sidebar-project-dialog-browser-bar">
                  <button
                    type="button"
                    className="sidebar-project-dialog-folder-action"
                    disabled={submitting || browseLoading || browsePath === "/"}
                    onClick={() =>
                      void loadBrowse(
                        browsePath.replace(/[^/]+\/?$/, "") || "/",
                      )
                    }
                    title={t("navigation.projectDialog.browseUp")}
                    aria-label={t("navigation.projectDialog.browseUp")}
                  >
                    ↑
                  </button>
                  <span
                    className="sidebar-project-dialog-browser-path"
                    title={browsePath}
                  >
                    {browsePath}
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary sidebar-project-dialog-browser-add"
                    disabled={submitting || browseLoading}
                    onClick={() => addFolder(browsePath)}
                  >
                    {t("navigation.projectDialog.addCurrent")}
                  </button>
                </div>
                <div className="sidebar-project-dialog-browser-list">
                  {browseLoading ? (
                    <div className="sidebar-project-dialog-empty">
                      {t("common.loadingShort")}
                    </div>
                  ) : (
                    (browseEntries ?? []).map((entry) => (
                      <button
                        type="button"
                        key={entry.name}
                        className="sidebar-project-dialog-browser-entry"
                        disabled={submitting}
                        onClick={() =>
                          void loadBrowse(
                            `${browsePath.replace(/\/$/, "")}/${entry.name}`,
                          )
                        }
                      >
                        <Folder size={12} />
                        <span>{entry.name}</span>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
            <div className="sidebar-project-dialog-manual">
              <input
                className="sidebar-project-dialog-input"
                type="text"
                placeholder={t("navigation.projectDialog.pathPlaceholder")}
                value={manualPath}
                disabled={submitting}
                onChange={(e) => setManualPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addFolder(manualPath);
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                disabled={submitting || !manualPath.trim()}
                onClick={() => addFolder(manualPath)}
              >
                {t("navigation.projectDialog.addFolder")}
              </button>
            </div>
            <div className="sidebar-project-dialog-hint">
              {browseFailed
                ? t("navigation.projectDialog.browseUnavailable")
                : t("navigation.projectDialog.remoteHint")}
            </div>
          </div>
        )}

        {error && <div className="sidebar-project-dialog-error">{error}</div>}

        {conflictingFolder && !error && (
          <div
            className="sidebar-project-dialog-hint sidebar-project-dialog-warning"
            role="status"
          >
            {t("navigation.projectDialog.folderConflict", {
              project: conflictingFolder.project,
            })}
          </div>
        )}

        <div className="sidebar-session-delete-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={submitting}
          >
            {t("navigation.sessionMenu.deleteCancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={
              submitting || !name.trim() || (!isEdit && folders.length === 0)
            }
            onClick={() => void submit()}
          >
            {submitting
              ? t("navigation.projectDialog.saving")
              : t(
                  isEdit
                    ? "navigation.projectDialog.saveAction"
                    : "navigation.projectDialog.createAction",
                )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
