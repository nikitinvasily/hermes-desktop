import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useMessageSearch } from "./useMessageSearch";
import { AgentMarkdown } from "../../components/AgentMarkdown";
import { MessageList } from "./MessageList";
import type { ChatBubbleMessage, ChatMessage } from "./types";

vi.mock("../../components/useI18n", () => ({
  useI18n: (): {
    t: (key: string, values?: Record<string, unknown>) => string;
  } => ({
    t: (key: string, values?: Record<string, unknown>): string =>
      values ? `${values.current} / ${values.total}` : key,
  }),
}));
afterEach((): void => {
  cleanup();
  vi.unstubAllGlobals();
});

it("opens only active chat search and navigates literal occurrences with keyboard and buttons", async () => {
  const messages: ChatMessage[] = [
    { id: "old", role: "user", content: "Needle needle" },
    { id: "new", role: "agent", content: "NEEDLE" },
  ];
  function Harness({
    active,
    name,
  }: {
    active: boolean;
    name: string;
  }): React.JSX.Element {
    const containerRef = useRef<HTMLDivElement>(null);
    const search = useMessageSearch({
      messages,
      active,
      scope: name,
      containerRef,
    });
    return (
      <section data-testid={name}>
        {search.toolbar}
        <div ref={containerRef} data-target={search.searchMessageId} />
      </section>
    );
  }
  render(
    <>
      <Harness active name="active" />
      <Harness active={false} name="background" />
    </>,
  );
  fireEvent.keyDown(document, { key: "f", metaKey: true });
  const input = screen.queryByRole("searchbox");
  expect(input).not.toBeNull();
  if (!input) return;
  expect(screen.getByTestId("background").querySelector("input")).toBeNull();
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "needle" } });
  expect(screen.getByRole("status").textContent).toBe("1 / 3");
  expect(
    screen
      .getByTestId("active")
      .querySelector("[data-target]")
      ?.getAttribute("data-target"),
  ).toBe("old");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByRole("status").textContent).toBe("2 / 3");
  fireEvent.click(screen.getByRole("button", { name: "chat.searchNext" }));
  expect(screen.getByRole("status").textContent).toBe("3 / 3");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByRole("status").textContent).toBe("1 / 3");
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(screen.getByRole("status").textContent).toBe("3 / 3");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("searchbox")).toBeNull();
});

it("highlights a rendered phrase across Markdown spans without altering React DOM", () => {
  const registry = new Map<string, Set<Range>>();
  vi.stubGlobal("CSS", { highlights: registry });
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  const messages: ChatBubbleMessage[] = [
    {
      id: "phrase",
      role: "user",
      content: "a **phrase** bridge and phrase bridge",
    },
  ];
  function Harness(): React.JSX.Element {
    const containerRef = useRef<HTMLDivElement>(null);
    const search = useMessageSearch({
      messages,
      active: true,
      scope: "phrase",
      containerRef,
    });
    return (
      <>
        {search.toolbar}
        <div ref={containerRef}>
          <div data-chat-message-id="phrase">
            <AgentMarkdown>{messages[0].content}</AgentMarkdown>
          </div>
        </div>
      </>
    );
  }
  const { container } = render(<Harness />);
  fireEvent.keyDown(document, { key: "f", metaKey: true });
  const input = screen.getByRole("searchbox");
  fireEvent.change(input, { target: { value: "phrase bridge" } });
  expect(
    Array.from(registry.get("chat-message-search") ?? [], (range): string =>
      range.toString(),
    ),
  ).toEqual(["phrase bridge", "phrase bridge"]);
  expect(
    Array.from(
      registry.get("chat-message-search-current") ?? [],
      (range): string => range.toString(),
    ),
  ).toEqual(["phrase bridge"]);
  expect(container.querySelector("strong")?.textContent).toBe("phrase");
  expect(container.querySelector("mark")).toBeNull();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(registry.size).toBe(0);
  vi.unstubAllGlobals();
});

function TranscriptHarness({
  messages,
  active = true,
  scope = "session",
}: {
  messages: ChatMessage[];
  active?: boolean;
  scope?: string;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const search = useMessageSearch({ messages, active, scope, containerRef });
  return (
    <>
      {search.toolbar}
      <div className="chat-messages" ref={containerRef}>
        <MessageList
          messages={messages}
          searchMessageId={search.searchMessageId}
          searchOpen={search.open}
          isLoading={false}
          toolProgress={null}
          onApprove={vi.fn()}
          onDeny={vi.fn()}
          onClarifyResolved={vi.fn()}
          onApprovalRespond={vi.fn()}
          onApprovalResolved={vi.fn()}
        />
      </div>
    </>
  );
}

it("re-reveals the active horizontal range after asynchronous syntax node replacement", async () => {
  const messages: ChatMessage[] = [
    { id: "code", role: "user", content: "```text\nprefix Needle\n```" },
  ];
  function Harness(): React.JSX.Element {
    const containerRef = useRef<HTMLDivElement>(null);
    const search = useMessageSearch({
      messages,
      active: true,
      scope: "async-code",
      containerRef,
    });
    return (
      <>
        {search.toolbar}
        <div ref={containerRef}>
          <div data-chat-message-id="code">
            <div data-chat-search-block="0">
              <pre style={{ overflowX: "auto" }}>
                <code>prefix Needle</code>
              </pre>
            </div>
          </div>
        </div>
      </>
    );
  }
  const { container } = render(<Harness />);
  const pre = container.querySelector("pre")!;
  Object.defineProperties(pre, {
    scrollWidth: { value: 2000 },
    clientWidth: { value: 300 },
  });
  vi.spyOn(pre, "getBoundingClientRect").mockReturnValue({
    left: 0,
    right: 300,
  } as DOMRect);
  vi.spyOn(document, "createRange").mockImplementation((): Range => {
    const range = new Range();
    range.getBoundingClientRect = (): DOMRect =>
      ({
        left: 1400 - pre.scrollLeft,
        right: 1450 - pre.scrollLeft,
        top: 0,
        height: 20,
      }) as DOMRect;
    return range;
  });
  try {
    fireEvent.keyDown(document, { key: "f", metaKey: true });
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Needle" },
    });
    expect(pre.scrollLeft).toBe(1150);
    pre.scrollLeft = 0;
    // Simulate Prism's async replacement, not a search state change.
    pre.querySelector("code")!.replaceChildren(
      document.createTextNode("prefix "),
      Object.assign(document.createElement("span"), {
        textContent: "Needle",
      }),
    );
    await waitFor(() => expect(pre.scrollLeft).toBe(1150));
  } finally {
    vi.restoreAllMocks();
  }
});

it("finds old rows through real Markdown and bounded MessageList, updates streaming counts and restores the tail", () => {
  const registry = new Map<string, Set<Range>>();
  vi.stubGlobal("CSS", { highlights: registry });
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  const messages: ChatMessage[] = Array.from(
    { length: 360 },
    (_, index): ChatBubbleMessage => ({
      id: `row${index}`,
      role: "user",
      content: index === 4 ? "old **Needle** bridge" : `filler ${index}`,
    }),
  );
  const { container, rerender } = render(
    <TranscriptHarness messages={messages} />,
  );
  expect(container.querySelector('[data-chat-message-id="row4"]')).toBeNull();
  fireEvent.keyDown(document, { key: "f", metaKey: true });
  const input = screen.getByRole("searchbox");
  fireEvent.change(input, { target: { value: "needle bridge" } });
  expect(screen.getByRole("status").textContent).toBe("1 / 1");
  expect(
    container.querySelector('[data-chat-message-id="row4"]'),
  ).not.toBeNull();
  expect(
    container.querySelectorAll(".chat-message").length,
  ).toBeLessThanOrEqual(100);
  expect(
    Array.from(
      registry.get("chat-message-search-current") ?? [],
      (range): string => range.toString(),
    ),
  ).toEqual(["Needle bridge"]);
  const streamed = [
    ...messages,
    { id: "stream", role: "user" as const, content: "new needle bridge" },
  ];
  rerender(<TranscriptHarness messages={streamed} />);
  expect(screen.getByRole("status").textContent).toBe("1 / 2");
  expect(
    container.querySelector('[data-chat-message-id="row4"]'),
  ).not.toBeNull();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByRole("status").textContent).toBe("2 / 2");
  expect(
    container.querySelector('[data-chat-message-id="stream"]'),
  ).not.toBeNull();
  expect(
    container.querySelectorAll(".chat-message").length,
  ).toBeLessThanOrEqual(100);
  fireEvent.click(screen.getByRole("button", { name: "chat.searchClose" }));
  expect(container.querySelector('[data-chat-message-id="row4"]')).toBeNull();
  expect(
    container.querySelector('[data-chat-message-id="stream"]'),
  ).not.toBeNull();
  expect(registry.size).toBe(0);
});

it("resets scope, deactivation and cleared/empty queries without leaking matches", () => {
  const messages: ChatBubbleMessage[] = [
    { id: "one", role: "user", content: "literal.a+b[0]" },
  ];
  const { rerender } = render(<TranscriptHarness messages={messages} />);
  fireEvent.keyDown(document, { key: "f", ctrlKey: true });
  let input = screen.getByRole("searchbox");
  expect(screen.getByRole("status").textContent).toBe("0 / 0");
  fireEvent.change(input, { target: { value: "literal.a+b[0]" } });
  expect(screen.getByRole("status").textContent).toBe("1 / 1");
  fireEvent.change(input, { target: { value: "not present" } });
  expect(screen.getByRole("status").textContent).toBe("0 / 0");
  expect(
    (
      screen.getByRole("button", {
        name: "chat.searchNext",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.change(input, { target: { value: "" } });
  expect(screen.getByRole("status").textContent).toBe("0 / 0");
  rerender(<TranscriptHarness messages={messages} active={false} />);
  expect(screen.queryByRole("searchbox")).toBeNull();
  fireEvent.keyDown(document, { key: "f", metaKey: true });
  expect(screen.queryByRole("searchbox")).toBeNull();
  rerender(
    <TranscriptHarness messages={messages} scope="another-connection" />,
  );
  fireEvent.keyDown(document, { key: "f", metaKey: true });
  input = screen.getByRole("searchbox");
  expect((input as HTMLInputElement).value).toBe("");
  fireEvent.change(input, { target: { value: "literal" } });
  rerender(<TranscriptHarness messages={[]} scope="another-connection" />);
  expect(screen.queryByRole("searchbox")).toBeNull();
});
