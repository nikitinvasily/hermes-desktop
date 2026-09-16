import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../components/useI18n";
import { Folder, X } from "../../assets/icons";

/**
 * Agent-side folder picker for the session menu's "New folder…" entry
 * (issue #37): in remote/ssh connection modes the native macOS picker would
 * return a LOCAL path that is meaningless on the agent host, so the choice
 * happens through the same read-directory browser the project dialog uses.
 * Starts at the agent's workspace dir, falling back to its home. When the
 * transport has no FS channel (HTTP-remote → null), the dialog shows the
 * single "browsing unavailable" hint instead of a dead picker.
 */
function FolderPickerDialog({
  connectionId,
  activeProfile,
  onClose,
  onPick,
}: {
  connectionId?: string;
  activeProfile?: string;
  onClose: () => void;
  onPick: (path: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
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

  // Open at the agent's workspace when it exists, else at its home — mirrors
  // the project dialog's starting point (projects live in the workspace).
  useEffect(() => {
    void (async () => {
      const base =
        activeProfile && activeProfile !== "default"
          ? `~/.hermes/profiles/${activeProfile}/workspace`
          : "~/.hermes/workspace";
      const entries = await window.hermesAPI
        .readDirectory(base)
        .catch(() => null);
      void loadBrowse(entries ? base : "~");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only
  }, []);

  const choose = async (): Promise<void> => {
    // Store the path the way the AGENT sees it (expanded `~`), mirroring the
    // project dialog's addFolder; on failure keep the user's spelling.
    let resolved = browsePath;
    try {
      resolved = await window.hermesAPI.resolvePath(browsePath, connectionId);
    } catch {
      /* keep the user's spelling */
    }
    onPick(resolved);
  };

  return createPortal(
    <div
      className="sidebar-session-delete-overlay"
      role="presentation"
      onClick={() => {
        if (!browseLoading) onClose();
      }}
    >
      <div
        className="sidebar-project-dialog sidebar-folder-picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sidebar-folder-picker-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sidebar-session-delete-header">
          <h3 id="sidebar-folder-picker-title">
            {t("navigation.sessionMenu.newProjectFolder")}
          </h3>
          <button
            type="button"
            className="btn-ghost sidebar-session-delete-close"
            onClick={onClose}
            aria-label={t("navigation.sessionMenu.deleteCancel")}
          >
            <X size={16} />
          </button>
        </div>
        <div className="sidebar-project-dialog-browser">
          {!browseFailed ? (
            <>
              <div className="sidebar-project-dialog-browser-bar">
                <button
                  type="button"
                  className="sidebar-project-dialog-folder-action"
                  disabled={browseLoading || browsePath === "/"}
                  onClick={() =>
                    void loadBrowse(browsePath.replace(/[^/]+\/?$/, "") || "/")
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
                  disabled={browseLoading}
                  onClick={() => void choose()}
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
          ) : (
            <div className="sidebar-project-dialog-hint">
              {t("navigation.projectDialog.browseUnavailable")}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default FolderPickerDialog;
