import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "../types";

// @lat: [[chat-performance#Bottom follow ownership]]
export function useChatScroll(
  messages: ChatMessage[],
  paused = false,
  externalContainerRef?: React.RefObject<HTMLDivElement | null>,
  scope = "chat",
): {
  containerRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  bottomRef: React.RefObject<HTMLDivElement | null>;
  isFollowing: boolean;
  jumpToLatest: () => void;
} {
  const internalContainerRef = useRef<HTMLDivElement>(null);
  const containerRef = externalContainerRef ?? internalContainerRef;
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const followingRef = useRef(true);
  const [isFollowing, setIsFollowing] = useState(true);
  const previousTopRef = useRef(0);
  const previousCountRef = useRef(messages.length);
  const initialScrollDoneRef = useRef(false);
  const frameRef = useRef<number | null>(null);

  const follow = useCallback((value: boolean) => {
    followingRef.current = value;
    setIsFollowing(value);
  }, []);
  const cancelFrame = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);
  const writeBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container || pausedRef.current) return;
    container.scrollTop = Math.max(
      0,
      container.scrollHeight - container.clientHeight,
    );
    previousTopRef.current = container.scrollTop;
  }, [containerRef]);
  const scheduleFollow = useCallback(() => {
    if (pausedRef.current || !followingRef.current || frameRef.current !== null)
      return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      if (followingRef.current) writeBottom();
    });
  }, [writeBottom]);

  const jumpToLatest = useCallback(() => {
    if (pausedRef.current) return;
    follow(true);
    scheduleFollow();
  }, [follow, scheduleFollow]);

  const bindingRef = useRef<{
    container: HTMLDivElement;
    content: HTMLDivElement | null;
    scope: string;
    dispose: () => void;
  } | null>(null);

  useLayoutEffect(() => {
    initialScrollDoneRef.current = false;
    previousCountRef.current = 0;
    follow(true);
  }, [scope, follow]);

  // Refs can point at replacement nodes without their RefObject changing.
  // Reconcile handles each commit, but retain observers across streamed tokens.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    const bound = bindingRef.current;
    if (
      bound?.container === container &&
      bound?.content === content &&
      bound?.scope === scope
    )
      return;
    bound?.dispose();
    bindingRef.current = null;
    if (!container) return;
    previousTopRef.current = container.scrollTop;
    const handleScroll = (): void => {
      const top = container.scrollTop;
      if (pausedRef.current) {
        previousTopRef.current = top;
        return;
      }
      const distance = container.scrollHeight - top - container.clientHeight;
      // Lazy row sizing may clamp the viewport at the actual bottom.
      if (top < previousTopRef.current && distance >= 1) {
        follow(false);
        cancelFrame();
      } else if (distance < 60 && top > previousTopRef.current) follow(true);
      previousTopRef.current = top;
    };
    const handleWheel = (event: WheelEvent): void => {
      if (
        !pausedRef.current &&
        event.deltaY < 0 &&
        container.scrollHeight > container.clientHeight
      ) {
        follow(false);
        cancelFrame();
      }
    };
    const handleKey = (event: KeyboardEvent): void => {
      if (pausedRef.current) return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false" i])',
        )
      )
        return;
      if (
        ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
        (event.key === " " && event.shiftKey)
      ) {
        follow(false);
        cancelFrame();
      }
    };
    container.addEventListener("keydown", handleKey);
    container.addEventListener("scroll", handleScroll, { passive: true });
    container.addEventListener("wheel", handleWheel, { passive: true });
    let live = true;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (
              live &&
              containerRef.current === container &&
              contentRef.current === content
            )
              scheduleFollow();
          });
    observer?.observe(container);
    if (content) observer?.observe(content);
    bindingRef.current = {
      container,
      content,
      scope,
      dispose: () => {
        live = false;
        cancelFrame();
        observer?.disconnect();
        container.removeEventListener("keydown", handleKey);
        container.removeEventListener("scroll", handleScroll);
        container.removeEventListener("wheel", handleWheel);
      },
    };
  });

  useLayoutEffect(
    () => () => {
      bindingRef.current?.dispose();
      bindingRef.current = null;
    },
    [],
  );

  useLayoutEffect(() => {
    // Search restores its saved position before this hook's layout effects.
    // Rebase on pause transitions so that restoration is not upward intent.
    previousTopRef.current = containerRef.current?.scrollTop ?? 0;
  }, [paused, containerRef]);

  useLayoutEffect(() => {
    const previousCount = previousCountRef.current;
    previousCountRef.current = messages.length;
    if (messages.length === 0) initialScrollDoneRef.current = false;
    if (pausedRef.current || messages.length === 0) {
      cancelFrame();
      return;
    }
    if (!initialScrollDoneRef.current || previousCount === 0) {
      initialScrollDoneRef.current = true;
      follow(true);
      cancelFrame();
      writeBottom();
      return;
    }
    if (
      messages.length > previousCount &&
      messages[messages.length - 1]?.role === "user"
    )
      follow(true);
    scheduleFollow();
  }, [
    messages,
    paused,
    scope,
    follow,
    cancelFrame,
    writeBottom,
    scheduleFollow,
  ]);

  return { containerRef, contentRef, bottomRef, isFollowing, jumpToLatest };
}
