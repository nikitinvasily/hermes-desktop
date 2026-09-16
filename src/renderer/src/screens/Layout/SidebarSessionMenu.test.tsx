import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SidebarSessionMenu from "./SidebarSessionMenu";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string): string =>
      key === "navigation.sessionMenu.copySessionId" ? "Copy session ID" : key,
  }),
}));

describe("SidebarSessionMenu", () => {
  it("offers a Copy session ID action for the selected row", () => {
    const onCopySessionId = vi.fn();

    render(
      <SidebarSessionMenu
        target={{
          id: "session-123",
          title: "Conversation",
          contextFolder: null,
          x: 20,
          y: 20,
        }}
        isPinned={false}
        projects={[]}
        onClose={vi.fn()}
        onTogglePin={vi.fn()}
        onRename={vi.fn()}
        onCopySessionId={onCopySessionId}
        onMoveToProject={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy session ID" }));

    expect(onCopySessionId).toHaveBeenCalledWith("session-123");
  });

  it("offers an Archive action for the selected row", () => {
    const onArchive = vi.fn();

    render(
      <SidebarSessionMenu
        target={{
          id: "session-456",
          title: "Conversation",
          contextFolder: null,
          x: 20,
          y: 20,
        }}
        isPinned={false}
        projects={[]}
        onClose={vi.fn()}
        onTogglePin={vi.fn()}
        onRename={vi.fn()}
        onCopySessionId={vi.fn()}
        onMoveToProject={vi.fn()}
        onArchive={onArchive}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("menuitem", { name: "navigation.sessionMenu.archive" }),
    );

    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it("lists loaded projects in the Move-to-project picker even with no sessions in them", () => {
    const onMoveToProject = vi.fn();

    render(
      <SidebarSessionMenu
        target={{
          id: "session-789",
          title: "Conversation",
          contextFolder: null,
          x: 20,
          y: 20,
        }}
        isPinned={false}
        projects={[
          { path: "/home/hermes/.hermes/workspace/agent-setup", name: "Setup" },
          { path: "/home/hermes/.hermes/workspace/diy", name: "DIY" },
        ]}
        onClose={vi.fn()}
        onTogglePin={vi.fn()}
        onRename={vi.fn()}
        onCopySessionId={vi.fn()}
        onMoveToProject={onMoveToProject}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "navigation.sessionMenu.moveToProject",
      }),
    );

    // Zero-session projects must appear in the picker (issue #36): the list
    // comes from the loaded projects, not only session-derived folders.
    const diyEntry = screen.getByRole("menuitem", { name: "DIY" });
    fireEvent.click(diyEntry);

    expect(onMoveToProject).toHaveBeenCalledWith(
      "/home/hermes/.hermes/workspace/diy",
    );
    expect(screen.getByRole("menuitem", { name: "Setup" })).toBeTruthy();
  });
});
