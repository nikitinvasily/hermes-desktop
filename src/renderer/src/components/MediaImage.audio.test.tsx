import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { AudioPlayer, MediaSegmentView } from "./MediaImage";
import type { MediaToken } from "../screens/Chat/mediaUtils";

vi.mock("./useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

/**
 * Inline audio player wiring (issue #132): local audio paths resolve through
 * the main process (`readMediaFile`), voice-styled rows for
 * `[[audio_as_voice]]` / incoming voice markers, and a plain player for
 * ordinary audio files. jsdom maps no ARIA role onto <audio>, so the
 * assertions key on the element/class instead.
 */

const dataUrl = "data:audio/ogg;base64,T2d0b3N0cmVhbQ==";

function stubApi(readResult: string | null): void {
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    writable: true,
    value: {
      readMediaFile: vi.fn(async (): Promise<string | null> => readResult),
      mediaFileExists: vi.fn(async (): Promise<boolean> => readResult !== null),
      saveMediaFile: vi.fn(async (): Promise<void> => undefined),
      showMediaMenu: vi.fn(),
    },
  });
}

function baseToken(overrides: Record<string, unknown> = {}): MediaToken {
  return {
    src: "/home/hermes/.hermes/cache/audio/tts_1.ogg",
    isUrl: false,
    isImage: false,
    isAudio: true,
    isVoice: false,
    isDocument: false,
    name: "tts_1.ogg",
    ...overrides,
  };
}

describe("AudioPlayer (issue #132)", () => {
  beforeEach(() => {
    stubApi(dataUrl);
  });

  it("resolves a local audio path and renders an audio element", async () => {
    render(<AudioPlayer token={baseToken()} />);
    await waitFor(() => {
      const audio = document.querySelector<HTMLAudioElement>(
        ".chat-audio-element",
      );
      expect(audio).toBeTruthy();
      expect(audio?.getAttribute("src")).toBe(dataUrl);
    });
  });

  it("renders the voice-message row when the token is a voice message", async () => {
    render(<AudioPlayer token={baseToken({ isVoice: true })} />);
    await waitFor(() =>
      expect(document.querySelector(".chat-voice-message")).toBeTruthy(),
    );
    expect(document.querySelector(".chat-voice-audio")).toBeTruthy();
    expect(document.querySelector(".chat-audio-message")).toBeNull();
  });

  it("shows the load failure state when the file cannot be read", async () => {
    stubApi(null);
    render(<AudioPlayer token={baseToken()} />);
    await waitFor(() =>
      expect(document.querySelector(".chat-media-error")).toBeTruthy(),
    );
  });

  it("renders a data: URL directly without an IPC round-trip", () => {
    const token = baseToken({
      src: dataUrl,
      isUrl: true,
      name: "clip.mp3",
    });
    render(<AudioPlayer token={token} />);
    expect(document.querySelector(".chat-audio-element")).toBeTruthy();
    const api = window as unknown as {
      hermesAPI: { readMediaFile: ReturnType<typeof vi.fn> };
    };
    expect(api.hermesAPI.readMediaFile).not.toHaveBeenCalled();
  });
});

describe("MediaSegmentView audio routing (issue #132)", () => {
  beforeEach(() => {
    stubApi(dataUrl);
  });

  it("routes a media-token audio segment to AudioPlayer", async () => {
    render(
      <MediaSegmentView
        token={baseToken()}
        raw="MEDIA:/home/hermes/.hermes/cache/audio/tts_1.ogg"
        source="media-token"
      />,
    );
    await waitFor(() =>
      expect(document.querySelector(".chat-audio-element")).toBeTruthy(),
    );
  });

  it("still routes non-media files to the download chip", () => {
    render(
      <MediaSegmentView
        token={{
          src: "/tmp/report.pdf",
          isUrl: false,
          isImage: false,
          isAudio: false,
          isVoice: false,
          isDocument: true,
          name: "report.pdf",
        }}
        raw="MEDIA:/tmp/report.pdf"
        source="media-token"
      />,
    );
    expect(document.querySelector(".chat-media-file")).toBeTruthy();
    expect(document.querySelector(".chat-audio-element")).toBeNull();
  });
});
