import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatMessagesWrap } from "./ChatMessagesWrap";

let resize: (() => void) | undefined;
const disconnect = vi.fn();
const observe = vi.fn();

beforeEach(() => {
  resize = undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("tracks the actual scrollbar gutter independently for every chat", () => {
  const { container, unmount } = render(
    <>
      <ChatMessagesWrap>
        <div className="chat-messages">one</div>
      </ChatMessagesWrap>
      <ChatMessagesWrap>
        <div className="chat-messages">two</div>
      </ChatMessagesWrap>
    </>,
  );
  const wraps = container.querySelectorAll<HTMLElement>(".chat-messages-wrap");
  const scrollers = container.querySelectorAll<HTMLElement>(".chat-messages");
  expect(observe).toHaveBeenCalledWith(scrollers[0]);
  expect(observe).toHaveBeenCalledWith(scrollers[1]);
  Object.defineProperty(scrollers[1], "offsetWidth", {
    configurable: true,
    value: 800,
  });
  Object.defineProperty(scrollers[1], "clientWidth", {
    configurable: true,
    value: 794,
  });
  act(() => {
    resize?.();
  });
  expect(wraps[1].style.getPropertyValue("--chat-scrollbar-gutter")).toBe(
    "6px",
  );
  expect(wraps[0].style.getPropertyValue("--chat-scrollbar-gutter")).toBe(
    "0px",
  );
  Object.defineProperty(scrollers[1], "clientWidth", {
    configurable: true,
    value: 800,
  });
  act(() => {
    resize?.();
  });
  expect(wraps[1].style.getPropertyValue("--chat-scrollbar-gutter")).toBe(
    "0px",
  );
  unmount();
  expect(disconnect).toHaveBeenCalledTimes(2);
});
