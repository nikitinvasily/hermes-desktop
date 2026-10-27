import { describe, expect, it, vi } from "vitest";
import toast from "react-hot-toast";
import {
  confirmSessionRename,
  type ConfirmSessionRenameOptions,
} from "./confirmSessionRename";
vi.mock("react-hot-toast", () => ({ default: { error: vi.fn() } }));

function options(): ConfirmSessionRenameOptions {
  return {
    sessionId: "session",
    value: "New title",
    currentTitle: "Original",
    inputRef: { current: null },
    isStillEditing: () => true,
    isCurrentContext: () => true,
    setSaving: vi.fn(),
    applyOptimistic: vi.fn(),
    rollback: vi.fn(),
    clearEditing: vi.fn(),
    fallbackErrorMessage: "Rename failed",
    upgradeRequiredErrorMessage:
      "Update Hermes Desktop, then retry the rename.",
    persist: vi.fn(async () => undefined),
  };
}

describe("confirmSessionRename", () => {
  it("shows localized update guidance for an IPC-wrapped upgrade rejection and permits retry", async () => {
    vi.mocked(toast.error).mockClear();
    vi.useFakeTimers();
    const input = document.createElement("input");
    document.body.append(input);
    const opts = {
      ...options(),
      inputRef: { current: input },
      upgradeRequiredErrorMessage:
        "Update Hermes Desktop, then retry the rename.",
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let title = opts.currentTitle;
    opts.applyOptimistic = vi.fn((value) => {
      title = value;
    });
    opts.rollback = vi.fn(() => {
      title = opts.currentTitle;
    });
    opts.persist = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'Error invoking remote method \'update-session-title\': RemoteOAuthError: Remote OAuth request failed (409): {"detail":"client_upgrade_required: this app is out of sync (different versions) with the Hermes backend; update the app to edit sessions"}',
        ),
      )
      .mockResolvedValue(undefined);
    try {
      expect(await confirmSessionRename(opts)).toBe("failed");
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(
        opts.upgradeRequiredErrorMessage,
      );
      expect(title).toBe("Original");
      expect(opts.clearEditing).not.toHaveBeenCalled();
      expect(opts.setSaving).toHaveBeenLastCalledWith(false);
      vi.runAllTimers();
      expect(document.activeElement).toBe(input);
      expect(await confirmSessionRename(opts)).toBe("saved");
      expect(title).toBe("New title");
    } finally {
      input.remove();
      errors.mockRestore();
      vi.useRealTimers();
    }
  });

  // @lat: [[sidebar-navigation#Sidebar recent sessions#Row context menu#Rename persistence#Overlapping rename protection]]
  it("allows only one save per editor and restores editing after a failed save", async () => {
    let reject!: (error: Error) => void;
    const opts = options();
    opts.persist = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const first = confirmSessionRename(opts);
    expect(opts.setSaving).toHaveBeenCalledWith(true);
    expect(
      await confirmSessionRename({ ...opts, value: "Another title" }),
    ).toBe("pending");
    expect(opts.persist).toHaveBeenCalledTimes(1);
    reject(new Error("Duplicate title"));
    expect(await first).toBe("failed");
    expect(opts.rollback).toHaveBeenCalledTimes(1);
    expect(opts.clearEditing).not.toHaveBeenCalled();
    expect(opts.setSaving).toHaveBeenLastCalledWith(false);
    expect(toast.error).toHaveBeenCalledWith("Duplicate title");
    opts.persist = vi.fn(async () => undefined);
    expect(await confirmSessionRename(opts)).toBe("saved");
    expect(opts.clearEditing).toHaveBeenCalledTimes(1);
  });

  it("does not roll back a different connection or profile after a late rejection", async () => {
    let reject!: (error: Error) => void;
    let current = true;
    const opts = options();
    opts.isCurrentContext = () => current;
    opts.persist = () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
    const save = confirmSessionRename(opts);
    current = false;
    reject(new Error("Connection changed"));
    expect(await save).toBe("failed");
    expect(opts.rollback).not.toHaveBeenCalled();
    expect(opts.clearEditing).not.toHaveBeenCalled();
  });

  it("keeps an unrelated editor open after a successful save", async () => {
    const opts = options();
    opts.isStillEditing = () => false;
    expect(await confirmSessionRename(opts)).toBe("saved");
    expect(opts.clearEditing).not.toHaveBeenCalled();
  });
});
