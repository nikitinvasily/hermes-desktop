import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as search from "./searchMarkdown";
import { paintSearchHighlights } from "./searchHighlights";
import type { ChatMessage } from "./types";
import { AgentMarkdown } from "../../components/AgentMarkdown";

vi.mock("../../components/useI18n", () => ({
  useI18n: (): { t: (key: string) => string } => ({
    t: (key: string): string => key,
  }),
}));
vi.mock("../../components/MediaImage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../components/MediaImage")>();
  return {
    ...actual,
    MediaImage: (): React.JSX.Element => <span>Image UI chrome</span>,
  };
});
afterEach((): void => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("does not shift text highlights after an inline image's UI chrome", () => {
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
  const content = "before ![alt](/image.png) after Needle";
  const messages: ChatMessage[] = [{ id: "image", role: "user", content }];
  const { container } = render(
    <div data-chat-message-id="image">
      <AgentMarkdown>{content}</AgentMarkdown>
    </div>,
  );
  const hits = search.searchMessages(messages, "Needle");
  const clear = paintSearchHighlights(container, hits, hits[0], false);
  expect(
    Array.from(
      registry.get("chat-message-search-current") ?? [],
      (range): string => range.toString(),
    ),
  ).toEqual(["Needle"]);
  clear();
});

it("treats inline download media as a boundary and preserves adjacent text range offsets", () => {
  const content = "before![alt](https://example.test/file.pdf)after";
  const messages: ChatMessage[] = [{ id: "download", role: "user", content }];
  const { container } = render(
    <div data-chat-message-id="download">
      <AgentMarkdown>{content}</AgentMarkdown>
    </div>,
  );
  expect(container.textContent).toContain("file.pdf");
  expect(search.searchMessages(messages, "beforeafter")).toEqual([]);
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
  for (const query of ["before", "after"]) {
    const hits = search.searchMessages(messages, query);
    expect(hits).toHaveLength(1);
    const clear = paintSearchHighlights(container, hits, hits[0], false);
    expect(
      Array.from(
        registry.get("chat-message-search-current") ?? [],
        (range): string => range.toString(),
      ),
    ).toEqual([query]);
    clear();
  }
});

it("reveals the selected range inside nested horizontal code scrollers", () => {
  const { container } = render(
    <div data-chat-message-id="wide">
      <div data-chat-search-block="0">
        <pre style={{ overflowX: "auto" }}>
          <code>prefix Needle</code>
        </pre>
      </div>
    </div>,
  );
  const pre = container.querySelector("pre")!;
  Object.defineProperties(pre, {
    scrollWidth: { value: 2000 },
    clientWidth: { value: 300 },
  });
  vi.spyOn(pre, "getBoundingClientRect").mockReturnValue({
    left: 100,
    right: 400,
    top: 0,
    bottom: 100,
    height: 100,
  } as DOMRect);
  vi.spyOn(document, "createRange").mockImplementation((): Range => {
    const range = new Range();
    range.getBoundingClientRect = (): DOMRect =>
      ({
        left: 1400 - pre.scrollLeft,
        right: 1450 - pre.scrollLeft,
        top: 20,
        height: 20,
      }) as DOMRect;
    return range;
  });
  const hits = search.searchMessages(
    [{ id: "wide", role: "user", content: "prefix Needle" }],
    "Needle",
  );
  paintSearchHighlights(container, hits, hits[0], true);
  expect(pre.scrollLeft).toBe(1050);
  // Async highlighter replaces the inner text and resets a newly mounted pre.
  pre.innerHTML = "<code><span>prefix </span><span>Needle</span></code>";
  pre.scrollLeft = 0;
  paintSearchHighlights(container, hits, hits[0], false);
  expect(pre.scrollLeft).toBe(1050);
  vi.restoreAllMocks();
});

it("marks rendered Markdown text blocks without indexing link targets or syntax", () => {
  const { container } = render(
    <AgentMarkdown>
      {
        "A **phrase** bridge [label](https://NotVisibleSecret.test) and `a+b[0]`.\n\n```text\nCodeNeedle\n```"
      }
    </AgentMarkdown>,
  );
  const blocks = Array.from(
    container.querySelectorAll("[data-chat-search-block]"),
    (element): string => element.textContent ?? "",
  );
  expect(blocks).toEqual(["A phrase bridge label and a+b[0].", "CodeNeedle"]);
});

it("indexes literal case-insensitive rendered occurrences across all bubble history", () => {
  expect(search).toHaveProperty("searchMessages");
  const find = search.searchMessages;
  const messages: ChatMessage[] = [
    {
      id: "old",
      role: "user",
      content:
        "A **phrase** bridge [label](https://NotVisibleSecret.test) `a+b[0]` A+B[0]",
    },
    { id: "code", role: "agent", content: "```text\nCodeNeedle\n```" },
    { id: "reason", role: "agent", kind: "reasoning", text: "CodeNeedle" },
  ];
  expect(find(messages, "a+b[0]").map((hit): string => hit.messageId)).toEqual([
    "old",
    "old",
  ]);
  expect(find(messages, "PHRASE bridge")).toHaveLength(1);
  expect(find(messages, "NotVisibleSecret")).toEqual([]);
  expect(
    find(messages, "CodeNeedle").map((hit): string => hit.messageId),
  ).toEqual(["code"]);
  expect(find(messages, "")).toEqual([]);
  expect(find(messages, "**")).toEqual([]);
});

it("temporarily reveals long fenced code for the selected message", () => {
  const code =
    "```text\n" +
    Array.from({ length: 30 }, (_, index): string => `line ${index}`).join(
      "\n",
    ) +
    "\n```";
  const { container, rerender } = render(<AgentMarkdown>{code}</AgentMarkdown>);
  expect(container.querySelector(".chat-code-collapsed")).not.toBeNull();
  rerender(<AgentMarkdown {...{ searchActive: true }}>{code}</AgentMarkdown>);
  expect(container.querySelector(".chat-code-collapsed")).toBeNull();
  rerender(<AgentMarkdown>{code}</AgentMarkdown>);
  expect(container.querySelector(".chat-code-collapsed")).not.toBeNull();
});

it("keeps GFM list, table and diff offsets aligned with the displayed text", () => {
  const content =
    "- parent\n  - child **Needle**\n- Needle\n\n| Column | Value |\n| --- | --- |\n| Needle | `Needle` |\n\n```diff\n+first Needle\n-second Needle\n```";
  const { container } = render(<AgentMarkdown>{content}</AgentMarkdown>);
  const blocks = Array.from(
    container.querySelectorAll("[data-chat-search-block]"),
  );
  const hits = search.searchMessages(
    [{ id: "gfm", role: "user", content }],
    "Needle",
  );
  expect(hits).toHaveLength(6);
  for (const hit of hits) {
    expect(blocks[hit.blockIndex]?.textContent?.slice(hit.start, hit.end)).toBe(
      "Needle",
    );
  }
});

it("does not index machine notices, hidden compaction or media metadata", () => {
  const messages: ChatMessage[] = [
    {
      id: "process",
      role: "user",
      content: "[IMPORTANT: Background process Needle\nNeedle]",
    },
    {
      id: "compact",
      role: "user",
      content: "[CONTEXT COMPACTION — summary]\nNeedle",
    },
    {
      id: "image",
      role: "user",
      content: "![Needle](https://Needle.test/image.png)",
    },
    { id: "media", role: "agent", content: "MEDIA:/home/Needle.png" },
  ];
  expect(search.searchMessages(messages, "Needle")).toEqual([]);
});
