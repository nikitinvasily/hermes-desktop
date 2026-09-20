import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "../../assets/icons";
import { useI18n } from "../../components/useI18n";

/** A delegate-subagent child run listed by the panel (issue #122). */
export interface SubagentRow {
  id: string;
  startedAt: number;
  endedAt: number | null;
  /** Delegation goal: the child's first user message, single-line clamped. */
  title: string;
  model: string | null;
  messageCount: number;
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
}: {
  /** Stored session id of the chat this panel floats over; null = scratch. */
  sessionId: string | null;
  connectionId: string;
  profile: string;
  /** Bumped by the caller on turn end / session change to re-fetch rows. */
  refreshKey: number;
  /** Open a subagent transcript as a chat run (Layout's resume flow). */
  onOpenSession: (sessionId: string) => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [rows, setRows] = useState<SubagentRow[]>([]);
  const [open, setOpen] = useState(true);
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

  if (rows.length === 0) return null;

  return (
    <div className="chat-context-panel">
      <div className="sidebar-recent-section">
        <button
          type="button"
          className="sidebar-recent-section-toggle chat-context-panel-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span>{t("navigation.subagents")}</span>
          {open ? (
            <ChevronDown className="sidebar-recent-disclosure-icon" size={13} />
          ) : (
            <ChevronRight
              className="sidebar-recent-disclosure-icon"
              size={13}
            />
          )}
        </button>
        <div className={`sidebar-recent-collapse ${open ? "expanded" : ""}`}>
          <div className="sidebar-recent-collapse-inner">
            {rows.map((row) => {
              const running = row.endedAt == null;
              return (
                <button
                  key={row.id}
                  type="button"
                  className="chat-context-panel-row"
                  onClick={() => onOpenSession(row.id)}
                  title={row.title}
                >
                  {running ? (
                    <span
                      className="sidebar-recent-session-spinner"
                      aria-hidden
                    />
                  ) : (
                    <span className="sidebar-recent-session-dot" aria-hidden />
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
    </div>
  );
}
