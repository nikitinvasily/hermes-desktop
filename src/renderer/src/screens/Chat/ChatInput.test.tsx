import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import * as attachmentUtils from "./attachmentUtils";
import type { Attachment } from "../../../../shared/attachments";
import type { ChatInputHandle } from "./ChatInput";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HTMLAttributes, PropsWithChildren } from "react";

vi.mock("border-beam", () => ({
  BorderBeam: ({
    children,
    className,
    size,
    colorVariant,
    strength,
    theme,
    ...htmlProps
  }: PropsWithChildren<{
    className?: string;
    size?: string;
    colorVariant?: string;
    strength?: number;
    theme?: string;
  }> &
    HTMLAttributes<HTMLDivElement>) => (
    <div
      {...htmlProps}
      className={className}
      data-testid="chat-input-beam"
      data-size={size}
      data-color-variant={colorVariant}
      data-strength={strength}
      data-theme={theme}
    >
      {children}
    </div>
  ),
}));

// ChatInput pulls translations through useI18n (which requires the i18next
// provider). Stub it so the component can render in isolation; the keys are
// irrelevant to keyboard behavior.
vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

import { ChatInput } from "./ChatInput";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChatInput remote file reads", () => {
  const attachment: Attachment = {
    id: "binary-1",
    kind: "path-ref",
    name: "report.pdf",
    mime: "application/pdf",
    size: 3,
    dataUrl: "data:application/pdf;base64,YWJj",
  };

  it.each(["picker", "paste", "drop"])(
    "sends actual remote file bytes from %s",
    async (source) => {
      const ref = createRef<ChatInputHandle>();
      const onSubmit = vi.fn();
      render(
        <ChatInput
          ref={ref}
          isLoading={false}
          hasSession={false}
          remoteMode
          connectionId="remote-a"
          onSubmit={onSubmit}
          onQuickAsk={vi.fn()}
          onAbort={vi.fn()}
        />,
      );
      const file = new File(["abc"], "report.pdf", { type: "application/pdf" });
      const textarea = screen.getByPlaceholderText("chat.typeMessage");
      if (source === "picker") {
        fireEvent.change(document.querySelector('input[type="file"]')!, {
          target: { files: [file] },
        });
      } else if (source === "paste") {
        fireEvent.paste(textarea, {
          clipboardData: {
            items: [
              { kind: "file", type: file.type, getAsFile: (): File => file },
            ],
          },
        });
      } else {
        await act(async () => {
          await ref.current!.addFiles([file]);
        });
      }
      await waitFor(() =>
        expect(
          document.querySelector(".attachment-chip-name"),
        ).toHaveTextContent("report.pdf"),
      );
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(onSubmit).toHaveBeenCalledWith("", [
        expect.objectContaining({
          kind: "path-ref",
          name: "report.pdf",
          dataUrl: "data:application/pdf;base64,YWJj",
        }),
      ]);
      expect(onSubmit.mock.calls[0][1][0].path).toBeUndefined();
    },
  );

  it("keeps an Enter draft while a file is being read", async () => {
    let finish!: (value: attachmentUtils.ProcessFilesResult) => void;
    vi.spyOn(attachmentUtils, "processFiles").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const ref = createRef<ChatInputHandle>();
    const onSubmit = vi.fn();
    render(
      <ChatInput
        ref={ref}
        isLoading={false}
        hasSession={true}
        remoteMode
        connectionId="remote-a"
        profile="default"
        onSubmit={onSubmit}
        onQuickAsk={vi.fn()}
        onAbort={vi.fn()}
      />,
    );
    let pending!: Promise<attachmentUtils.AttachmentError[]>;
    act(() => {
      pending = ref.current!.addFiles([new File(["abc"], "report.pdf")]);
    });
    const textarea = screen.getByPlaceholderText(
      "chat.typeMessage",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "read this" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("read this");
    expect(document.querySelector(".chat-send-btn")).toBeDisabled();
    await act(async () => {
      finish({ attachments: [attachment], errors: [] });
      await pending;
    });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("read this", [attachment]);
  });

  it.each(["pending", "completed"])(
    "preserves a %s follow-up attachment on the first backend session assignment",
    async (readState) => {
      let finish!: (value: attachmentUtils.ProcessFilesResult) => void;
      vi.spyOn(attachmentUtils, "processFiles").mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const ref = createRef<ChatInputHandle>();
      const props = {
        runId: "run-a",
        isLoading: false,
        hasSession: false,
        sessionId: null as string | null,
        remoteMode: true,
        connectionId: "remote-a",
        profile: "default",
        onSubmit: vi.fn(),
        onQuickAsk: vi.fn(),
        onAbort: vi.fn(),
      };
      const { rerender } = render(<ChatInput ref={ref} {...props} />);
      let pending!: Promise<attachmentUtils.AttachmentError[]>;
      act(() => {
        pending = ref.current!.addFiles([new File(["abc"], "report.pdf")]);
      });
      const completeRead = async (): Promise<void> => {
        await act(async () => {
          finish({ attachments: [attachment], errors: [] });
          await pending;
        });
      };
      if (readState === "completed") await completeRead();
      rerender(
        <ChatInput ref={ref} {...props} hasSession sessionId="stored-a" />,
      );
      const textarea = screen.getByPlaceholderText("chat.typeMessage");
      fireEvent.change(textarea, { target: { value: "follow-up" } });
      if (readState === "pending") {
        fireEvent.keyDown(textarea, { key: "Enter" });
        expect(props.onSubmit).not.toHaveBeenCalled();
        expect(document.querySelector(".chat-send-btn")).toBeDisabled();
        await completeRead();
      }
      expect(document.querySelector(".attachment-chip-name")).toHaveTextContent(
        "report.pdf",
      );
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(props.onSubmit).toHaveBeenCalledWith("follow-up", [attachment]);
    },
  );

  it("clears completed attachments when the stable run changes", async () => {
    vi.spyOn(attachmentUtils, "processFiles").mockResolvedValueOnce({
      attachments: [attachment],
      errors: [],
    });
    const ref = createRef<ChatInputHandle>();
    const props = {
      isLoading: false,
      hasSession: false,
      remoteMode: true,
      connectionId: "remote-a",
      profile: "default",
      sessionId: null,
      onSubmit: vi.fn(),
      onQuickAsk: vi.fn(),
      onAbort: vi.fn(),
    };
    const { rerender } = render(
      <ChatInput ref={ref} {...props} runId="run-a" />,
    );
    await act(async () => {
      await ref.current!.addFiles([new File(["abc"], "report.pdf")]);
    });
    expect(document.querySelector(".attachment-chip")).not.toBeNull();
    rerender(<ChatInput ref={ref} {...props} runId="run-b" />);
    expect(document.querySelector(".attachment-chip")).toBeNull();
  });

  it.each(["connection", "profile", "run", "clear", "unmount"])(
    "ignores a delayed read after %s changes",
    async (change) => {
      let finish!: (value: attachmentUtils.ProcessFilesResult) => void;
      vi.spyOn(attachmentUtils, "processFiles").mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const ref = createRef<ChatInputHandle>();
      const props = {
        isLoading: false,
        hasSession: true,
        remoteMode: true,
        runId: "run-a",
        connectionId: "remote-a",
        profile: "default",
        onSubmit: vi.fn(),
        onQuickAsk: vi.fn(),
        onAbort: vi.fn(),
      };
      const { rerender, unmount } = render(<ChatInput ref={ref} {...props} />);
      let pending!: Promise<attachmentUtils.AttachmentError[]>;
      act(() => {
        pending = ref.current!.addFiles([new File(["abc"], "report.pdf")]);
      });
      if (change === "clear") act(() => ref.current!.clear());
      else if (change === "unmount") unmount();
      else {
        rerender(
          <ChatInput
            ref={ref}
            {...props}
            {...(change === "connection"
              ? { connectionId: "remote-b" }
              : change === "run"
                ? { runId: "run-b" }
                : { profile: "work" })}
          />,
        );
        rerender(<ChatInput ref={ref} {...props} />);
      }
      await act(async () => {
        finish({ attachments: [attachment], errors: [] });
        await pending;
      });
      expect(document.querySelector(".attachment-chip")).toBeNull();
    },
  );
});

function renderInput(
  slashCommands?: React.ComponentProps<typeof ChatInput>["slashCommands"],
): {
  onSubmit: ReturnType<typeof vi.fn>;
  textarea: HTMLTextAreaElement;
} {
  const onSubmit = vi.fn();
  render(
    <ChatInput
      isLoading={false}
      hasSession={true}
      onSubmit={onSubmit}
      onQuickAsk={vi.fn()}
      onAbort={vi.fn()}
      slashCommands={slashCommands}
    />,
  );
  const textarea = screen.getByPlaceholderText(
    "chat.typeMessage",
  ) as HTMLTextAreaElement;
  return { onSubmit, textarea };
}

describe("ChatInput — border beam", () => {
  // @lat: [[chat-input#Animated composer border#Uses the requested beam preset]]
  it("renders the requested border beam without clipping composer overlays", () => {
    const { textarea } = renderInput();
    const beam = screen.getByTestId("chat-input-beam");
    const shell = beam.parentElement;

    expect(beam.dataset.size).toBe("pulse-inner");
    expect(beam.dataset.colorVariant).toBe("mono");
    expect(beam.dataset.strength).toBe("0.7");
    expect(beam.dataset.theme).toBe("dark");
    expect(beam).toHaveAttribute("aria-hidden", "true");
    expect(beam.contains(textarea)).toBe(false);
    expect(shell).toHaveClass("chat-input-shell");
    expect(shell).toContainElement(textarea);
    expect(shell?.querySelector(".chat-input-toolbar")).not.toBeNull();
  });
});

describe("ChatInput model readiness", () => {
  it("keeps an immediate Enter draft until the selected agent model is ready", () => {
    const onSubmit = vi.fn();
    const props = {
      isLoading: false,
      hasSession: true,
      onSubmit,
      onQuickAsk: vi.fn(),
      onAbort: vi.fn(),
    };
    const { rerender } = render(
      <ChatInput
        {...props}
        readiness={{ ok: false, message: "Loading model" }}
      />,
    );
    const textarea = screen.getByPlaceholderText(
      "chat.typeMessage",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "immediate send" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("immediate send");
    rerender(<ChatInput {...props} readiness={{ ok: true }} />);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("immediate send", []);
  });
});

describe("ChatInput — CJK IME Enter handling", () => {
  // Repro: typing Korean (or any CJK IME), the final syllable stays in
  // composition. macOS Chromium can deliver the finalizing Enter as a plain
  // keydown (isComposing=false, keyCode=13) before compositionend commits the
  // last syllable, so submitting on that keydown sends a truncated message.
  it("does not submit while an IME composition is still active", () => {
    const { onSubmit, textarea } = renderInput();

    fireEvent.compositionStart(textarea);
    // State only holds what was committed so far — last syllable not yet in.
    fireEvent.change(textarea, { target: { value: "안녕하세" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // Must not fire — otherwise the truncated "안녕하세" goes out.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the full text after composition ends", () => {
    const { onSubmit, textarea } = renderInput();

    fireEvent.compositionStart(textarea);
    fireEvent.change(textarea, { target: { value: "안녕하세" } });
    fireEvent.keyDown(textarea, { key: "Enter" }); // swallowed: still composing

    // compositionend commits the last syllable; React flushes the full value.
    fireEvent.compositionEnd(textarea, { target: { value: "안녕하세요" } });
    fireEvent.change(textarea, { target: { value: "안녕하세요" } });
    fireEvent.keyDown(textarea, { key: "Enter" }); // now a real submit

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("안녕하세요", []);
  });
});

describe("ChatInput — slash command palette", () => {
  it("opens on slash and filters commands while typing", () => {
    const { textarea } = renderInput();

    fireEvent.change(textarea, { target: { value: "/" } });
    expect(
      screen.getByRole("dialog", { name: "chat.commandsTitle" }),
    ).toBeTruthy();
    expect(screen.getByText("agents")).toBeTruthy();

    fireEvent.change(textarea, { target: { value: "/lea" } });
    expect(screen.getByText("learn")).toBeTruthy();
    expect(screen.queryByText("agents")).toBeNull();
  });

  it("closes with Escape from anywhere in the modal while keeping the draft", () => {
    const { textarea } = renderInput();

    fireEvent.change(textarea, { target: { value: "/lea" } });
    const option = screen.getByRole("option", { name: /learn/i });
    option.focus();
    fireEvent.keyDown(option, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(textarea.value).toBe("/lea");
    expect(document.activeElement).toBe(textarea);
  });

  it("virtualizes large command catalogs", () => {
    const commands = Array.from({ length: 1_000 }, (_, index) => ({
      name: `/command-${index}`,
      description: `Command ${index}`,
      category: "agent" as const,
    }));
    const { textarea } = renderInput(commands);

    fireEvent.change(textarea, { target: { value: "/" } });

    expect(screen.getByText("1000 commands")).toBeTruthy();
    expect(screen.getAllByRole("option").length).toBeLessThan(30);
    expect(screen.getByText("command-0")).toBeTruthy();
    expect(screen.queryByText("command-999")).toBeNull();

    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(screen.getByText("command-999")).toBeTruthy();
    expect(screen.queryByText("command-0")).toBeNull();
  });
});
