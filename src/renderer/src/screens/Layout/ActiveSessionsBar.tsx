import { memo } from "react";
import { X, Plus } from "../../assets/icons";
import { OrbLoader } from "../../components/OrbLoader";
import { useI18n } from "../../components/useI18n";
import ProfileAvatar from "../../components/common/ProfileAvatar";
import type { ChatRun } from "./chatRuns";

export interface ProfileAppearance {
  color?: string | null;
  avatar?: string | null;
}

/**
 * The window's top strip. Doubles as the title-bar drag region (browser-style):
 * the strip itself is draggable, while the conversation chip on top of it stays
 * clickable. It shows exactly one tab — the ACTIVE session (issue #78);
 * background runs stay mounted and reachable via the sidebar or tab-cycling
 * shortcuts but have no chip here. With only a blank scratch conversation it
 * renders empty — just a drag area — so no vertical space is wasted before
 * there is a real session to show.
 */
export const ActiveSessionsBar = memo(function ActiveSessionsBar({
  runs,
  activeRunId,
  onClose,
  onNew,
  getAppearance,
}: {
  runs: ChatRun[];
  activeRunId: string;
  /** Close (and stop, if running) a conversation tab. */
  onClose: (runId: string) => void;
  /** Open a fresh conversation tab (browser-style new-tab button). */
  onNew: () => void;
  /** Resolve a profile's avatar/colour for its chip. */
  getAppearance?: (profile: string) => ProfileAppearance;
}): React.JSX.Element {
  const { t } = useI18n();

  // Only the ACTIVE run gets a chip (issue #78): background runs stay mounted
  // and reachable (sidebar click, Cmd+1..9, Cmd+Shift+[/]) but their tabs no
  // longer crowd the strip — the sidebar is the switcher now.
  const run = runs.find((r) => r.runId === activeRunId);
  const showChips = !!run && (!!run.sessionId || run.loading || !!run.title);

  return (
    <div className="active-sessions-bar" role="tablist">
      {showChips && run && (
        <div
          role="tab"
          aria-selected={true}
          className="active-session-chip active"
          title={`${run.profile} — ${run.title || t("sessions.newConversation")}`}
        >
          {run.loading ? (
            <span
              className="active-session-chip-avatar active-session-chip-orb"
              aria-label={run.profile}
            >
              <OrbLoader state="composing" size={20} />
            </span>
          ) : (
            <ProfileAvatar
              name={run.profile}
              color={getAppearance?.(run.profile)?.color}
              avatar={getAppearance?.(run.profile)?.avatar}
              size={18}
            />
          )}
          <span className="active-session-chip-title">
            {run.title || t("sessions.newConversation")}
          </span>
          <button
            type="button"
            className="active-session-chip-close"
            title={t("sessions.closeTab")}
            aria-label={t("sessions.closeTab")}
            onClick={() => onClose(run.runId)}
          >
            <X size={12} />
          </button>
        </div>
      )}
      {showChips && (
        <button
          type="button"
          className="active-session-new"
          title={t("sessions.newConversation")}
          aria-label={t("sessions.newConversation")}
          onClick={onNew}
        >
          <Plus size={14} />
        </button>
      )}
    </div>
  );
});
