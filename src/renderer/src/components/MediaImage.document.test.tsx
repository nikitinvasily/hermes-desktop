/**
 * DocumentCard tests (issue #134): gateway-delivered incoming documents
 * render as a document card, with a distinct "no longer available" state
 * when the file was cleaned up server-side.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { DocumentCard } from "./MediaImage";
import type { MediaToken } from "../screens/Chat/mediaUtils";

// Stable module-level t (see skill §9: a fresh arrow per render retriggers
// mount effects in loops).
vi.mock("./useI18n", () => {
  const t = (k: string): string => k;
  return { useI18n: () => ({ t, locale: "en", setLocale: () => {} }) };
});

function docToken(overrides: Partial<MediaToken> = {}): MediaToken {
  return {
    src: "/home/hermes/.hermes/cache/documents/doc_abc_report.pdf",
    isUrl: false,
    isImage: false,
    isAudio: false,
    isVoice: false,
    isDocument: true,
    name: "report.pdf",
    ...overrides,
  };
}

describe("DocumentCard (issue #134)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the document card with the original filename when the file exists", async () => {
    Object.defineProperty(window, "hermesAPI", {
      value: {
        mediaFileExists: vi.fn(async (): Promise<boolean> => true),
        saveMediaFile: vi.fn(async (): Promise<boolean> => true),
        showMediaMenu: vi.fn(),
      },
      configurable: true,
      writable: true,
    });
    await act(async () => {
      render(<DocumentCard token={docToken()} />);
    });
    const btn = screen.getByRole("button");
    expect(btn.textContent).toContain("report.pdf");
    expect(btn.className).toContain("chat-media-document");
    expect(
      (window as unknown as { hermesAPI: { mediaFileExists: ReturnType<typeof vi.fn> } })
        .hermesAPI.mediaFileExists,
    ).toHaveBeenCalledWith(docToken().src);
  });

  it("shows the gone state when the file no longer exists", async () => {
    Object.defineProperty(window, "hermesAPI", {
      value: {
        mediaFileExists: vi.fn(async (): Promise<boolean> => false),
        saveMediaFile: vi.fn(async (): Promise<boolean> => true),
        showMediaMenu: vi.fn(),
      },
      configurable: true,
      writable: true,
    });
    await act(async () => {
      render(<DocumentCard token={docToken()} />);
    });
    const err = document.querySelector(".chat-media-error");
    expect(err).toBeTruthy();
    expect(err?.textContent).toContain("report.pdf");
    expect(err?.textContent).toContain("chat.media.fileGone");
  });
});
