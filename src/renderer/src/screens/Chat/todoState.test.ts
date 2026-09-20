import { describe, expect, it } from "vitest";
import { todoFromEvent, todoFromMessages } from "./todoState";
import type { ChatMessage } from "./types";

function toolResult(id: string, name: string, content: string): ChatMessage {
  return {
    id,
    kind: "tool_result",
    role: "agent",
    callId: "c1",
    name,
    content,
  };
}

const SNAP = JSON.stringify({
  todos: [
    { id: "1", content: "First", status: "completed" },
    { id: "2", content: "Second", status: "in_progress" },
  ],
  revision: 3,
});

describe("todoFromMessages (issue #126)", () => {
  it("derives the latest todo_list snapshot from the transcript", () => {
    const messages: ChatMessage[] = [
      toolResult(
        "t1",
        "todo_list",
        JSON.stringify({
          todos: [{ id: "1", content: "Old", status: "pending" }],
          revision: 1,
        }),
      ),
      toolResult("t2", "terminal", "ok"),
      toolResult("t3", "todo_list", SNAP),
    ];
    const snap = todoFromMessages(messages);
    expect(snap?.revision).toBe(3);
    expect(snap?.items.map((i) => i.content)).toEqual(["First", "Second"]);
    expect(snap?.items[1].status).toBe("in_progress");
  });

  it("accepts the legacy todo alias", () => {
    const messages: ChatMessage[] = [toolResult("t1", "todo", SNAP)];
    expect(todoFromMessages(messages)?.revision).toBe(3);
  });

  it("returns null when the chat never used the todo tool", () => {
    const messages: ChatMessage[] = [toolResult("t1", "terminal", "ok")];
    expect(todoFromMessages(messages)).toBeNull();
  });

  it("skips malformed todo results and keeps scanning backwards", () => {
    const messages: ChatMessage[] = [
      toolResult("t1", "todo_list", SNAP),
      toolResult("t2", "todo_list", "not json at all"),
    ];
    expect(todoFromMessages(messages)?.revision).toBe(3);
  });

  it("normalizes unknown statuses to pending", () => {
    const messages: ChatMessage[] = [
      toolResult(
        "t1",
        "todo_list",
        JSON.stringify({ todos: [{ id: "1", content: "X", status: "weird" }] }),
      ),
    ];
    expect(todoFromMessages(messages)?.items[0].status).toBe("pending");
  });
});

describe("todoFromEvent (issue #126)", () => {
  it("parses a live todo.updated payload", () => {
    const snap = todoFromEvent({
      todos: [{ id: "1", content: "Run", status: "pending" }],
      revision: 2,
    });
    expect(snap?.items[0].content).toBe("Run");
    expect(snap?.revision).toBe(2);
  });

  it("returns null for malformed frames", () => {
    expect(todoFromEvent("nope")).toBeNull();
    expect(todoFromEvent({ todos: "not-a-list" })).toBeNull();
  });
});
