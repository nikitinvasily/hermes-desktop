import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Chat from "./Chat";
import type { ChatMessage } from "./types";

vi.mock("../../components/useI18n", () => {
  const t = (key: string): string => key;
  return { useI18n: () => ({ t }) };
});

const messages: ChatMessage[] = [
  { id: "u", role: "user", content: "saved history" },
  { id: "a", role: "agent", content: "saved reply" },
];
const frames = new Map<number, FrameRequestCallback>();
const observers: Array<{
  callback: ResizeObserverCallback;
  targets: Element[];
  disconnected: boolean;
}> = [];
let nextFrame = 0;
let height = 700;
let api: Record<string, ReturnType<typeof vi.fn>>;

function flush(): void {
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(1));
  });
}
function resize(): void {
  act(() => {
    observers
      .filter((o) => !o.disconnected)
      .forEach((o) => o.callback([], {} as ResizeObserver));
  });
}
function chat(
  props: Partial<React.ComponentProps<typeof Chat>> = {},
): React.JSX.Element {
  return (
    <Chat
      runId="run"
      connectionId="a"
      profile="work"
      initialSessionId="saved"
      initialMessages={messages}
      {...props}
    />
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("hermes-follow-x-dismissed", "true");
  frames.clear();
  observers.splice(0);
  height = 700;
  api = {
    getConnectionConfig: vi
      .fn()
      .mockResolvedValue({ connectionId: "a", mode: "local" }),
    getModelConfig: vi
      .fn()
      .mockResolvedValue({ model: "fixture", provider: "openai" }),
    listModels: vi.fn().mockResolvedValue([]),
    discoverModels: vi.fn().mockResolvedValue({ models: [], status: "ok" }),
    validateChatReadiness: vi.fn().mockResolvedValue({ ok: true, issues: [] }),
    getModelContextWindow: vi.fn().mockResolvedValue(200000),
  };
  vi.stubGlobal("hermesAPI", undefined);
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: new Proxy(api, {
      get(record, key: string) {
        record[key] ||= key.startsWith("on")
          ? vi.fn().mockReturnValue(() => {})
          : vi.fn().mockResolvedValue(null);
        return record[key];
      },
    }),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      record: (typeof observers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, targets: [], disconnected: false };
        observers.push(this.record);
      }
      observe(target: Element): void {
        this.record.targets.push(target);
      }
      disconnect(): void {
        this.record.disconnected = true;
      }
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe(): void {
        // JSDOM has no intersection layout.
      }
      unobserve(): void {
        // JSDOM has no intersection layout.
      }
      disconnect(): void {
        // JSDOM has no intersection layout.
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("chat-messages") ? height : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("chat-messages") ? 300 : 0;
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("actual Chat observes its existing centered column and jumps from reading without moving the composer", async () => {
  const view = render(chat());
  await act(async () => {});
  const viewport =
    view.container.querySelector<HTMLDivElement>(".chat-messages")!;
  const content = viewport.querySelector(".chat-content-column")!;
  const observer = observers.find((o) => o.targets.includes(content));
  expect(observer).toBeDefined();
  expect(observer?.targets).toContain(viewport);
  expect(viewport.scrollTop).toBe(400);
  viewport.scrollTop = 40;
  fireEvent.scroll(viewport);
  const jump = screen.getByRole("button", { name: "chat.jumpToLatest" });
  expect(jump.parentElement).toHaveClass("chat-messages-wrap");
  expect(viewport.parentElement?.querySelector(".chat-input-area")).toBeNull();
  expect(
    view.container.querySelector(".chat-input-area > .chat-content-column"),
  ).not.toBeNull();
  height = 1200;
  resize();
  flush();
  expect(viewport.scrollTop).toBe(40);
  fireEvent.click(jump);
  flush();
  expect(viewport.scrollTop).toBe(900);
  expect(
    screen.queryByRole("button", { name: "chat.jumpToLatest" }),
  ).toBeNull();
  view.unmount();
  expect(observer?.disconnected).toBe(true);
});

it("actual inactive mounted Chat cancels queued writes and resumes following on activation", async () => {
  const view = render(chat());
  await act(async () => {});
  const viewport =
    view.container.querySelector<HTMLDivElement>(".chat-messages")!;
  height = 1100;
  resize();
  view.rerender(chat({ active: false }));
  flush();
  expect(viewport.scrollTop).toBe(400);
  resize();
  flush();
  expect(viewport.scrollTop).toBe(400);
  view.rerender(chat());
  flush();
  expect(viewport.scrollTop).toBe(800);
});

it.each(["runId", "connectionId", "profile", "initialSessionId"] as const)(
  "actual Chat resets follow only when %s identity changes",
  async (key) => {
    const view = render(chat());
    await act(async () => {});
    const viewport =
      view.container.querySelector<HTMLDivElement>(".chat-messages")!;
    viewport.scrollTop = 40;
    fireEvent.scroll(viewport);
    expect(
      screen.getByRole("button", { name: "chat.jumpToLatest" }),
    ).toBeInTheDocument();
    view.rerender(chat({ [key]: "different" }));
    await act(async () => {});
    flush();
    expect(viewport.scrollTop).toBe(400);
    expect(
      screen.queryByRole("button", { name: "chat.jumpToLatest" }),
    ).toBeNull();
  },
);

it("actual search owns scroll during streaming and restores reading before explicit jump", async () => {
  const view = render(chat());
  await act(async () => {});
  const viewport =
    view.container.querySelector<HTMLDivElement>(".chat-messages")!;
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  fireEvent.keyDown(document, { key: "f", metaKey: true });
  const input = screen.getByRole("searchbox");
  fireEvent.change(input, { target: { value: "saved history" } });
  expect(
    screen.queryByRole("button", { name: "chat.jumpToLatest" }),
  ).toBeNull();
  viewport.scrollTop = 20;
  fireEvent.scroll(viewport);
  height = 1200;
  await act(async () => {
    api.onChatChunk.mock.calls.at(-1)![0]("run", "streamed answer");
  });
  resize();
  flush();
  expect(viewport.scrollTop).toBe(20);
  expect(screen.getByRole("searchbox")).toHaveValue("saved history");
  fireEvent.keyDown(input, { key: "Escape" });
  flush();
  expect(viewport.scrollTop).toBe(100);
  fireEvent.click(screen.getByRole("button", { name: "chat.jumpToLatest" }));
  flush();
  expect(viewport.scrollTop).toBe(900);
});

it("actual initially inactive history performs its first instant write only on activation", async () => {
  const view = render(chat({ active: false }));
  await act(async () => {});
  const viewport =
    view.container.querySelector<HTMLDivElement>(".chat-messages")!;
  resize();
  flush();
  expect(viewport.scrollTop).toBe(0);
  view.rerender(chat());
  expect(viewport.scrollTop).toBe(400);
});

it("actual mounted chats isolate active follow and search ownership", async () => {
  const pair = (secondActive: boolean): React.JSX.Element => (
    <>
      {chat({ runId: "first", active: !secondActive })}
      {chat({ runId: "second", active: secondActive })}
    </>
  );
  const view = render(pair(false));
  await act(async () => {});
  const viewports =
    view.container.querySelectorAll<HTMLDivElement>(".chat-messages");
  expect(Array.from(viewports, (v) => v.scrollTop)).toEqual([400, 0]);
  height = 1100;
  resize();
  flush();
  expect(Array.from(viewports, (v) => v.scrollTop)).toEqual([800, 0]);
  viewports[0].scrollTop = 40;
  fireEvent.scroll(viewports[0]);
  view.rerender(pair(true));
  flush();
  expect(Array.from(viewports, (v) => v.scrollTop)).toEqual([40, 800]);
  fireEvent.keyDown(document, { key: "f", metaKey: true });
  expect(screen.getAllByRole("searchbox")).toHaveLength(1);
  expect(
    screen.queryByRole("button", { name: "chat.jumpToLatest" }),
  ).toBeNull();
  view.rerender(pair(false));
  flush();
  expect(Array.from(viewports, (v) => v.scrollTop)).toEqual([40, 800]);
  expect(
    screen.getByRole("button", { name: "chat.jumpToLatest" }),
  ).toBeInTheDocument();
});
