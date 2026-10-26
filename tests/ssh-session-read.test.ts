import { describe, expect, it, vi } from "vitest";
import { markSshSessionRead } from "../src/main/ssh-session-read";

describe("SSH read watermark transport policy", () => {
  it("propagates an auto dashboard revision refusal without a legacy write", async () => {
    const refusal = new Error("409: revision_conflict");
    const dashboard = vi.fn(async (): Promise<boolean> => {
      throw refusal;
    });
    const legacy = vi.fn(async (): Promise<void> => {});

    await expect(markSshSessionRead("auto", dashboard, legacy)).rejects.toBe(
      refusal,
    );
    expect(dashboard).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
  });

  it.each(["auto", "dashboard"] as const)(
    "%s uses dashboard and preserves its result",
    async (transport) => {
      for (const result of [true, false]) {
        const dashboard = vi.fn(async (): Promise<boolean> => result);
        const legacy = vi.fn(async (): Promise<void> => {});

        await expect(
          markSshSessionRead(transport, dashboard, legacy),
        ).resolves.toBe(result);
        expect(dashboard).toHaveBeenCalledOnce();
        expect(legacy).not.toHaveBeenCalled();
      }
    },
  );

  it.each(
    (["auto", "dashboard"] as const).flatMap((transport) =>
      [
        "401: unauthorized",
        "403: forbidden",
        "404: not_found",
        "405: method_not_allowed",
        "409: client_upgrade_required",
        "500: server_error",
        "Dashboard setup unavailable",
        "SSH tunnel is not active.",
        "Request timed out",
      ].map((message) => ({ transport, message })),
    ),
  )(
    "$transport propagates $message without legacy fallback",
    async ({ transport, message }) => {
      const error = new Error(message);
      const dashboard = vi.fn(async (): Promise<boolean> => {
        throw error;
      });
      const legacy = vi.fn(async (): Promise<void> => {});

      await expect(
        markSshSessionRead(transport, dashboard, legacy),
      ).rejects.toBe(error);
      expect(dashboard).toHaveBeenCalledOnce();
      expect(legacy).not.toHaveBeenCalled();
    },
  );

  it("normalizes explicit legacy void success to true without dashboard setup", async () => {
    const dashboard = vi.fn(async (): Promise<boolean> => {
      throw new Error("Dashboard must not be acquired for legacy");
    });
    const legacy = vi.fn(async (): Promise<void> => {});

    await expect(markSshSessionRead("legacy", dashboard, legacy)).resolves.toBe(
      true,
    );
    expect(legacy).toHaveBeenCalledOnce();
    expect(dashboard).not.toHaveBeenCalled();
  });

  it("propagates explicit legacy failure rather than claiming success", async () => {
    const error = new Error("legacy write failed");
    const dashboard = vi.fn(async (): Promise<boolean> => true);
    const legacy = vi.fn(async (): Promise<void> => {
      throw error;
    });

    await expect(markSshSessionRead("legacy", dashboard, legacy)).rejects.toBe(
      error,
    );
    expect(legacy).toHaveBeenCalledOnce();
    expect(dashboard).not.toHaveBeenCalled();
  });
});
