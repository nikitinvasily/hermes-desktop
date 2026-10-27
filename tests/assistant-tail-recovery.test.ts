import { describe, expect, it } from "vitest";
import { reconcileStreamedWithDb } from "../src/renderer/src/screens/Chat/sessionHistory";
import type {
  ChatBubbleMessage,
  ChatMessage,
} from "../src/renderer/src/screens/Chat/types";

const prefix =
  "A substantive assistant response with a stable paragraph. ".repeat(8);

function reconcile(
  streamed: string,
  canonical: string,
  role: "agent" | "user" = "agent",
): ChatBubbleMessage {
  const live: ChatMessage = { id: "live-row", role, content: streamed };
  const db: ChatMessage = {
    id: "db-10",
    role,
    content: canonical,
    timestamp: 12,
  };
  const merged = reconcileStreamedWithDb([live], [db]);
  expect(merged).toHaveLength(1);
  expect(merged[0].id).toBe("live-row");
  expect("timestamp" in merged[0] && merged[0].timestamp).toBe(12);
  return merged[0] as ChatBubbleMessage;
}

describe("canonical assistant tail recovery", () => {
  // @lat: [[chat-commands#Canonical database tail recovery#Incomplete matched assistant row]]
  it.each([" ", "\n\n", "\t"])(
    "adopts a substantive database continuation while retaining live identity (%j)",
    (separator) => {
      const streamed = prefix.replaceAll(" ", separator) + "The result is";
      const canonical =
        prefix +
        "The result is complete, including the missing final sentence.";
      expect(reconcile(streamed, canonical).content).toBe(canonical);
    },
  );

  it.each([" ", "\t", "\n"])(
    "retains the streamed word boundary instead of adopting a different word (%j)",
    (separator) => {
      const streamed = prefix + "The result is" + separator;
      const canonical =
        prefix + "The result island differs from the streamed word boundary.";
      expect(reconcile(streamed, canonical).content).toBe(streamed);
    },
  );

  it.each([" ", "\t", "\n"])(
    "recovers genuine continuations across trailing whitespace drift (%j)",
    (separator) => {
      const streamed =
        prefix.replaceAll(" ", separator) + "The result is" + separator;
      for (const canonicalSeparator of [" ", "\t", "\n\n"]) {
        const canonical =
          prefix + "The result is" + canonicalSeparator + "complete.";
        expect(reconcile(streamed, canonical).content).toBe(canonical);
      }
    },
  );

  it("recovers a mid-word continuation when the stream has no trailing separator", () => {
    const streamed = prefix + "The result is";
    const canonical = prefix + "The result island is complete.";
    expect(reconcile(streamed, canonical).content).toBe(canonical);
  });

  it.each([
    '\t<file name="notes.txt">attachment bytes</file>',
    "\n[screenshot]",
    " [image]",
  ])(
    "checks the readable streamed boundary before an attachment suffix (%j)",
    (wrapper) => {
      const streamed = prefix + "The result is" + wrapper;
      const divergent =
        prefix + "The result island differs from the streamed word boundary.";
      expect(reconcile(streamed, divergent).content).toBe(streamed);
      const continuation = prefix + "The result is\n\ncomplete.";
      expect(reconcile(streamed, continuation).content).toBe(continuation);
    },
  );

  it("does not invent a readable separator from a file wrapper's trailing whitespace", () => {
    const streamed =
      prefix + 'The result is<file name="notes.txt">bytes</file>\n';
    const canonical = prefix + "The result island is complete.";
    expect(reconcile(streamed, canonical).content).toBe(canonical);
  });

  // @lat: [[chat-commands#Canonical database tail recovery#Structural wrappers alone do not replace text]]
  it.each([
    '\n\n<file name="notes.txt" mime="text/plain">\nraw attachment bytes\n</file>',
    "\n[screenshot]",
    "\n[image]",
  ])(
    "keeps readable streamed text when the database adds only %j",
    (wrapper) => {
      const streamed = prefix + "Complete response.";
      expect(reconcile(streamed, streamed + wrapper).content).toBe(streamed);
    },
  );

  // @lat: [[chat-commands#Canonical database tail recovery#Divergent and shorter canonical rows do not overwrite]]
  it.each([
    [
      prefix + "Stream-specific ending.",
      prefix + "Different database ending that is longer.",
    ],
    [
      prefix + "Complete response with a later streamed sentence.",
      prefix + "Complete response",
    ],
  ])(
    "retains a divergent or more complete live reply",
    (streamed, canonical) => {
      expect(reconcile(streamed, canonical).content).toBe(streamed);
    },
  );

  // @lat: [[chat-commands#Canonical database tail recovery#User submissions retain their original content]]
  it("does not rewrite an optimistic user submission from a longer database record", () => {
    const streamed = prefix + "Original user request.";
    expect(
      reconcile(streamed, streamed + " Extra backend context.", "user").content,
    ).toBe(streamed);
  });

  it("preserves live metadata while adopting missing database attachments and content", () => {
    const live: ChatBubbleMessage = {
      id: "live",
      role: "agent",
      content: prefix,
      timestamp: 9,
      sealed: true,
    };
    const db: ChatBubbleMessage = {
      id: "db-1",
      role: "agent",
      content: prefix + "Recovered tail.",
      timestamp: 12,
      attachments: [
        {
          id: "file",
          kind: "text-file",
          name: "notes.txt",
          mime: "text/plain",
          size: 4,
          text: "note",
        },
      ],
    };
    const merged = reconcileStreamedWithDb([live], [db]);
    expect(merged).toEqual([
      { ...live, content: db.content, attachments: db.attachments },
    ]);
    expect(live.content).toBe(prefix);
    expect(live.attachments).toBeUndefined();
  });

  it("does not replace attachments already delivered by the stream", () => {
    const live: ChatBubbleMessage = {
      id: "live",
      role: "agent",
      content: prefix,
      attachments: [
        {
          id: "live-file",
          kind: "text-file",
          name: "live.txt",
          mime: "text/plain",
          size: 4,
          text: "live",
        },
      ],
    };
    const db: ChatBubbleMessage = {
      id: "db-1",
      role: "agent",
      content: prefix + "Recovered tail.",
      attachments: [
        {
          id: "db-file",
          kind: "text-file",
          name: "db.txt",
          mime: "text/plain",
          size: 2,
          text: "db",
        },
      ],
    };
    expect(reconcileStreamedWithDb([live], [db])).toEqual([
      { ...live, content: db.content },
    ]);
  });

  it.each([
    { localOnly: true },
    { error: "transport failure", localOnly: true },
  ])(
    "does not rewrite renderer-local or failed assistant content (%j)",
    (flags) => {
      const live: ChatBubbleMessage = {
        id: "local",
        role: "agent",
        content: prefix,
        ...flags,
      };
      const db: ChatMessage = {
        id: "db-1",
        role: "agent",
        content: prefix + "Recovered tail.",
      };
      const merged = reconcileStreamedWithDb([live], [db]);
      expect(merged.find((row) => row.id === live.id)).toBe(live);
      expect(live.content).toBe(prefix);
    },
  );

  it("retains turn order, tool identity and interactive card anchors during recovery", () => {
    const user: ChatMessage = { id: "user", role: "user", content: "Question" };
    const assistant: ChatMessage = {
      id: "assistant",
      role: "agent",
      content: prefix,
    };
    const clarify: ChatMessage = {
      id: "clarify",
      kind: "clarify",
      role: "agent",
      requestId: "srq-c",
      question: "Continue?",
      choices: ["Yes"],
    };
    const approval: ChatMessage = {
      id: "approval",
      kind: "approval",
      role: "agent",
      requestId: "srq-a",
      responsePath: "dashboard",
      command: "fixture",
      description: "Fixture approval",
      choices: ["once", "deny"],
    };
    const tool: ChatMessage = {
      id: "tool",
      kind: "tool_call",
      role: "agent",
      callId: "call-1",
      name: "fixture",
      args: "{}",
    };
    const after: ChatMessage = {
      id: "after",
      role: "agent",
      content: "Distinct follow-up response",
    };
    const merged = reconcileStreamedWithDb(
      [user, assistant, clarify, approval, tool, after],
      [
        { ...user, id: "db-user" },
        {
          ...assistant,
          id: "db-assistant",
          content: prefix + "Recovered tail.",
        },
        { ...tool, id: "db-tool" },
        { ...after, id: "db-after" },
      ],
    );
    expect(merged.map((row) => row.id)).toEqual([
      "user",
      "assistant",
      "clarify",
      "approval",
      "tool",
      "after",
    ]);
    expect(merged[1]).toEqual({
      ...assistant,
      content: prefix + "Recovered tail.",
    });
    expect(merged[2]).toBe(clarify);
    expect(merged[3]).toBe(approval);
    expect(merged[4]).toBe(tool);
  });
});
