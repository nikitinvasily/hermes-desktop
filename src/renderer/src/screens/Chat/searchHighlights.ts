import type { MessageSearchHit } from "./searchMarkdown";

interface HighlightAPI {
  highlights: {
    get(name: string): unknown;
    set(name: string, value: unknown): void;
    delete(name: string): void;
  };
}

function textRange(block: Element, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node): number {
      return !node.parentElement?.closest("[data-chat-search-ignore]") &&
        node.parentElement?.closest("[data-chat-search-block]") === block
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start < offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return null;
}

/** Paint ranges, never wrap/mutate React-owned text nodes. Cleanup is owner-checked. */
export function paintSearchHighlights(
  root: HTMLElement,
  hits: MessageSearchHit[],
  selected: MessageSearchHit | undefined,
  scroll: boolean,
): () => void {
  const api = globalThis as unknown as {
    CSS?: HighlightAPI;
    Highlight?: new (...ranges: Range[]) => unknown;
  };
  const registry = api.CSS?.highlights;
  const Highlight = api.Highlight;
  const rows = new Map(
    Array.from(
      root.querySelectorAll<HTMLElement>("[data-chat-message-id]"),
      (row): [string, HTMLElement] => [row.dataset.chatMessageId ?? "", row],
    ),
  );
  const blocks = new Map<string, Element[]>();
  const ranges: Range[] = [];
  let selectedRange: Range | null = null;
  let selectedBlock: Element | undefined;
  for (const hit of hits) {
    let messageBlocks = blocks.get(hit.messageId);
    if (!messageBlocks) {
      messageBlocks = Array.from(
        rows.get(hit.messageId)?.querySelectorAll("[data-chat-search-block]") ??
          [],
      );
      blocks.set(hit.messageId, messageBlocks);
    }
    const block = messageBlocks[hit.blockIndex];
    if (!block) continue;
    const range = textRange(block, hit.start, hit.end);
    if (!range) continue;
    ranges.push(range);
    if (hit === selected) {
      selectedRange = range;
      selectedBlock = block;
    }
  }
  if (scroll && selectedRange && selectedBlock) {
    selectedBlock.scrollIntoView?.({ block: "center", behavior: "instant" });
    const rect = selectedRange.getBoundingClientRect?.();
    if (rect && rect.height) {
      const bounds = root.getBoundingClientRect();
      root.scrollTop += rect.top - bounds.top - root.clientHeight / 2;
    }
  }
  // Re-run on range rebinding too: async Prism can replace the nested scroller.
  // Start at the text, not the block wrapper, which contains the <pre>.
  if (selectedRange) {
    let element = selectedRange.startContainer.parentElement;
    while (element && element !== root) {
      if (
        element.scrollWidth > element.clientWidth &&
        /^(auto|scroll)$/.test(getComputedStyle(element).overflowX)
      ) {
        const rect = selectedRange.getBoundingClientRect?.();
        const bounds = element.getBoundingClientRect();
        const left = bounds.left + element.clientLeft;
        const right = left + element.clientWidth;
        if (rect && rect.right > right)
          element.scrollLeft += Math.ceil(rect.right - right);
        else if (rect && rect.left < left)
          element.scrollLeft += Math.floor(rect.left - left);
      }
      element = element.parentElement;
    }
  }
  if (!registry || !Highlight) return (): void => {};
  const all = new Highlight(...ranges);
  const current = new Highlight(...(selectedRange ? [selectedRange] : []));
  registry.set("chat-message-search", all);
  registry.set("chat-message-search-current", current);
  return (): void => {
    if (registry.get("chat-message-search") === all)
      registry.delete("chat-message-search");
    if (registry.get("chat-message-search-current") === current)
      registry.delete("chat-message-search-current");
  };
}
