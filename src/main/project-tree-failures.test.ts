import { beforeEach, describe, expect, it, vi } from "vitest";
import { remoteProjectGroupSessions } from "./project-group-sessions";
import { remoteProjectFolderNames } from "./project-names";
import { remoteListProjects } from "./projects";
import { remoteRequestJson } from "./remote-sessions";

vi.mock("./remote-sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./remote-sessions")>()),
  remoteRequestJson: vi.fn(),
}));

const request = vi.mocked(remoteRequestJson);
const config = { remoteUrl: "http://127.0.0.1:9119", apiKey: "" };

beforeEach(() => {
  request.mockReset();
});

describe("project tree snapshot failure contract", () => {
  it.each([
    { name: "membership", load: remoteProjectGroupSessions },
    { name: "folder names", load: remoteProjectFolderNames },
    { name: "projects", load: remoteListProjects },
  ])(
    "$name rejects transport failures instead of publishing an empty snapshot",
    async ({ load }) => {
      // @lat: [[sidebar-navigation#Sidebar recent sessions#Connection recovery preserves browsing]]
      const error = new Error("net::ERR_BLOCKED_BY_CLIENT");
      request.mockRejectedValue(error);
      await expect(load(config)).rejects.toBe(error);
    },
  );

  it("still publishes an authoritative successful empty tree", async () => {
    request.mockResolvedValue({ projects: [] });
    await expect(remoteProjectGroupSessions(config)).resolves.toEqual({
      groups: new Map(),
    });
    await expect(remoteProjectFolderNames(config)).resolves.toEqual({});
    await expect(remoteListProjects(config)).resolves.toEqual([]);
  });
});
