import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChatScroll } from "./useChatScroll";
import type { ChatMessage } from "../types";

afterEach((): void => {
  cleanup();
  vi.restoreAllMocks();
});

it("does not auto-scroll on streaming deltas or new user rows while message search is open", () => {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  const useScroll = useChatScroll as (
    messages: ChatMessage[],
    paused: boolean,
  ) => ReturnType<typeof useChatScroll>;
  function Harness({
    messages,
    paused,
  }: {
    messages: ChatMessage[];
    paused: boolean;
  }): React.JSX.Element {
    const { containerRef, bottomRef } = useScroll(messages, paused);
    return (
      <div ref={containerRef}>
        <div ref={bottomRef} />
      </div>
    );
  }
  const messages: ChatMessage[] = [
    { id: "a", role: "agent", content: "start" },
  ];
  const { rerender } = render(<Harness messages={messages} paused={false} />);
  expect(scroll).toHaveBeenCalledTimes(1);
  scroll.mockClear();
  rerender(
    <Harness
      messages={[{ ...messages[0], content: "start streamed" } as ChatMessage]}
      paused
    />,
  );
  expect(scroll).not.toHaveBeenCalled();
  rerender(
    <Harness
      messages={[...messages, { id: "u", role: "user", content: "next" }]}
      paused
    />,
  );
  expect(scroll).not.toHaveBeenCalled();
  rerender(
    <Harness
      messages={[
        ...messages,
        { id: "u", role: "user", content: "next" },
        { id: "b", role: "agent", content: "answer" },
      ]}
      paused={false}
    />,
  );
  expect(scroll).toHaveBeenCalledTimes(1);
});
