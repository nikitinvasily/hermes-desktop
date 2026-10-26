import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SidebarRecentSessions from "./SidebarRecentSessions";
import { markSessionViewed } from "./sessionReadState";

vi.mock("../../components/useI18n", () => {
  const t = (key: string): string => key;
  return { useI18n: () => ({ t }) };
});
const row = {
  id: "read-me",
  title: "Unread chat",
  unread: true,
  lastActivityAt: 10,
  contextFolder: "/project",
};
const markSessionRead = vi.fn(async (): Promise<boolean> => true);
const syncSessionCache = vi.fn(async (): Promise<(typeof row)[]> => [row]);
const listProjectGroupSessions = vi.fn(
  async (): Promise<Record<string, (typeof row)[]>> => ({}),
);
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function mount(): ReturnType<typeof render> {
  return render(
    <SidebarRecentSessions
      open
      connectionId="remote"
      activeProfile="writer"
      degraded={false}
      resyncNonce={0}
      currentSessionId={null}
      loadingSessionIds={new Set()}
      approvalSessionIds={new Set()}
      resumingSessionId={null}
      onSelect={vi.fn()}
      onNewChatInProject={vi.fn()}
      onSessionDeleted={vi.fn()}
      scrollRootRef={{ current: null }}
    />,
  );
}
function unread(): Element | null {
  return screen
    .getByText(row.title)
    .closest('[role="button"]')!
    .querySelector(".sidebar-recent-session-dot--unread");
}
beforeEach(() => {
  localStorage.clear();
  markSessionRead.mockReset().mockResolvedValue(true);
  syncSessionCache.mockReset().mockResolvedValue([row]);
  listProjectGroupSessions.mockReset().mockResolvedValue({});
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: {
      listCachedSessions: vi.fn(async () => [row]),
      syncSessionCache,
      markSessionRead,
      listProjectFolderNames: vi.fn(async () => ({})),
      listProjectGroupSessions,
      listProjects: vi.fn(async () => [
        {
          id: "p-project",
          name: "Project",
          primaryPath: "/project",
          folders: [{ path: "/project", isPrimary: true }],
        },
      ]),
      getConnectionRegistry: vi.fn(async () => ({
        connections: [],
        activeConnectionId: "remote",
      })),
    },
  });
});
// @lat: [[sidebar-navigation#Session read lifecycle]]
describe("session read lifecycle", () => {
  it.each(["Enter", " "])(
    "keyboard %s clears unread and durably marks the scoped session",
    async (key) => {
      const write = deferred<boolean>();
      markSessionRead.mockReturnValue(write.promise);
      mount();
      await screen.findByText(row.title);
      await act(async () => {});
      expect(unread()).not.toBeNull();
      fireEvent.keyDown(
        screen.getByText(row.title).closest('[role="button"]')!,
        { key },
      );
      expect(unread()).toBeNull();
      await waitFor(() =>
        expect(markSessionRead).toHaveBeenCalledWith(
          row.id,
          "remote",
          "writer",
        ),
      );
      syncSessionCache.mockResolvedValue([{ ...row, unread: false }]);
      await act(async () => write.resolve(true));
    },
  );
  it("rolls back optimistic unread on rejected or false writes", async () => {
    const write = deferred<boolean>();
    markSessionRead
      .mockReturnValueOnce(write.promise)
      .mockResolvedValueOnce(false);
    mount();
    await screen.findByText(row.title);
    await act(async () => {});
    fireEvent.click(screen.getByText(row.title));
    expect(unread()).toBeNull();
    await act(async () => write.reject(new Error("write failed")));
    expect(unread()).not.toBeNull();
    fireEvent.click(screen.getByText(row.title));
    await act(async () => {});
    expect(unread()).not.toBeNull();
  });
  it("rejects a stale refresh after read and permits later new activity", async () => {
    mount();
    await screen.findByText(row.title);
    await act(async () => {});
    const stale = deferred<(typeof row)[]>();
    syncSessionCache.mockReturnValueOnce(stale.promise);
    fireEvent(window, new CustomEvent("hermes-sessions-maybe-changed"));
    syncSessionCache.mockResolvedValue([{ ...row, unread: false }]);
    fireEvent.click(screen.getByText(row.title));
    await act(async () => {});
    await act(async () => stale.resolve([row]));
    expect(unread()).toBeNull();
    syncSessionCache.mockResolvedValue([{ ...row, lastActivityAt: 20 }]);
    fireEvent(window, new CustomEvent("hermes-sessions-maybe-changed"));
    await waitFor(() => expect(unread()).not.toBeNull());
  });
  it("preserves unread for project-tree-only rows and clears it on open", async () => {
    syncSessionCache.mockResolvedValue([]);
    listProjectGroupSessions.mockResolvedValue({ "/project": [row] });
    mount();
    await screen.findByText(row.title);
    await act(async () => {});
    expect(unread()).not.toBeNull();
    const write = deferred<boolean>();
    markSessionRead.mockReturnValue(write.promise);
    fireEvent.click(screen.getByText(row.title));
    expect(unread()).toBeNull();
    listProjectGroupSessions.mockResolvedValue({
      "/project": [{ ...row, unread: false }],
    });
    await act(async () => write.resolve(true));
    expect(unread()).toBeNull();
  });

  it("keeps another connection or profile's equal session ID unread", async () => {
    mount();
    await screen.findByText(row.title);
    await act(async () => {});
    await act(async () => {
      await markSessionViewed(row.id, "other-remote", "writer");
    });
    expect(unread()).not.toBeNull();
    await act(async () => {
      await markSessionViewed(row.id, "remote", "other-profile");
    });
    expect(unread()).not.toBeNull();
  });
  it("retains committed read state through a fresh sidebar mount", async () => {
    const first = mount();
    await screen.findByText(row.title);
    await act(async () => {});
    syncSessionCache.mockResolvedValue([{ ...row, unread: false }]);
    fireEvent.click(screen.getByText(row.title));
    await act(async () => {});
    first.unmount();
    mount();
    await screen.findByText(row.title);
    await act(async () => {});
    expect(unread()).toBeNull();
  });
});
