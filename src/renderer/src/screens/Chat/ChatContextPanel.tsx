import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "../../assets/icons";
import { useI18n } from "../../components/useI18n";
import { TodoSection } from "./TodoSection";
import type { TodoSnapshot } from "./todoState";

/** A delegate-subagent child run listed by the panel (issue #122). */
export interface SubagentRow {
  id: string;
  startedAt: number;
  endedAt: number | null;
  /** Delegation goal: the child's first user message, single-line clamped. */
  title: string;
  model: string | null;
  messageCount: number;
  /** Dead-but-never-ended child (killed with a gateway restart, issue #128):
   * show a settled dot instead of a forever spinner. */
  died?: boolean;
}

/**
 * Floating context panel over the conversation area (top-right). Renders null
 * while it has no content, so a chat without subagents keeps its space. The
 * first section, "Subagents", reuses the sidebar section look (toggle,
 * chevron, grid-rows collapse) and lists the delegate children of the ACTIVE
 * chat session by `parent_session_id` + `_delegate_from` (issue #122).
 */
export function ChatContextPanel({
  sessionId,
  connectionId,
  profile,
  refreshKey,
  onOpenSession,
  todo,
}: {
  /** Stored session id of the chat this panel floats over; null = scratch. */
  sessionId: string | null;
  connectionId: string;
  profile: string;
  /** Bumped by the caller on turn end / session change to re-fetch rows. */
  refreshKey: number;
  /** Open a subagent transcript as a chat run (Layout's resume flow). */
  onOpenSession: (sessionId: string) => void;
  /** Live todo snapshot for this chat (issue #126): transcript-derived seed,
   *  updated by `todo.updated` events while the agent works. */
  todo?: TodoSnapshot | null;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [rows, setRows] = useState<SubagentRow[]>([]);
  const [subagentsOpen, setSubagentsOpen] = useState(false);
  const [todoOpen, setTodoOpen] = useState(true);
  const aliveRef = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    if (!sessionId) {
      setRows([]);
      return;
    }
    try {
      const list = await window.hermesAPI.listSubagentSessions(
        sessionId,
        connectionId,
        profile,
      );
      if (!aliveRef.current) return;
      setRows(Array.isArray(list) ? list : []);
    } catch {
      // Leave the previous list; the panel is best-effort chrome.
    }
  }, [sessionId, connectionId, profile]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
    };
  }, [load, refreshKey]);

  const hasTodo =
    !!todo &&
    todo.items.some(
      (i) => i.status === "pending" || i.status === "in_progress",
    );
  if (rows.length === 0 && !hasTodo) return null;

  return (
    <div className="chat-context-panel">
      {hasTodo && (
        <TodoSection
          snapshot={todo ?? null}
          open={todoOpen}
          onToggle={() => setTodoOpen((v) => !v)}
        />
      )}
      {rows.length > 0 && (
        <div className="sidebar-recent-section">
          <button
            type="button"
            className="sidebar-recent-section-toggle chat-context-panel-toggle"
            onClick={() => setSubagentsOpen((v) => !v)}
            aria-expanded={subagentsOpen}
          >
            <span>{t("navigation.subagents")}</span>
            {subagentsOpen ? (
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
            className={`sidebar-recent-collapse ${subagentsOpen ? "expanded" : ""}`}
          >
            <div className="sidebar-recent-collapse-inner">
              {rows.map((row) => {
                const running = row.endedAt == null && !row.died;
                return (
                  <button
                    key={row.id}
                    type="button"
                    className="chat-context-panel-row"
                    onClick={() => onOpenSession(row.id)}
                    title={
                      row.died
                        ? `${row.title} (${t("navigation.subagentDied")})`
                        : row.title
                    }
                  >
                    {running ? (
                      <span
                        className="sidebar-recent-session-spinner"
                        aria-hidden
                      />
                    ) : (
                      <span
                        className="sidebar-recent-session-dot"
                        aria-hidden
                      />
                    )}
                    <span className="chat-context-panel-row-title">
                      {row.title || row.id.slice(-8)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
