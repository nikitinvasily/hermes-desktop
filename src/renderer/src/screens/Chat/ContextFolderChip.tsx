import { memo, useState, useEffect, useRef } from "react";
import { FolderOpen, FolderTree, X, Check } from "lucide-react";
import { useI18n } from "../../components/useI18n";
import type { ProjectInfo } from "../../../../shared/projects";

interface ContextFolderChipProps {
  /** Working folder bound to this conversation (issue #27), or null. */
  contextFolder: string | null;
  /** Hidden in remote/SSH mode, where the picker browses the wrong machine. */
  show: boolean;
  worktreeVisible: boolean;
  /** Active connection id + profile, for listProjects (issue #29). */
  connectionId: string;
  profile?: string;
  onClearFolder: () => void;
  onToggleWorktree: () => void;
  onSelectFolder: (path: string) => void;
}

/** Last path segment, for the compact chip label (handles \ and /). */
function folderName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** Normalize separators so a project folder matches the session cwd. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/**
 * Context-folder control rendered as a chip in the input footer, next to the
 * model picker (both share the `.chat-meta-chip` style). When clicked, opens a
 * dropdown popup listing projects (issue #29): picking a project binds its
 * primary folder as the session cwd. Only existing projects are offered.
 */
export const ContextFolderChip = memo(function ContextFolderChip({
  contextFolder,
  show,
  worktreeVisible,
  connectionId,
  profile,
  onClearFolder,
  onToggleWorktree,
  onSelectFolder,
}: ContextFolderChipProps): React.JSX.Element | null {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setProjects(null);
    void window.hermesAPI
      .listProjects(connectionId, profile)
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setProjects(list);
      })
      .catch(() => {
        /* leave null — the section stays hidden */
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, connectionId, profile]);

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(e: MouseEvent): void {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.stopPropagation();
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isOpen]);

  if (!show) return null;

  const renderDropdown = (): React.JSX.Element => (
    <div className="chat-ctxfolder-dropdown">
      {projects !== null && projects.length > 0 && (
        <>
          <div className="chat-ctxfolder-dropdown-header">Projects</div>
          <div className="chat-ctxfolder-dropdown-list">
            {projects.map((project) => {
              const primary = project.primaryPath;
              const isSelected = Boolean(
                primary &&
                contextFolder &&
                (samePath(primary, contextFolder) ||
                  project.folders?.some((f) =>
                    samePath(f.path, contextFolder),
                  )),
              );
              return (
                <button
                  key={project.id}
                  type="button"
                  disabled={!primary}
                  className={`chat-ctxfolder-dropdown-item${
                    isSelected ? " chat-ctxfolder-dropdown-item--active" : ""
                  }`}
                  onClick={() => {
                    if (!primary) return;
                    onSelectFolder(primary);
                    setIsOpen(false);
                  }}
                  title={primary ?? t("chat.projectNoFolder")}
                >
                  <span className="chat-ctxfolder-dropdown-item-name">
                    {project.name}
                  </span>
                  {primary && (
                    <span
                      className="chat-ctxfolder-dropdown-item-path"
                      title={primary}
                    >
                      {folderName(primary)}
                    </span>
                  )}
                  {isSelected && (
                    <Check
                      size={14}
                      className="chat-ctxfolder-dropdown-item-check"
                    />
                  )}
                </button>
              );
            })}
          </div>
          <div className="chat-ctxfolder-dropdown-divider" />
        </>
      )}
    </div>
  );

  if (!contextFolder) {
    return (
      <div className="chat-ctxfolder-picker" ref={containerRef}>
        <button
          className="chat-meta-chip"
          onClick={() => setIsOpen((v) => !v)}
          title={t("chat.setContextFolder")}
          type="button"
        >
          <FolderOpen size={13} />
          <span>{t("chat.contextFolderChip")}</span>
        </button>
        {isOpen && renderDropdown()}
      </div>
    );
  }

  return (
    <div className="chat-ctxfolder-group" ref={containerRef}>
      <button
        className="chat-meta-chip chat-meta-chip--active"
        onClick={() => setIsOpen((v) => !v)}
        title={t("chat.contextFolderActive", { path: contextFolder })}
        type="button"
      >
        <FolderOpen size={13} />
        <span className="chat-ctxfolder-name">{folderName(contextFolder)}</span>
      </button>
      <button
        className="chat-meta-chip-icon"
        onClick={onClearFolder}
        title={t("chat.removeContextFolder")}
        type="button"
      >
        <X size={11} />
      </button>
      <button
        className={`chat-meta-chip-icon${
          worktreeVisible ? " chat-meta-chip-icon--active" : ""
        }`}
        onClick={onToggleWorktree}
        title={
          worktreeVisible ? t("chat.hideWorktree") : t("chat.showWorktree")
        }
        type="button"
      >
        <FolderTree size={13} />
      </button>
      {isOpen && renderDropdown()}
    </div>
  );
});
