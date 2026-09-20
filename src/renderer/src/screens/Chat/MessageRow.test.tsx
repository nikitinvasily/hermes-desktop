import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../components/I18nProvider";
import { APPROVAL_RE, MessageRow } from "./MessageRow";

const copyToClipboard = vi.fn(async () => undefined);

describe("MessageRow user Markdown", () => {
  beforeEach(() => {
    copyToClipboard.mockClear();
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        copyToClipboard,
        openExternal: vi.fn(),
      },
    });
  });

  it("renders sent Markdown while copying its original source", async () => {
    const source = [
      "## Context",
      "",
      "- First requirement",
      "- Second requirement",
      "",
      "| Name | Value |",
      "|---|---|",
      "| Hermes | One |",
    ].join("\n");

    render(
      <I18nProvider>
        <MessageRow
          msg={{ id: "user-1", role: "user", content: source }}
          isLast
          isLoading={false}
          onApprove={vi.fn()}
          onDeny={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(
      screen.getByRole("heading", { name: "Context", level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("table")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(copyToClipboard).toHaveBeenCalledWith(source);
  });
});

describe("APPROVAL_RE detection of the legacy Approve/Deny bar", () => {
  it("matches a genuine dangerous-command header", () => {
    expect(
      APPROVAL_RE.test(
        "⚠️  DANGEROUS COMMAND: run removal\n      rm -rf /tmp/x\n      Choice [o/s/D]:",
      ),
    ).toBe(true);
  });

  it("matches a line-start /approve ... /deny instruction", () => {
    expect(
      APPROVAL_RE.test(
        "The agent is blocked.\n/approve to allow or /deny to stop.",
      ),
    ).toBe(true);
  });

  it("does not match inline backtick mentions of /approve and /deny (issue #113)", () => {
    // Live regression: a research report about the approval mechanism rendered
    // a spurious Approve/Deny bar because /approve.*\/deny matched mid-text.
    expect(
      APPROVAL_RE.test(
        "gateway-очередь (`_await_gateway_decision`): agent-поток блокируется на `threading.Event`, `/approve`/`/deny` из gateway, FIFO, `/approve all`, request_id, `/deny <reason>`",
      ),
    ).toBe(false);
  });

  it("does not match a multiline message with a stray ⚠️ far above the word dangerous", () => {
    expect(
      APPROVAL_RE.test(
        "⚠️ careful with config\nlots of text\nthis is dangerous",
      ),
    ).toBe(false);
  });
});
