import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useShowMore } from "./useShowMore";

vi.mock("./useI18n", () => {
  const t = (k: string, opts?: { count?: number }): string =>
    opts?.count != null ? `${k} (${opts.count})` : k;
  return { useI18n: () => ({ t, locale: "en", setLocale: () => {} }) };
});

describe("useShowMore", () => {
  it("caps at the first chunk and reveals chunk-by-chunk", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const { result } = renderHook(() => useShowMore(items));
    expect(result.current.visible).toEqual([1, 2, 3, 4, 5]);
    expect(result.current.hiddenCount).toBe(7);
    act(() => result.current.showMore());
    expect(result.current.visible).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    act(() => result.current.showMore());
    expect(result.current.visible).toEqual(items);
    expect(result.current.hiddenCount).toBe(0);
  });

  it("resets to one chunk when resetKey goes false", () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) =>
        useShowMore([1, 2, 3, 4, 5, 6], { resetKey: open }),
      { initialProps: { open: true } },
    );
    act(() => result.current.showMore());
    expect(result.current.visible.length).toBe(6);
    rerender({ open: false });
    rerender({ open: true });
    expect(result.current.visible).toEqual([1, 2, 3, 4, 5]);
    expect(result.current.hiddenCount).toBe(1);
  });

  it("clamps when the source list shrinks", () => {
    const { result, rerender } = renderHook(
      ({ items }: { items: number[] }) => useShowMore(items),
      { initialProps: { items: [1, 2, 3, 4, 5, 6, 7, 8] as number[] } },
    );
    act(() => result.current.showMore());
    expect(result.current.visible.length).toBe(8);
    rerender({ items: [1, 2] });
    expect(result.current.visible).toEqual([1, 2]);
    expect(result.current.hiddenCount).toBe(0);
  });
});
