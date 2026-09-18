import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ArchiveDialog, { type ArchiveFilter } from "./ArchiveDialog";

// Interpolating mock (skill §9): composes options into the returned string so
// matchers on translated text assert the composed value, not the bare key.
vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string, opts?: Record<string, string>): string =>
      opts && "project" in opts ? `${key}:${opts.project}` : key,
  }),
}));

const listArchivedSessions = vi.fn<
  (
    limit?: number,
    offset?: number,
    connectionId?: string,
    profile?: string,
  ) => Promise<
    Array<{
      id: string;
      title: string | null;
      startedAt: number;
      contextFolder?: string | null;
    }>
  >
>();
const setSessionArchived = vi.fn(
  async (
    _id: string,
    _archived: boolean,
    _conn?: string,
    _profile?: string,
  ): Promise<boolean> => true,
);

beforeEach(() => {
  listArchivedSessions.mockReset();
  setSessionArchived.mockClear();
  (window as unknown as { hermesAPI: unknown }).hermesAPI = {
    listArchivedSessions,
    setSessionArchived,
  };
});

const ARCHIVED = [
  {
    id: "a-project",
    title: "Project chat",
    startedAt: 200,
    contextFolder: "/Users/x/work/repo",
  },
  {
    id: "a-unbound",
    title: "Loose chat",
    startedAt: 100,
    contextFolder: null,
  },
];

function renderDialog(filter?: ArchiveFilter, projectName?: string): void {
  render(
    <ArchiveDialog
      connectionId="conn-1"
      activeProfile="default"
      filter={filter}
      projectName={projectName}
      onRestored={vi.fn()}
      onOpen={vi.fn()}
      onDeleteRequest={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

function mockListArchived(): void {
  listArchivedSessions.mockResolvedValue(ARCHIVED);
}

describe("ArchiveDialog filters (issue #64)", () => {
  it("shows only the project's rows when filtered by folder", async () => {
    mockListArchived();
    renderDialog({ kind: "project", folder: "/Users/x/work/repo" }, "Repo");
    await waitFor(() => {
      expect(screen.getByText("Project chat")).toBeTruthy();
    });
    expect(screen.queryByText("Loose chat")).toBeNull();
    // Heading carries the project display name.
    expect(
      screen.getByText("navigation.archiveProjectTitle:Repo"),
    ).toBeTruthy();
  });

  it("shows only unbound rows in the unbound view (Chats icon)", async () => {
    mockListArchived();
    renderDialog({ kind: "unbound" });
    await waitFor(() => {
      expect(screen.getByText("Loose chat")).toBeTruthy();
    });
    expect(screen.queryByText("Project chat")).toBeNull();
    expect(screen.getByText("navigation.archiveUnboundTitle")).toBeTruthy();
  });

  it("shows everything in the default view", async () => {
    mockListArchived();
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText("Project chat")).toBeTruthy();
    });
    expect(screen.getByText("Loose chat")).toBeTruthy();
  });

  it("restores the clicked row (row click = restore AND open)", async () => {
    mockListArchived();
    const onOpen = vi.fn();
    render(
      <ArchiveDialog
        connectionId="conn-1"
        activeProfile="default"
        filter={{ kind: "unbound" }}
        onRestored={vi.fn()}
        onOpen={onOpen}
        onDeleteRequest={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Loose chat")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Loose chat"));
    await waitFor(() => {
      expect(setSessionArchived).toHaveBeenCalledWith(
        "a-unbound",
        false,
        "conn-1",
        "default",
      );
      expect(onOpen).toHaveBeenCalledWith("a-unbound");
    });
  });
});
