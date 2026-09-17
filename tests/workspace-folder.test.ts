import { describe, it, expect } from "vitest";
import {
  inferAgentHomes,
  isJunkWorkspaceFolder,
  filterDerivedWorkspaceFolders,
  type WorkspaceHomes,
} from "../src/main/workspace-folder";

const HOMES: WorkspaceHomes = {
  agentHome: "/home/hermes",
  hermesHome: "/home/hermes/.hermes",
};

describe("isJunkWorkspaceFolder", () => {
  it("flags the agent home and its parent, /, /home, /Users, HERMES_HOME", () => {
    expect(isJunkWorkspaceFolder("/home/hermes", HOMES)).toBe(true);
    expect(isJunkWorkspaceFolder("/home/hermes/", HOMES)).toBe(true);
    expect(isJunkWorkspaceFolder("/home", HOMES)).toBe(true);
    expect(isJunkWorkspaceFolder("/", HOMES)).toBe(true);
    expect(isJunkWorkspaceFolder("/Users", HOMES)).toBe(true);
    expect(isJunkWorkspaceFolder("/home/hermes/.hermes", HOMES)).toBe(true);
  });

  it("keeps real workspaces: HERMES_HOME descendants and unrelated dirs", () => {
    // Descendants of HERMES_HOME may be intentional workspaces (backend's
    // narrower cwd policy) — only equality is junk.
    expect(
      isJunkWorkspaceFolder("/home/hermes/.hermes/workspace/diy", HOMES),
    ).toBe(false);
    expect(isJunkWorkspaceFolder("/home/hermes/projects/andrei", HOMES)).toBe(
      false,
    );
    expect(
      isJunkWorkspaceFolder("/Users/me/Documents/Hermes/infrastructure", HOMES),
    ).toBe(false);
  });

  it("treats an empty folder as junk (falls to Chats)", () => {
    expect(isJunkWorkspaceFolder("", HOMES)).toBe(true);
    expect(isJunkWorkspaceFolder("   ", HOMES)).toBe(true);
  });

  it("is inert when homes are unknown (remote inference failed)", () => {
    const unknown: WorkspaceHomes = { agentHome: null, hermesHome: null };
    expect(isJunkWorkspaceFolder("/home/hermes", unknown)).toBe(false);
  });
});

describe("inferAgentHomes", () => {
  it("pins both homes from a /.hermes/workspace path", () => {
    expect(
      inferAgentHomes(["/home/hermes/.hermes/workspace/diy", null, 42]),
    ).toEqual({
      agentHome: "/home/hermes",
      hermesHome: "/home/hermes/.hermes",
    });
  });

  it("pins from a bare .hermes dir and from profiles paths", () => {
    expect(inferAgentHomes(["/home/hermes/.hermes"])).toEqual({
      agentHome: "/home/hermes",
      hermesHome: "/home/hermes/.hermes",
    });
    expect(
      inferAgentHomes(["/home/hermes/.hermes/profiles/nikvas/workspace/diy"]),
    ).toEqual({
      agentHome: "/home/hermes",
      hermesHome: "/home/hermes/.hermes",
    });
  });

  it("strict pass ignores an unrelated repo containing a .hermes folder", () => {
    expect(
      inferAgentHomes([
        "/srv/repo/.hermes/scratch",
        "/home/hermes/.hermes/workspace/trading",
      ]),
    ).toEqual({
      agentHome: "/home/hermes",
      hermesHome: "/home/hermes/.hermes",
    });
  });

  it("returns nulls when nothing looks like an agent path", () => {
    expect(inferAgentHomes(["/home/hermes", "/srv/data", null])).toEqual({
      agentHome: null,
      hermesHome: null,
    });
  });
});

describe("filterDerivedWorkspaceFolders", () => {
  const sessions = [
    { id: "s-home", contextFolder: "/home/hermes" },
    { id: "s-proj", contextFolder: "/home/hermes/.hermes/workspace/diy" },
    { id: "s-none", contextFolder: null },
    { id: "s-root", contextFolder: "/" },
  ];

  it("nulls junk folders, keeps real ones and nulls", () => {
    const out = filterDerivedWorkspaceFolders(sessions, HOMES);
    expect(out.find((s) => s.id === "s-home")?.contextFolder).toBeNull();
    expect(out.find((s) => s.id === "s-proj")?.contextFolder).toBe(
      "/home/hermes/.hermes/workspace/diy",
    );
    expect(out.find((s) => s.id === "s-none")?.contextFolder).toBeNull();
    expect(out.find((s) => s.id === "s-root")?.contextFolder).toBeNull();
  });

  it("spares a junk path owned by a known project", () => {
    const out = filterDerivedWorkspaceFolders(
      sessions,
      HOMES,
      new Set(["/home/hermes"]),
    );
    expect(out.find((s) => s.id === "s-home")?.contextFolder).toBe(
      "/home/hermes",
    );
  });

  it("does not mutate the input array", () => {
    filterDerivedWorkspaceFolders(sessions, HOMES);
    expect(sessions.find((s) => s.id === "s-home")?.contextFolder).toBe(
      "/home/hermes",
    );
  });
});
