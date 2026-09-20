import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueuedMessages } from "./QueuedMessages";
import type { Attachment } from "../../../../shared/attachments";

vi.mock("../../components/useI18n", () => {
  // Stable module-level t: composes options into the returned string so
  // interpolated matchers work (skill §9 pattern).
  const t = (k: string, options?: Record<string, unknown>): string => {
    if (!options) return k;
    return Object.entries(options).reduce(
      (acc, [key, value]) => acc.replace(`{{${key}}}`, String(value)),
      k,
    );
  };
  return { useI18n: () => ({ t, locale: "en", setLocale: () => {} }) };
});

// Component test for the queue's "send now" affordance (issue #109 / TODO 3):
// each queued row exposes a send button that hands its index to the owner.

function renderQueue(
  messages: Array<{ text: string; attachments?: Attachment[] }>,
): {
  onSendNow: ReturnType<typeof vi.fn>;
  onRemove: ReturnType<typeof vi.fn>;
} {
  const onSendNow = vi.fn();
  const onRemove = vi.fn();
  render(
    <QueuedMessages
      messages={messages.map((m) => ({
        text: m.text,
        attachments: m.attachments ?? [],
      }))}
      onRemove={onRemove}
      onSendNow={onSendNow}
    />,
  );
  return { onSendNow, onRemove };
}

describe("QueuedMessages send-now button", () => {
  it("shows the send-now button on the collapsed single-row preview", () => {
    // @lat: [[chat-input#Queued message send-now]]
    const { onSendNow } = renderQueue([{ text: "only queued" }]);
    const button = screen.getByRole("button", { name: "chat.queuedSendNow" });
    fireEvent.click(button);
    expect(onSendNow).toHaveBeenCalledWith(0);
  });

  it("invokes onSendNow with the row index in the expanded list", () => {
    const { onSendNow } = renderQueue([
      { text: "first queued" },
      { text: "second queued" },
    ]);
    // Expand the collapsed count row to reach per-row buttons.
    fireEvent.click(screen.getByRole("button", { name: /chat\.queuedCount/ }));
    const buttons = screen.getAllByRole("button", {
      name: "chat.queuedSendNow",
    });
    expect(buttons.length).toBe(2);
    fireEvent.click(buttons[1]);
    expect(onSendNow).toHaveBeenCalledWith(1);
  });
});
