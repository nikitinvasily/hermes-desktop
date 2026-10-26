import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseEnvelope } from "./envelopeUtils";
import {
  cleanLeakedToolTags,
  hasUserMediaHints,
  parseMediaTokens,
} from "./mediaUtils";
import type { ChatMessage } from "./types";
import type { Element, Root, RootContent } from "hast";

/** Shared rendered-text boundaries for the search index and Markdown DOM. */
export function rehypeSearchBlocks(): (tree: Root) => void {
  return (tree: Root): void => {
    let index = 0;
    const visit = (node: Root | RootContent, parent?: Root | Element): void => {
      if (node.type === "element") {
        const block =
          /^(p|h[1-6]|td|th)$/.test(node.tagName) ||
          (node.tagName === "code" &&
            parent?.type === "element" &&
            parent.tagName === "pre") ||
          (node.tagName === "li" &&
            !node.children.some(
              (child): boolean =>
                child.type === "element" && child.tagName === "p",
            ));
        if (block) node.properties["data-chat-search-block"] = String(index++);
      }
      if ("children" in node) {
        for (const child of node.children) visit(child, node);
      }
    };
    visit(tree);
  };
}

export interface MessageSearchHit {
  messageId: string;
  blockIndex: number;
  start: number;
  end: number;
}

export type MessageSearchCache = WeakMap<ChatMessage, string[]>;

function ownText(node: RootContent): string {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return "";
  // Zero-width in the DOM text walker, but never concatenate across media.
  if (node.tagName === "img") return "\u0000";
  return node.children
    .map((child): string =>
      child.type === "element" &&
      child.properties["data-chat-search-block"] !== undefined
        ? ""
        : ownText(child),
    )
    .join("");
}

function markdownBlocks(content: string): string[] {
  const blocks: string[] = [];
  // ReactMarkdown's synchronous parser has no hooks and does not mount the
  // returned element tree. Reuse its exact GFM -> HAST pipeline, not a second
  // Markdown-to-text regex/parser with different escaping/link semantics.
  Markdown({
    children: content,
    remarkPlugins: [remarkGfm],
    rehypePlugins: [
      rehypeSearchBlocks,
      () =>
        (tree: Root): void => {
          const visit = (node: Root | RootContent): void => {
            if (
              node.type === "element" &&
              node.properties["data-chat-search-block"] !== undefined
            ) {
              const text = ownText(node);
              blocks.push(
                node.tagName === "code" ? text.replace(/\n$/, "") : text,
              );
            }
            if ("children" in node)
              for (const child of node.children) visit(child);
          };
          visit(tree);
        },
    ],
  });
  return blocks;
}

function messageBlocks(message: ChatMessage): string[] {
  if (message.kind && message.kind !== "user" && message.kind !== "assistant")
    return [];
  if (!("content" in message) || message.isSlashLoader) return [];
  const envelope = parseEnvelope(message.content);
  if (envelope?.suppressBubble) return [];
  const content =
    message.role === "user" &&
    envelope?.kind === "out-of-band" &&
    envelope.userText
      ? envelope.userText
      : message.content;
  if (message.role === "agent" || hasUserMediaHints(content)) {
    return parseMediaTokens(cleanLeakedToolTags(content)).flatMap(
      (segment): string[] =>
        segment.type === "text" && segment.value.trim()
          ? markdownBlocks(segment.value)
          : [],
    );
  }
  return markdownBlocks(content);
}

// @lat: [[chat-search#In-session message search]]
export function searchMessages(
  messages: ChatMessage[],
  query: string,
  cache: MessageSearchCache = new WeakMap(),
): MessageSearchHit[] {
  if (!query) return [];
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(literal, "giu");
  const hits: MessageSearchHit[] = [];
  for (const message of messages) {
    let blocks = cache.get(message);
    if (!blocks) {
      blocks = messageBlocks(message);
      cache.set(message, blocks);
    }
    blocks.forEach((text, blockIndex): void => {
      let offset = 0;
      for (const segment of text.split("\u0000")) {
        for (const match of segment.matchAll(pattern)) {
          const start = offset + match.index;
          hits.push({
            messageId: message.id,
            blockIndex,
            start,
            end: start + match[0].length,
          });
        }
        offset += segment.length;
      }
    });
  }
  return hits;
}
