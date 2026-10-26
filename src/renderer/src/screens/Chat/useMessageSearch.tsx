import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useI18n } from "../../components/useI18n";
import { searchMessages, type MessageSearchHit } from "./searchMarkdown";
import { paintSearchHighlights } from "./searchHighlights";
import type { ChatMessage } from "./types";

interface MessageSearchOptions {
  messages: ChatMessage[];
  active: boolean;
  scope: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

function hitKey(hit?: MessageSearchHit): string {
  return hit
    ? JSON.stringify([hit.messageId, hit.blockIndex, hit.start, hit.end])
    : "";
}

// @lat: [[chat-search#In-session message search]]
export function useMessageSearch({
  messages,
  active,
  scope,
  containerRef,
}: MessageSearchOptions): {
  open: boolean;
  searchMessageId?: string;
  toolbar: React.JSX.Element | null;
} {
  const { t } = useI18n();
  const identity = JSON.stringify([active, scope, messages[0]?.id]);
  const [previousIdentity, setPreviousIdentity] = useState(identity);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  if (identity !== previousIdentity) {
    setPreviousIdentity(identity);
    setOpen(false);
    setQuery("");
    setSelectedKey("");
  }
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const previousScrollTop = useRef(0);
  const wasOpen = useRef(false);
  const cache = useRef(new WeakMap<ChatMessage, string[]>());
  const hits = useMemo(
    (): MessageSearchHit[] =>
      open && active ? searchMessages(messages, query, cache.current) : [],
    [messages, query, open, active],
  );
  const selectedIndex = Math.max(
    0,
    hits.findIndex((hit): boolean => hitKey(hit) === selectedKey),
  );
  const selected = hits[selectedIndex];
  const close = useCallback((): void => {
    setOpen(false);
    setQuery("");
    setSelectedKey("");
    if (previousFocus.current?.isConnected) previousFocus.current.focus();
  }, []);
  const move = (delta: number): void => {
    if (hits.length)
      setSelectedKey(
        hitKey(hits[(selectedIndex + delta + hits.length) % hits.length]),
      );
  };

  useEffect((): (() => void) | undefined => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        if (!open) {
          previousFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          previousScrollTop.current = containerRef.current?.scrollTop ?? 0;
          setOpen(true);
        } else {
          inputRef.current?.focus();
          inputRef.current?.select();
        }
      } else if (open && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return (): void => document.removeEventListener("keydown", onKeyDown);
  }, [active, open, close, containerRef]);

  useLayoutEffect((): void => {
    if (open) inputRef.current?.focus();
    else if (wasOpen.current && containerRef.current)
      containerRef.current.scrollTop = previousScrollTop.current;
    wasOpen.current = open;
  }, [open, containerRef]);

  const lastScrolledHit = useRef("");
  useLayoutEffect((): (() => void) | undefined => {
    const root = containerRef.current;
    if (!root || !open || !active) {
      lastScrolledHit.current = "";
      return;
    }
    const key = hitKey(selected);
    let clear = paintSearchHighlights(
      root,
      hits,
      selected,
      !!key && lastScrolledHit.current !== key,
    );
    lastScrolledHit.current = key;
    // Syntax highlighting loads asynchronously and streaming can replace text
    // nodes without changing the selected occurrence. Rebind ranges, not focus.
    const observer = new MutationObserver((): void => {
      clear();
      clear = paintSearchHighlights(root, hits, selected, false);
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return (): void => {
      observer.disconnect();
      clear();
    };
  }, [open, active, hits, selected, containerRef]);

  return {
    open,
    searchMessageId: selected?.messageId,
    toolbar:
      open && active ? (
        <div
          className="chat-message-search"
          role="search"
          aria-label={t("chat.searchMessages")}
        >
          <input
            ref={inputRef}
            type="search"
            aria-label={t("chat.searchMessages")}
            placeholder={t("chat.searchMessages")}
            value={query}
            onChange={(event): void => {
              setQuery(event.target.value);
              setSelectedKey("");
            }}
            onKeyDown={(event): void => {
              if (event.key === "Enter") {
                event.preventDefault();
                move(event.shiftKey ? -1 : 1);
              }
            }}
          />
          <span role="status" aria-live="polite">
            {t("chat.searchCount", {
              current: selected ? selectedIndex + 1 : 0,
              total: hits.length,
            })}
          </span>
          <button
            type="button"
            disabled={!hits.length}
            onClick={(): void => move(-1)}
            aria-label={t("chat.searchPrevious")}
            title={t("chat.searchPrevious")}
          >
            <ChevronUp size={16} />
          </button>
          <button
            type="button"
            disabled={!hits.length}
            onClick={(): void => move(1)}
            aria-label={t("chat.searchNext")}
            title={t("chat.searchNext")}
          >
            <ChevronDown size={16} />
          </button>
          <button
            type="button"
            onClick={close}
            aria-label={t("chat.searchClose")}
            title={t("chat.searchClose")}
          >
            <X size={16} />
          </button>
        </div>
      ) : null,
  };
}
