import { memo, useEffect, useState } from "react";
import { CircleDashed, ChevronRight, ChevronDown, Send, X } from "lucide-react";
import { useI18n } from "../../components/useI18n";
import type { QueuedMessage } from "./hooks/useChatQueue";

interface QueuedMessagesProps {
  messages: QueuedMessage[];
  busy?: boolean;
  error?: string | null;
  onRemove: (id: string) => void;
  /** Send this queued message now: waits for the interrupted turn to become idle
   * before submitting the selected stable message ID. */
  onSendNow: (id: string) => void;
}

/**
 * Pending-send queue indicator shown above the input while the agent is busy.
 * Each queued message can be individually cancelled via an X button or sent
 * immediately (interrupting the current run) via the send button.
 */
export const QueuedMessages = memo(function QueuedMessages({
  messages,
  onRemove,
  onSendNow,
  busy = false,
  error,
}: QueuedMessagesProps): React.JSX.Element | null {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (messages.length === 0) setExpanded(false);
  }, [messages.length]);

  if (messages.length === 0) return null;

  const preview = (m: QueuedMessage): string => {
    const text = m.text.trim();
    if (text) return text;
    return t("chat.queuedAttachment", { count: m.attachments.length });
  };

  if (messages.length === 1) {
    return (
      <>
        {error && (
          <div className="chat-error-message" role="alert">
            {error}
          </div>
        )}
        <div className="chat-queue-indicator" aria-busy={busy}>
          <CircleDashed size={14} className="chat-queue-icon" />
          <span className="chat-queue-single" title={preview(messages[0])}>
            {preview(messages[0])}
          </span>
          <button
            type="button"
            className="chat-queue-send"
            disabled={busy || messages[0].uncertain}
            onClick={() => onSendNow(messages[0].id)}
            aria-label={t("chat.queuedSendNow")}
            title={t("chat.queuedSendNow")}
          >
            <Send size={12} />
          </button>
          <button
            type="button"
            className="chat-queue-remove"
            disabled={busy}
            onClick={() => onRemove(messages[0].id)}
            aria-label={t("chat.queuedCancel")}
            title={t("chat.queuedCancel")}
          >
            <X size={12} />
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {error && (
        <div className="chat-error-message" role="alert">
          {error}
        </div>
      )}
      <div
        className="chat-queue-indicator chat-queue-collapsible"
        aria-busy={busy}
      >
        <button
          type="button"
          className="chat-queue-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <CircleDashed size={14} className="chat-queue-icon" />
          <span>{t("chat.queuedCount", { count: messages.length })}</span>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {expanded && (
          <ul className="chat-queue-list">
            {messages.map((m) => (
              <li key={m.id} className="chat-queue-item" title={preview(m)}>
                <span className="chat-queue-item-text">{preview(m)}</span>
                <button
                  type="button"
                  className="chat-queue-send"
                  disabled={busy || m.uncertain}
                  onClick={() => onSendNow(m.id)}
                  aria-label={t("chat.queuedSendNow")}
                  title={t("chat.queuedSendNow")}
                >
                  <Send size={12} />
                </button>
                <button
                  type="button"
                  className="chat-queue-remove"
                  disabled={busy}
                  onClick={() => onRemove(m.id)}
                  aria-label={t("chat.queuedCancel")}
                  title={t("chat.queuedCancel")}
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
});
