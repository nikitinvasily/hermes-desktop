import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProjectDialog from "./ProjectDialog";
import type { ProjectInfo } from "../../../../shared/projects";

// ProjectDialog (issue #27): create/edit project dialog. Folder selection is
// a native picker on local connections and a text input on remote/ssh. These
// tests cover the mutation payloads and the local/remote input switch.

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string, opts?: Record<string, unknown>): string =>
      key === "navigation.projectDialog.deleteConfirm" && opts?.project
        ? `Delete ${String(opts.project)}?`
        : key,
  }),
}));

const project: ProjectInfo = {
  id: "p_test",
  slug: "test",
  name: "Test Project",
  primaryPath: "/tmp/test",
  folders: [
    { path: "/tmp/test", isPrimary: true },
    { path: "/tmp/other", isPrimary: false },
  ],
};

beforeEach(() => {
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    writable: true,
    value: {
      selectFolder: vi.fn(async () => "/tmp/picked"),
    },
  });
});

function renderDialog(
  mode: "create" | "edit",
  connectionMode: "local" | "remote" | "ssh",
): { onMutate: ReturnType<typeof vi.fn> } {
  const onMutate = vi.fn(async () => undefined);
  render(
    <ProjectDialog
      state={mode === "create" ? { mode } : { mode, project }}
      connectionMode={connectionMode}
      onClose={vi.fn()}
      onMutate={
        onMutate as unknown as (
          mutation: import("../../../../shared/projects").ProjectMutation,
        ) => Promise<unknown>
      }
      onChanged={vi.fn()}
    />,
  );
  return { onMutate };
}

describe("ProjectDialog create", () => {
  it("sends one create mutation with folders and primary path", async () => {
    const { onMutate } = renderDialog("create", "local");

    fireEvent.change(
      screen.getByLabelText("navigation.projectDialog.nameLabel"),
      {
        target: { value: "New Project" },
      },
    );
    // Local mode: Add folder opens the native picker (stubbed → /tmp/picked).
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.projectDialog.addFolder",
      }),
    );
    await waitFor(() => {
      expect(screen.getByText("/tmp/picked")).toBeTruthy();
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.projectDialog.createAction",
      }),
    );

    await waitFor(() => {
      expect(onMutate).toHaveBeenCalledWith({
        op: "create",
        name: "New Project",
        folders: ["/tmp/picked"],
        primaryPath: "/tmp/picked",
      });
    });
  });

  it("blocks submit without folders", () => {
    renderDialog("create", "local");
    fireEvent.change(
      screen.getByLabelText("navigation.projectDialog.nameLabel"),
      {
        target: { value: "No Folder" },
      },
    );
    const submit = screen.getByRole("button", {
      name: "navigation.projectDialog.createAction",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});

describe("ProjectDialog edit", () => {
  it("diffs folders into add/remove/set_primary mutations", async () => {
    const { onMutate } = renderDialog("edit", "local");

    // Rename + remove /tmp/other + make nothing else primary.
    fireEvent.change(
      screen.getByLabelText("navigation.projectDialog.nameLabel"),
      {
        target: { value: "Renamed" },
      },
    );
    const removeButtons = screen.getAllByRole("button", {
      name: "navigation.projectDialog.removeFolder",
    });
    // Second chip is /tmp/other.
    fireEvent.click(removeButtons[1]);
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.projectDialog.saveAction",
      }),
    );

    await waitFor(() => {
      const ops = onMutate.mock.calls.map((c) => c[0].op);
      expect(ops).toEqual(["update", "remove_folder"]);
      expect(onMutate.mock.calls[0][0]).toEqual({
        op: "update",
        id: "p_test",
        name: "Renamed",
      });
      expect(onMutate.mock.calls[1][0]).toEqual({
        op: "remove_folder",
        id: "p_test",
        path: "/tmp/other",
      });
    });
  });

  it("keeps primary on the first folder when the primary is removed", async () => {
    const { onMutate } = renderDialog("edit", "local");

    const removeButtons = screen.getAllByRole("button", {
      name: "navigation.projectDialog.removeFolder",
    });
    // Remove the primary (/tmp/test) — /tmp/other must take over as primary.
    fireEvent.click(removeButtons[0]);
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.projectDialog.saveAction",
      }),
    );

    await waitFor(() => {
      const ops = onMutate.mock.calls.map((c) => c[0].op);
      expect(ops).toEqual(["remove_folder", "set_primary"]);
      expect(onMutate.mock.calls[1][0]).toEqual({
        op: "set_primary",
        id: "p_test",
        path: "/tmp/other",
      });
    });
  });
});

describe("ProjectDialog folder input by connection mode", () => {
  it("remote mode shows a path text input instead of the picker", () => {
    renderDialog("create", "remote");
    expect(
      screen.getByPlaceholderText("navigation.projectDialog.pathPlaceholder"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "navigation.projectDialog.addFolder",
      }),
    ).toBeTruthy(); // the Add button stays, next to the input
  });

  it("local mode shows the native picker button", () => {
    renderDialog("create", "local");
    expect(
      screen.queryByPlaceholderText("navigation.projectDialog.pathPlaceholder"),
    ).toBeNull();
  });
});
