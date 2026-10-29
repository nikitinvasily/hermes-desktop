import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DownloadProgress } from "../../../../shared/update-progress";
import { sharedI18n } from "../../../../shared/i18n";
import { useUpdateDownloadText } from "./useUpdateDownloadText";

vi.mock("../useI18n", () => ({
  useI18n: () => ({
    locale: "en",
    t: (key: string, values?: Record<string, unknown>) =>
      sharedI18n.t(key, values),
  }),
}));

// Synthetic renderer measurements only: no downloader, network or app update runs.
beforeEach(async () => {
  await sharedI18n.changeLanguage("en");
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

it("owns one activity deadline, ignores speed-only updates and recovers on measured movement", () => {
  const initial: { progress: DownloadProgress | null; downloading: boolean } = {
    progress: {
      percent: 25.25,
      transferred: 1024,
      total: 4096,
      bytesPerSecond: 512,
    },
    downloading: true,
  };
  const { result, rerender, unmount } = renderHook(
    ({ progress, downloading }) => useUpdateDownloadText(progress, downloading),
    { initialProps: initial },
  );
  expect(result.current.title).toBe("Downloading 25.3%");
  expect(vi.getTimerCount()).toBe(1);
  act(() => vi.advanceTimersByTime(10000));
  rerender({
    ...initial,
    progress: { ...initial.progress!, bytesPerSecond: 256 },
  });
  expect(vi.getTimerCount()).toBe(1);
  act(() => vi.advanceTimersByTime(5000));
  expect(result.current.title).toBe("Waiting for download progress...");
  expect(result.current.detail).toBe("1 KiB / 4 KiB");
  expect(vi.getTimerCount()).toBe(0);
  rerender({
    ...initial,
    progress: {
      percent: 50,
      transferred: 2048,
      total: 4096,
      bytesPerSecond: 1024,
    },
  });
  expect(result.current.title).toBe("Downloading 50%");
  expect(result.current.detail).toBe("2 KiB / 4 KiB · 1 KiB/s");
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("starts no idle timer and clears the deadline on completion or error", () => {
  const { result, rerender } = renderHook(
    ({ downloading }) => useUpdateDownloadText(null, downloading),
    { initialProps: { downloading: false } },
  );
  expect(vi.getTimerCount()).toBe(0);
  rerender({ downloading: true });
  expect(result.current.title).toBe("Downloading...");
  expect(result.current.title).not.toContain("0%");
  expect(vi.getTimerCount()).toBe(1);
  rerender({ downloading: false });
  expect(vi.getTimerCount()).toBe(0);
  rerender({ downloading: true });
  expect(vi.getTimerCount()).toBe(1);
});
