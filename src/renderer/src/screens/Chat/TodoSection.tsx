import { ChevronDown, ChevronRight } from "../../assets/icons";
import { useI18n } from "../../components/useI18n";
import type { TodoSnapshot } from "./todoState";

/** Status marker for one todo item (matches the agent tool's statuses). */
const TODO_MARKERS: Record<string, string> = {
  completed: "✓",
  in_progress: "▶",
  pending: "○",
  cancelled: "⊘",
};

/**
 * The TODO section of the floating chat context panel (issue #126). Shows the
 * chat's live task list with per-item status markers and a done/total counter
 * in the header. Hidden while there is no snapshot or nothing left open, so
 * finished todo lists do not keep the panel alive.
 */
export function TodoSection({
  snapshot,
  open,
  onToggle,
}: {
  snapshot: TodoSnapshot | null;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  if (!snapshot || snapshot.items.length === 0) return null;
  const openCount = snapshot.items.filter(
    (i) => i.status === "pending" || i.status === "in_progress",
  ).length;
  if (openCount === 0) return null;
  const done = snapshot.items.length - openCount;

  return (
    <div className="sidebar-recent-section">
      <button
        type="button"
        className="sidebar-recent-section-toggle chat-context-panel-toggle"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span>{t("navigation.todoTasklist")}</span>
        <span className="chat-context-panel-counter">
          {done}/{snapshot.items.length}
        </span>
        {open ? (
          <ChevronDown className="sidebar-recent-disclosure-icon" size={13} />
        ) : (
          <ChevronRight className="sidebar-recent-disclosure-icon" size={13} />
        )}
      </button>
      <div className={`sidebar-recent-collapse ${open ? "expanded" : ""}`}>
        <div className="sidebar-recent-collapse-inner">
          {snapshot.items.map((item) => (
            <div
              key={item.id}
              className={`chat-context-panel-todo chat-context-panel-todo--${item.status}`}
              title={item.content}
            >
              <span className="chat-context-panel-todo-marker" aria-hidden>
                {TODO_MARKERS[item.status] ?? "○"}
              </span>
              <span className="chat-context-panel-row-title">
                {item.content}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
