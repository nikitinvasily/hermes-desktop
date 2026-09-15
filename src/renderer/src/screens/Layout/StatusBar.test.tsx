import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string): string => key,
  }),
}));

import { StatusBar } from "./StatusBar";

interface RegistryConnection {
  connectionId: string;
  name: string;
  mode: "local" | "remote" | "ssh";
}

type RegistrySnapshot = Awaited<
  ReturnType<typeof window.hermesAPI.getConnectionRegistry>
>;

function makeRegistry(
  connections: RegistryConnection[],
  activeIndex = 0,
): RegistrySnapshot {
  return {
    version: 1 as const,
    activeConnectionId: connections[activeIndex]?.connectionId ?? "",
    connections: connections.map((c) => ({
      ...c,
      remoteUrl: "",
      remoteAuthMode: "auto" as const,
      remoteChatTransport: "auto" as const,
      sshChatTransport: "auto" as const,
      hasApiKey: false,
      apiKeyLength: 0,
      ssh: {
        host: "",
        port: 22,
        username: "",
        keyPath: "",
        remotePort: 0,
        localPort: 0,
      },
    })),
  };
}

function installHermesAPI(
  connections: RegistryConnection[],
  activeIndex = 0,
): ReturnType<typeof vi.fn> {
  const selectConnection = vi.fn().mockResolvedValue(true);
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: {
      listProfiles: vi.fn().mockResolvedValue([
        {
          id: "default",
          name: "default",
          isDefault: true,
          isActive: true,
          model: "test-model",
          skillCount: 3,
          gatewayRunning: true,
        },
      ]),
      getConnectionConfig: vi.fn().mockResolvedValue({
        connectionId: connections[activeIndex]?.connectionId ?? "",
        mode: connections[activeIndex]?.mode ?? "local",
      }),
      getConnectionRegistry: vi
        .fn()
        .mockResolvedValue(makeRegistry(connections, activeIndex)),
      selectConnection,
      onConnectionConfigChanged: vi.fn(() => () => {}),
    },
  });
  return selectConnection;
}

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: { process: { platform: "darwin" } },
  });
});

describe("StatusBar connection switcher", () => {
  it("renders a passive mode chip when only one connection is saved", async () => {
    installHermesAPI([{ connectionId: "c1", name: "Local", mode: "local" }]);

    render(<StatusBar activeProfile="default" />);

    await waitFor(() => {
      expect(screen.getByText("local")).toBeInTheDocument();
    });
    // No button — nothing to switch to, so the chip stays a plain span.
    expect(
      screen.queryByRole("button", { name: /local/ }),
    ).not.toBeInTheDocument();
  });

  it("opens the popover from the mode chip and switches connections", async () => {
    const selectConnection = installHermesAPI([
      { connectionId: "c1", name: "Local Machine", mode: "local" },
      { connectionId: "c2", name: "VPS Hub", mode: "ssh" },
    ]);

    render(<StatusBar activeProfile="default" />);

    const trigger = await screen.findByRole("button", { name: /local/ });
    fireEvent.click(trigger);

    const option = await screen.findByRole("menuitemradio", {
      name: /VPS Hub/,
    });
    fireEvent.click(option);

    await waitFor(() => {
      expect(selectConnection).toHaveBeenCalledWith("c2");
    });
  });

  it("does not call selectConnection when the active record is re-picked", async () => {
    const selectConnection = installHermesAPI([
      { connectionId: "c1", name: "Local Machine", mode: "local" },
      { connectionId: "c2", name: "VPS Hub", mode: "ssh" },
    ]);

    render(<StatusBar activeProfile="default" />);

    fireEvent.click(await screen.findByRole("button", { name: /local/ }));
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: /Local Machine/ }),
    );

    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    expect(selectConnection).not.toHaveBeenCalled();
  });

  it("closes the popover on Escape and on outside click", async () => {
    installHermesAPI([
      { connectionId: "c1", name: "Local Machine", mode: "local" },
      { connectionId: "c2", name: "VPS Hub", mode: "ssh" },
    ]);

    render(<StatusBar activeProfile="default" />);

    fireEvent.click(await screen.findByRole("button", { name: /local/ }));
    expect(await screen.findByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    // Reopen and close via the overlay (outside click).
    fireEvent.click(screen.getByRole("button", { name: /local/ }));
    const overlay = await screen.findByText("common.switchConnection", {
      selector: ".status-conn-header",
    });
    fireEvent.click(overlay.closest(".status-conn-overlay") as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });

  it("shows the SSH interruption warning when switching away from an SSH record", async () => {
    installHermesAPI(
      [
        { connectionId: "c1", name: "VPS Hub", mode: "ssh" },
        { connectionId: "c2", name: "Local Machine", mode: "local" },
      ],
      0,
    );

    render(<StatusBar activeProfile="default" />);

    fireEvent.click(await screen.findByRole("button", { name: /ssh/ }));
    expect(
      await screen.findByText("common.sshInterruptWarning"),
    ).toBeInTheDocument();
  });

  it("opens the switcher via Cmd+E when multiple connections exist", async () => {
    installHermesAPI([
      { connectionId: "c1", name: "Local Machine", mode: "local" },
      { connectionId: "c2", name: "VPS Hub", mode: "ssh" },
    ]);

    render(<StatusBar activeProfile="default" />);

    // Wait for the registry load that arms the hotkey.
    await screen.findByRole("button", { name: /local/ });
    fireEvent.keyDown(document, { key: "e", metaKey: true });

    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });
});
