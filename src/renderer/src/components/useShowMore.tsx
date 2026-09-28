import { useEffect, useState } from "react";
import { useI18n } from "./useI18n";

/** Items revealed per "Show more" click (task #82, ChatGPT-style chunks). */
export const SHOW_MORE_CHUNK = 5;

/**
 * Caps a collapsible list at the first chunk of items and reveals the next
 * chunk on demand (task #82). `resetKey=false` (section collapsed) resets the
 * revealed count back to one chunk, so reopening starts from the top 5 again.
 */
export function useShowMore<T>(
  items: T[],
  opts?: { chunk?: number; resetKey?: boolean },
): {
  visible: T[];
  hiddenCount: number;
  showMore: () => void;
} {
  const chunk = opts?.chunk ?? SHOW_MORE_CHUNK;
  const resetKey = opts?.resetKey ?? true;
  const [shown, setShown] = useState(chunk);

  useEffect((): void => {
    if (!resetKey) setShown(chunk);
  }, [resetKey, chunk]);

  // Clamp when the source list shrinks (deletions, syncs) so `shown` never
  // points past the end and hides a "Show more" row that does nothing.
  const effective = Math.min(shown, items.length);
  return {
    visible: items.slice(0, effective),
    hiddenCount: items.length - effective,
    showMore: (): void => setShown((prev) => prev + chunk),
  };
}

/**
 * The "Show more (N)" row appended under a capped list. Renders null when
 * there is nothing hidden and no external page to fetch (Chats paging).
 */
export function ShowMoreRow({
  hiddenCount,
  onShowMore,
  tabIndex = 0,
  ariaLabel,
}: {
  /** Items currently hidden below the cap; 0 with `onRequestPage` still shows the row. */
  hiddenCount: number;
  /** Reveal the next chunk (and/or load the next external page). */
  onShowMore: () => void;
  tabIndex?: number;
  ariaLabel?: string;
}): React.JSX.Element | null {
  const { t } = useI18n();
  if (hiddenCount <= 0) return null;
  return (
    <button
      type="button"
      className="sidebar-show-more"
      onClick={onShowMore}
      tabIndex={tabIndex}
      aria-label={ariaLabel}
    >
      {t("navigation.showMoreCount", { count: hiddenCount })}
    </button>
  );
}
