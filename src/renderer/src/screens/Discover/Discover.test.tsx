import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/useI18n", () => {
  // Stable identity: the screens' load callbacks depend on `t`, so a fresh
  // `t` per render would retrigger their mount effects in a loop.
  const t = (key: string): string => key;
  return {
    useI18n: () => ({ t, locale: "en", setLocale: () => {} }),
  };
});

import Discover from "./Discover";

interface Conn {
  connectionId: string;
  mode: "local" | "remote" | "ssh";
  remoteUrl: string;
}

// Discover's INSTALLED set (skills / registry / agents) is per-connection
// data: the underlying IPCs have remote/ssh branches. A local/remote switch
// must reload it (issue #105); a same-connection event must not.
function installHermesAPI(): {
  listInstalledSkills: ReturnType<typeof vi.fn>;
  emitConnectionConfigChanged: (conn: Conn) => void;
} {
  let onConnectionChanged: ((conn: Conn) => void) | null = null;
  const listInstalledSkills = vi.fn(
    async (): Promise<unknown[]> => [{ name: "pdf" }],
  );
  const api = {
    listInstalledSkills,
    listInstalledRegistry: vi.fn(async () => ({
      skills: [],
      mcps: [],
      workflows: [],
    })),
    listProfiles: vi.fn(async () => [{ id: "work", name: "Work" }]),
    fetchRegistry: vi.fn(async () => ({
      skills: [],
      mcps: [],
      agents: [],
      workflows: [],
    })),
    listBundledSkills: vi.fn(async () => []),
    getConnectionConfig: vi.fn(async () => ({
      connectionId: "local-main",
      mode: "local",
      remoteUrl: "",
    })),
    onConnectionConfigChanged: vi.fn((callback: (c: Conn) => void) => {
      onConnectionChanged = callback;
      return () => {
        onConnectionChanged = null;
      };
    }),
  };
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: api,
  });
  return {
    listInstalledSkills,
    emitConnectionConfigChanged: (conn: Conn) => onConnectionChanged?.(conn),
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("Discover connection-switch reload (#105)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("reloads the installed set when the connection changes", async () => {
    const { listInstalledSkills, emitConnectionConfigChanged } =
      installHermesAPI();
    render(<Discover profile="work" visible />);
    await waitFor(() =>
      expect(listInstalledSkills.mock.calls.length).toBeGreaterThanOrEqual(1),
    );
    const before = listInstalledSkills.mock.calls.length;

    await act(async () => {
      emitConnectionConfigChanged({
        connectionId: "remote-a",
        mode: "remote",
        remoteUrl: "http://10.255.0.10:9119",
      });
    });
    await waitFor(() =>
      expect(listInstalledSkills.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it("does not reload when the same connection re-activates", async () => {
    const { listInstalledSkills, emitConnectionConfigChanged } =
      installHermesAPI();
    render(<Discover profile="work" visible />);
    await flush();
    await waitFor(() =>
      expect(listInstalledSkills.mock.calls.length).toBeGreaterThanOrEqual(1),
    );
    const before = listInstalledSkills.mock.calls.length;

    await act(async () => {
      emitConnectionConfigChanged({
        connectionId: "local-main",
        mode: "local",
        remoteUrl: "",
      });
    });
    await flush();
    expect(listInstalledSkills.mock.calls.length).toBe(before);
  });
});
