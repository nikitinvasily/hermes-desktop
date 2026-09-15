import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronUp } from "../../assets/icons";
import { useI18n } from "../../components/useI18n";

interface StatusInfo {
  mode: string;
  gatewayRunning: boolean;
  model: string;
  skillCount: number;
}

interface ConnectionRecord {
  connectionId: string;
  name: string;
  mode: "local" | "remote" | "ssh";
}

/**
 * Bottom system strip — a native desktop-app affordance that surfaces the
 * live connection/gateway state, active model, and skill count that were
 * previously buried. Every field is real (sourced from `listProfiles` +
 * `getConnectionConfig`); nothing is fabricated, so if a value is unknown the
 * chip is simply omitted rather than shown with a placeholder.
 *
 * The mode chip doubles as a connection switcher: when the registry holds
 * more than one saved connection it opens a popover listing every record,
 * and selecting one routes through the same `selectConnection` IPC the
 * Settings pane uses (main stops the SSH tunnel and broadcasts
 * `connection-config-changed`, so the rest of the app follows along).
 */
export function StatusBar({
  activeProfile,
}: {
  activeProfile: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const [info, setInfo] = useState<StatusInfo | null>(null);
  const [connections, setConnections] = useState<ConnectionRecord[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState("");
  const [activeConnectionName, setActiveConnectionName] = useState("");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      const [profiles, conn] = await Promise.all([
        window.hermesAPI.listProfiles().catch(() => []),
        window.hermesAPI.getConnectionConfig().catch(() => null),
      ]);
      if (cancelled) return;
      const active =
        profiles.find((p) => p.id === activeProfile) ??
        profiles.find((p) => p.isActive);
      if (!active && !conn) return; // keep last-known on a transient failure
      setInfo({
        mode: conn?.mode ?? "local",
        gatewayRunning: active?.gatewayRunning ?? false,
        model: active?.model ?? "",
        skillCount: active?.skillCount ?? 0,
      });
    }
    void load();
    // Gateway state + skill count change while the app is open; poll gently.
    const id = window.setInterval(() => void load(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeProfile]);

  // Registry snapshot for the switcher popover. Refreshed on open (names and
  // the active record change while closed); the async result is ignored once
  // the popover closes so a slow response can't reopen/repopulate it.
  const loadRegistry = useCallback(async (): Promise<void> => {
    try {
      const registry = await window.hermesAPI.getConnectionRegistry();
      setConnections(registry.connections);
      setActiveConnectionId(registry.activeConnectionId);
      const active = registry.connections.find(
        (c) => c.connectionId === registry.activeConnectionId,
      );
      setActiveConnectionName(active?.name ?? "");
    } catch {
      /* registry unavailable — keep last-known; the chip stays passive */
    }
  }, []);

  // Keep the active connection name fresh for the chip tooltip even while
  // the popover is closed (Settings can rename/select while we're closed).
  useEffect(() => {
    void loadRegistry();
    const unsubscribe = window.hermesAPI.onConnectionConfigChanged(() => {
      void loadRegistry();
    });
    return () => unsubscribe();
  }, [loadRegistry]);

  const handleChipClick = useCallback((): void => {
    if (connections.length > 1) setSwitcherOpen((v) => !v);
  }, [connections.length]);

  // Close on outside click: the overlay only renders with the popover.
  const handleOverlayClick = useCallback((): void => {
    setSwitcherOpen(false);
  }, []);

  const handleSelect = useCallback(
    async (connectionId: string): Promise<void> => {
      if (connectionId === activeConnectionId) {
        setSwitcherOpen(false);
        return;
      }
      setSwitching(connectionId);
      try {
        await window.hermesAPI.selectConnection(connectionId);
      } catch {
        /* optimistic: onConnectionConfigChanged / next registry load reconciles */
      } finally {
        setSwitching(null);
        setSwitcherOpen(false);
      }
    },
    [activeConnectionId],
  );

  // ⌘E / Ctrl+E toggles the switcher from anywhere (⌘P is profiles, ⌘K
  // search, ⌘, settings; E is free). Only binds when switching is possible.
  useEffect(() => {
    if (connections.length < 2) return;
    function onKey(e: KeyboardEvent): void {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "e" || e.key === "E")
      ) {
        e.preventDefault();
        setSwitcherOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [connections.length]);

  // Escape closes the popover without leaving focus on the chip.
  useEffect(() => {
    if (!switcherOpen) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.stopPropagation();
        setSwitcherOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [switcherOpen]);

  const isMac = window.electron?.process?.platform === "darwin";
  const mod = isMac ? "⌘" : "Ctrl";

  const switchingAwayFromSsh =
    switcherOpen &&
    connections.find((c) => c.connectionId === activeConnectionId)?.mode ===
      "ssh";

  const modeLabel = info?.mode ?? "local";
  const chipTitle =
    connections.length > 1
      ? activeConnectionName
        ? `${t("common.switchConnection")}: ${activeConnectionName} (${mod}E)`
        : `${t("common.switchConnection")} (${mod}E)`
      : undefined;

  return (
    <footer className="status-bar" aria-label="Status">
      <div className="status-bar-group">
        <span
          className={`status-dot ${info?.gatewayRunning ? "online" : "offline"}`}
          aria-hidden="true"
        />
        <span className="status-item status-strong">
          {info?.gatewayRunning ? "gateway" : "offline"}
        </span>
        <span className="status-sep" aria-hidden="true">
          &middot;
        </span>
        {connections.length > 1 ? (
          <button
            ref={chipRef}
            type="button"
            className={`status-conn-trigger ${switcherOpen ? "open" : ""}`}
            onClick={handleChipClick}
            title={chipTitle}
            aria-haspopup="menu"
            aria-expanded={switcherOpen}
          >
            <span className="status-item">{modeLabel}</span>
            <ChevronUp size={12} className="status-conn-chevron" aria-hidden />
          </button>
        ) : (
          <span className="status-item">{modeLabel}</span>
        )}
        {info?.model ? (
          <>
            <span className="status-sep" aria-hidden="true">
              &middot;
            </span>
            <span className="status-item">{info.model}</span>
          </>
        ) : null}
        {info ? (
          <>
            <span className="status-sep" aria-hidden="true">
              &middot;
            </span>
            <span className="status-item">{info.skillCount} skills</span>
          </>
        ) : null}
      </div>
      <div className="status-bar-group status-bar-hints">
        <span className="status-item">
          <kbd className="status-kbd">/</kbd> commands
        </span>
        <span className="status-sep" aria-hidden="true">
          &middot;
        </span>
        <span className="status-item">
          <kbd className="status-kbd">{mod},</kbd> settings
        </span>
      </div>

      {switcherOpen && (
        <div
          className="status-conn-overlay"
          onClick={handleOverlayClick}
          role="presentation"
        >
          <div
            className="status-conn-popover"
            role="menu"
            aria-label={t("common.switchConnection")}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="status-conn-header">
              {t("common.switchConnection")}
            </div>
            <div className="status-conn-list">
              {connections.map((c) => {
                const isActive = c.connectionId === activeConnectionId;
                return (
                  <button
                    key={c.connectionId}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    disabled={switching !== null}
                    className={`status-conn-item ${isActive ? "active" : ""}`}
                    onClick={() => void handleSelect(c.connectionId)}
                  >
                    <span className={`status-conn-mode mode-${c.mode}`}>
                      {c.mode}
                    </span>
                    <span className="status-conn-name">{c.name}</span>
                    {switching === c.connectionId ? (
                      <span className="status-conn-switching">…</span>
                    ) : (
                      isActive && (
                        <Check size={14} className="status-conn-check" />
                      )
                    )}
                  </button>
                );
              })}
            </div>
            {switchingAwayFromSsh && (
              <div className="status-conn-warning">
                {t("common.sshInterruptWarning")}
              </div>
            )}
          </div>
        </div>
      )}
    </footer>
  );
}

export default StatusBar;
