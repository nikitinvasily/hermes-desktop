import { memo, useState } from "react";
import { Shield, ShieldOff } from "lucide-react";
import { useI18n } from "../../components/useI18n";

interface ApprovalToggleProps {
  /** Live approval-bypass state from the transport (null = unknown yet). */
  yolo: boolean | null;
  /** Toggle the per-session bypass. Resolves false when the RPC failed. */
  onToggle: (enabled: boolean) => Promise<boolean>;
}

/**
 * Per-chat approval toggle for the chat input toolbar. Click flips the current
 * session's dangerous-command approval bypass (`config.set key=yolo,
 * scope=session`) — the same flag the TUI's Shift+Tab flips. Scope is strictly
 * this chat: the persistent `approvals.mode` config is never touched. When the
 * bypass is active the icon is highlighted and a text label shows next to it.
 */
export const ApprovalToggle = memo(function ApprovalToggle({
  yolo,
  onToggle,
}: ApprovalToggleProps): React.JSX.Element {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const active = yolo === true;

  const handleClick = (): void => {
    if (busy) return;
    setBusy(true);
    void onToggle(!active)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <button
      type="button"
      className={`btn-ghost chat-tool-btn ${active ? "chat-tool-btn-active" : ""}`}
      onClick={handleClick}
      disabled={busy}
      aria-pressed={active}
      title={
        active ? t("chat.approvalToggle.off") : t("chat.approvalToggle.on")
      }
      aria-label={t("chat.approvalToggle.label")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        height: 28,
        padding: active ? "0 8px" : 0,
        width: active ? "auto" : 28,
        borderRadius: 6,
        color: active ? "var(--warning, #d97706)" : "var(--text-secondary)",
        background: active
          ? "color-mix(in srgb, var(--warning, #d97706) 12%, transparent)"
          : "transparent",
      }}
    >
      {active ? <ShieldOff size={14} /> : <Shield size={14} />}
      {active && (
        <span className="chat-approval-toggle-label">
          {t("chat.approvalToggle.activeLabel")}
        </span>
      )}
    </button>
  );
});
