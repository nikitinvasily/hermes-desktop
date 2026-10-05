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
  /** Currently revealed item count (backlog #92 prefetch arithmetic). */
  shown: number;
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
    shown: effective,
    showMore: (): void => setShown((prev) => prev + chunk),
  };
}

/**
 * The "Show more (N)" row appended under a capped list. Renders null when
 * there is nothing hidden and no external page to fetch (Chats paging).
 */
export function ShowMoreRow({
  hiddenCount,
  externalMore = false,
  onShowMore,
  tabIndex = 0,
  ariaLabel,
}: {
  /** Items currently hidden below the cap; 0 with `externalMore` still shows the row. */
  hiddenCount: number;
  /** True when the source (server/cache) has rows beyond the loaded list —
   * the row stays visible at hiddenCount 0 so the list never dead-ends
   * without a load-more affordance (backlog #92). */
  externalMore?: boolean;
  /** Reveal the next chunk (and/or load the next external page). */
  onShowMore: () => void;
  tabIndex?: number;
  ariaLabel?: string;
}): React.JSX.Element | null {
  const { t } = useI18n();
  if (hiddenCount <= 0 && !externalMore) return null;
  return (
    <button
      type="button"
      className="sidebar-show-more"
      onClick={onShowMore}
      tabIndex={tabIndex}
      aria-label={ariaLabel}
    >
      {hiddenCount > 0
        ? t("navigation.showMoreCount", { count: hiddenCount })
        : t("common.showMore")}
    </button>
  );
}
