import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContextFolderChip } from "./ContextFolderChip";
import type { ProjectInfo } from "../../../../shared/projects";

// The chip fetches its project list through the preload bridge; stub the
// subset of window.hermesAPI it uses so no IPC happens in tests.
const listProjects = vi.fn(
  async (
    _connectionId: string,
    _profile?: string,
  ): Promise<ProjectInfo[]> => [],
);

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string): string => key,
  }),
}));

beforeEach(() => {
  listProjects.mockReset();
  listProjects.mockResolvedValue([]);
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    writable: true,
    value: { listProjects },
  });
});

function renderChip(
  props: Partial<Parameters<typeof ContextFolderChip>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <ContextFolderChip
      contextFolder={null}
      show
      worktreeVisible={false}
      connectionId="connection-main"
      onClearFolder={vi.fn()}
      onToggleWorktree={vi.fn()}
      onSelectFolder={vi.fn()}
      {...props}
    />,
  );
}

function openDropdown(): void {
  fireEvent.click(screen.getByTitle("chat.setContextFolder"));
}

describe("ContextFolderChip project dropdown (issue #29)", () => {
  it("lists projects and selects the primary folder on click", async () => {
    const onSelectFolder = vi.fn();
    listProjects.mockResolvedValue([
      {
        id: "p1",
        slug: "alpha",
        name: "Alpha",
        primaryPath: "/home/user/alpha",
        folders: [{ path: "/home/user/alpha", isPrimary: true }],
      },
    ]);
    renderChip({ onSelectFolder });

    openDropdown();
    const item = await screen.findByText("Alpha");
    fireEvent.click(item);

    expect(onSelectFolder).toHaveBeenCalledWith("/home/user/alpha");
  });

  it("marks the project whose folder matches the current cwd", async () => {
    listProjects.mockResolvedValue([
      {
        id: "p1",
        slug: "alpha",
        name: "Alpha",
        primaryPath: "/home/user/alpha",
        folders: [{ path: "/home/user/alpha", isPrimary: true }],
      },
      {
        id: "p2",
        slug: "beta",
        name: "Beta",
        primaryPath: "/home/user/beta",
        folders: [{ path: "/home/user/beta", isPrimary: true }],
      },
    ]);
    renderChip({ contextFolder: "/home/user/beta" });

    fireEvent.click(screen.getByTitle("chat.contextFolderActive"));
    await screen.findByText("Beta");
    const item = screen.getByText("Beta").closest("button");
    expect(item?.className).toContain("chat-ctxfolder-dropdown-item--active");
    const other = screen.getByText("Alpha").closest("button");
    expect(other?.className).not.toContain(
      "chat-ctxfolder-dropdown-item--active",
    );
  });

  it("disables projects without a primary folder", async () => {
    listProjects.mockResolvedValue([
      {
        id: "p1",
        slug: "ghost",
        name: "Ghost",
        primaryPath: null,
        folders: [],
      },
    ]);
    const onSelectFolder = vi.fn();
    renderChip({ onSelectFolder });

    openDropdown();
    const item = await screen.findByText("Ghost");
    expect((item.closest("button") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(item);
    expect(onSelectFolder).not.toHaveBeenCalled();
  });

  it("renders an empty dropdown when the list is empty", async () => {
    renderChip();

    openDropdown();
    // Give the listProjects promise a chance to resolve before asserting.
    await waitFor(() => expect(listProjects).toHaveBeenCalled());
    expect(screen.queryByText("Projects")).toBeNull();
  });

  it("renders an empty dropdown on load failure", async () => {
    listProjects.mockRejectedValue(new Error("ipc down"));
    renderChip();

    openDropdown();
    await waitFor(() => expect(listProjects).toHaveBeenCalled());
    expect(screen.queryByText("Projects")).toBeNull();
  });
});
