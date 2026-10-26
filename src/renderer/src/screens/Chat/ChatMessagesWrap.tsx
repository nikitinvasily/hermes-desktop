import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Keep the floating dock aligned with the scroller's real content box. */
export function ChatMessagesWrap({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const wrap = ref.current;
    const scroller = wrap?.querySelector<HTMLElement>(".chat-messages");
    if (!wrap || !scroller) return;
    const sync = (): void => {
      wrap.style.setProperty(
        "--chat-scrollbar-gutter",
        `${Math.max(0, scroller.offsetWidth - scroller.clientWidth)}px`,
      );
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(scroller);
    return (): void => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="chat-messages-wrap">
      {children}
    </div>
  );
}
