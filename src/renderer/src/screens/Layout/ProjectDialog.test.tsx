import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProjectDialog from "./ProjectDialog";
import type { ProjectInfo } from "../../../../shared/projects";

// ProjectDialog (issue #27): create/edit project dialog. Folder selection is
// a native picker on local connections and a text input on remote/ssh. These
// tests cover the mutation payloads and the local/remote input switch.

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string, opts?: Record<string, unknown>): string => {
      if (
        key === "navigation.projectDialog.deleteConfirm" ||
        key === "navigation.projectDialog.folderConflict"
      ) {
        return opts?.project ? `${key}:${String(opts.project)}` : key;
      }
      return key;
    },
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
      createDirectory: vi.fn(
        async (path: string): Promise<string> =>
          path.startsWith("~/")
            ? `/Users/test${path.slice(1)}`
            : `/remote${path.startsWith("/") ? "" : "/"}${path}`,
      ),
      resolvePath: vi.fn(
        async (path: string): Promise<string> =>
          path.startsWith("~/") ? `/home/hermes${path.slice(1)}` : path,
      ),
      readDirectory: vi.fn(
        async (
          path: string,
        ): Promise<{ name: string; isDirectory: boolean }[] | null> =>
          path === "~/.hermes/workspace"
            ? [
                { name: "proj-a", isDirectory: true },
                { name: "notes.txt", isDirectory: false },
              ]
            : path === "~"
              ? [
                  { name: "home", isDirectory: true },
                  { name: "file.txt", isDirectory: false },
                ]
              : null,
      ),
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
  it("remote mode starts the browser at the agent's workspace dir", async () => {
    renderDialog("create", "remote");
    // The initial load probes ~/.hermes/workspace and stays there.
    const entry = await screen.findByRole("button", { name: /proj-a/ });
    expect(entry).toBeTruthy();
    // Non-directories are filtered out of the browser list.
    expect(screen.queryByText("notes.txt")).toBeNull();
    // Manual input stays as the fallback path.
    expect(
      screen.getByPlaceholderText("navigation.projectDialog.pathPlaceholder"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "navigation.projectDialog.addFolder",
      }),
    ).toBeTruthy();
  });

  it("falls back to the agent's home when the workspace dir is absent", async () => {
    const entries = await window.hermesAPI.readDirectory("~/.hermes/workspace");
    expect(entries).not.toBeNull(); // stub has the workspace; override it
    (
      window.hermesAPI.readDirectory as ReturnType<typeof vi.fn>
    ).mockImplementation(async (path: string) =>
      path === "~" ? [{ name: "home", isDirectory: true }] : null,
    );
    renderDialog("create", "ssh");
    const entry = await screen.findByRole("button", { name: /home/ });
    expect(entry).toBeTruthy();
  });

  it("browser navigation adds the visited directory as a folder", async () => {
    const { onMutate } = renderDialog("create", "ssh");
    fireEvent.change(
      screen.getByLabelText("navigation.projectDialog.nameLabel"),
      { target: { value: "Remote Project" } },
    );
    const addCurrent = await screen.findByRole("button", {
      name: "navigation.projectDialog.addCurrent",
    });
    fireEvent.click(addCurrent);
    // The current browser path becomes the folder chip, resolved to the
    // agent-side absolute spelling.
    await waitFor(() => {
      expect(
        document.querySelector(".sidebar-project-dialog-folder-path")
          ?.textContent,
      ).toBe("/home/hermes/.hermes/workspace");
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.projectDialog.createAction",
      }),
    );
    await waitFor(() => {
      expect(onMutate).toHaveBeenCalledWith({
        op: "create",
        name: "Remote Project",
        folders: ["/home/hermes/.hermes/workspace"],
        primaryPath: "/home/hermes/.hermes/workspace",
      });
    });
  });

  it("creates a folder under the current browser path and adds it", async () => {
    renderDialog("create", "ssh");
    await screen.findByRole("button", { name: /proj-a/ });
    fireEvent.change(
      screen.getByPlaceholderText(
        "navigation.projectDialog.newFolderRemotePlaceholder",
      ),
      { target: { value: "brand-new" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.projectDialog.newFolder",
      }),
    );
    await waitFor(() => {
      expect(window.hermesAPI.createDirectory).toHaveBeenCalledWith(
        "~/.hermes/workspace/brand-new",
        undefined,
      );
    });
    await waitFor(() => {
      expect(
        document.querySelector(".sidebar-project-dialog-folder-path")
          ?.textContent,
      ).toBe("/Users/test/.hermes/workspace/brand-new");
    });
  });

  it("local mode shows the native picker button", () => {
    renderDialog("create", "local");
    expect(
      screen.queryByPlaceholderText("navigation.projectDialog.pathPlaceholder"),
    ).toBeNull();
  });
});

describe("ProjectDialog cross-project folder warning", () => {
  it("warns when a folder belongs to another project", async () => {
    const other: ProjectInfo = {
      id: "p_other",
      slug: "other",
      name: "Other Project",
      primaryPath: "/tmp/picked",
      folders: [{ path: "/tmp/picked", isPrimary: true }],
    };
    const onMutate = vi.fn(async () => undefined);
    render(
      <ProjectDialog
        state={{ mode: "create" }}
        connectionMode="local"
        onClose={vi.fn()}
        onMutate={onMutate}
        onChanged={vi.fn()}
        existingProjects={[other]}
      />,
    );
    fireEvent.change(
      screen.getByLabelText("navigation.projectDialog.nameLabel"),
      {
        target: { value: "Shares folder" },
      },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.projectDialog.addFolder",
      }),
    );
    await waitFor(() => {
      // The interpolated warning names the owning project.
      expect(
        screen.getByText(
          "navigation.projectDialog.folderConflict:Other Project",
        ),
      ).toBeTruthy();
    });
  });
});
