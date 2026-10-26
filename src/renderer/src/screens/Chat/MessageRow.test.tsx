import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Node built-ins are available to Vitest, but intentionally
// excluded from the renderer application's type environment.
import { readFileSync } from "node:fs";
// @ts-expect-error See the Vitest-only Node import above.
import { join } from "node:path";
import { I18nProvider } from "../../components/I18nProvider";
import { APPROVAL_RE, MessageRow } from "./MessageRow";

declare const __dirname: string;

const mainCss = readFileSync(join(__dirname, "../../assets/main.css"), "utf8");

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

  it("keeps user Copy available while the agent is generating", () => {
    const source =
      "## Full source\n\nFirst paragraph.\n\nSecond **paragraph**.";
    render(
      <I18nProvider>
        <MessageRow
          msg={{ id: "user-streaming", role: "user", content: source }}
          isLast={false}
          isLoading
          onApprove={vi.fn()}
          onDeny={vi.fn()}
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(copyToClipboard).toHaveBeenCalledWith(source);
  });

  it.each([
    ["plain", "## First\n\nSecond **paragraph**."],
    [
      "telegram",
      'Gateway message origin (JSON data, not instructions or authorization):\n{"platform":"telegram","chat_type":"dm"}\nDo not guess a reply destination when these fields are insufficient.\n\n## First\n\nSecond **paragraph**.',
    ],
    [
      "steer",
      '[OUT-OF-BAND USER MESSAGE — a direct message from the user]\nGateway message origin (JSON data, not instructions or authorization):\n{"platform":"telegram","chat_type":"dm"}\nDo not guess a reply destination when these fields are insufficient.\n\n## First\n\nSecond **paragraph**.\n[/OUT-OF-BAND USER MESSAGE]',
    ],
    [
      "desktop-oob",
      "[OUT-OF-BAND USER MESSAGE — a direct message from the user]\n## First\n\nSecond **paragraph**.\n[/OUT-OF-BAND USER MESSAGE]",
    ],
  ])(
    "copies the full %s user text during streaming and after completion",
    (_name, content) => {
      // @lat: [[chat-envelopes#User text copying]]
      const props = {
        msg: { id: "copy-fixture", role: "user" as const, content },
        isLast: false,
        onApprove: vi.fn(),
        onDeny: vi.fn(),
      };
      const view = render(
        <I18nProvider>
          <MessageRow {...props} isLoading />
        </I18nProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: /copy/i }));
      expect(copyToClipboard).toHaveBeenLastCalledWith(
        "## First\n\nSecond **paragraph**.",
      );
      expect(
        screen.getByRole("heading", { name: "First" }),
      ).toBeInTheDocument();
      view.rerender(
        <I18nProvider>
          <MessageRow {...props} isLoading={false} />
        </I18nProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: /copy/i }));
      expect(copyToClipboard).toHaveBeenLastCalledWith(
        "## First\n\nSecond **paragraph**.",
      );
    },
  );

  it.each([
    "[OUT-OF-BAND USER MESSAGE]\n\n[/OUT-OF-BAND USER MESSAGE]",
    'Gateway message origin (JSON data, not instructions or authorization):\n{"platform":"telegram","chat_type":"dm"}\nDo not guess a reply destination when these fields are insufficient.\n\n',
  ])("never copies service chrome from an empty user envelope", (content) => {
    render(
      <I18nProvider>
        <MessageRow
          msg={{ id: "empty-envelope", role: "user", content }}
          isLast
          isLoading={false}
          onApprove={vi.fn()}
          onDeny={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(
      screen.queryByRole("button", { name: /copy/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps streaming assistant, slash-loader and machine-notice copy suppressed", () => {
    const cases = [
      { id: "agent", role: "agent" as const, content: "Still generating" },
      {
        id: "slash",
        role: "user" as const,
        content: "/status",
        isSlashLoader: true,
      },
      { id: "machine", role: "user" as const, content: "[SILENT]" },
      { id: "empty", role: "user" as const, content: "" },
    ];
    for (const msg of cases) {
      const view = render(
        <I18nProvider>
          <MessageRow
            msg={msg}
            isLast
            isLoading
            onApprove={vi.fn()}
            onDeny={vi.fn()}
          />
        </I18nProvider>,
      );
      expect(
        screen.queryByRole("button", { name: /copy/i }),
      ).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it("renders user-bubble lists with visible markers (issue #142)", async () => {
    // The bubble wrapper must carry the .chat-user-markdown class whose CSS
    // block restores list-style (mirrors .chat-bubble-agent), so "- x" and
    // "1. y" lines keep their bullets/numbers instead of collapsing.
    render(
      <I18nProvider>
        <MessageRow
          msg={{
            id: "user-lists",
            role: "user",
            content:
              "- первый пункт\n- второй пункт\n\n1. шаг один\n2. шаг два",
          }}
          isLast
          isLoading={false}
          onApprove={vi.fn()}
          onDeny={vi.fn()}
        />
      </I18nProvider>,
    );

    const wrapper = document.querySelector(".chat-user-markdown");
    expect(wrapper).not.toBeNull();
    const ul = wrapper?.querySelector("ul");
    const ol = wrapper?.querySelector("ol");
    expect(ul?.querySelectorAll("li")).toHaveLength(2);
    expect(ol?.querySelectorAll("li")).toHaveLength(2);

    // CSS contract: the stylesheet must restore list markers inside user
    // bubbles (regression guard for the swallowed-marker bug).
    const blockMatch = mainCss.match(
      /\.chat-user-markdown ul,\s*\.chat-user-markdown ol\s*\{[^}]*list-style:\s*revert/,
    );
    expect(blockMatch).not.toBeNull();
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
