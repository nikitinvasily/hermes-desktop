import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalToggle } from "./ApprovalToggle";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        "chat.approvalToggle.label": "Toggle command approvals for this chat",
        "chat.approvalToggle.on":
          "Require approval for dangerous commands in this chat. Click to skip all approvals.",
        "chat.approvalToggle.off":
          "Approvals are skipped in this chat. Click to require approval again.",
        "chat.approvalToggle.activeLabel": "No approvals",
      })[key] ?? key,
  }),
}));

function renderToggle(
  yolo: boolean | null,
  onToggle: (enabled: boolean) => Promise<boolean> = vi.fn(async () => true),
): ReturnType<typeof render> {
  return render(<ApprovalToggle yolo={yolo} onToggle={onToggle} />);
}

describe("ApprovalToggle", () => {
  it("renders a plain shield when approvals are active (yolo=false)", () => {
    renderToggle(false);
    const btn = screen.getByRole("button", {
      name: "Toggle command approvals for this chat",
    });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText("No approvals")).toBeNull();
    expect(btn.textContent || btn.title).not.toContain("Approvals are skipped");
  });

  it("shows the highlighted state and label when the bypass is on (yolo=true)", () => {
    renderToggle(true);
    const btn = screen.getByRole("button", {
      name: "Toggle command approvals for this chat",
    });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("No approvals")).toBeTruthy();
    expect(btn.title).toContain("Approvals are skipped in this chat");
  });

  it("toggles off on click when active", async () => {
    const onToggle = vi.fn(async (): Promise<boolean> => true);
    renderToggle(true, onToggle);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Toggle command approvals for this chat",
      }),
    );
    await waitFor(() => expect(onToggle).toHaveBeenCalledWith(false));
  });

  it("toggles on on click when inactive", async () => {
    const onToggle = vi.fn(async (): Promise<boolean> => true);
    renderToggle(false, onToggle);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Toggle command approvals for this chat",
      }),
    );
    await waitFor(() => expect(onToggle).toHaveBeenCalledWith(true));
  });

  it("does not render the label while the state is unknown (yolo=null)", () => {
    renderToggle(null);
    expect(screen.queryByText("No approvals")).toBeNull();
  });
});
