import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModelConfig } from "./useModelConfig";
import { useDiscoveredModels } from "../../../hooks/useDiscoveredModels";

vi.mock("../../../hooks/useDiscoveredModels", () => ({
  useDiscoveredModels: vi.fn(() => ({
    models: [],
    status: "unsupported",
  })),
}));

vi.mock("../../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

interface SavedModel {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  createdAt: number;
}

function IdentityHarness({
  connectionId,
}: {
  connectionId?: string;
}): React.JSX.Element {
  const config = useModelConfig(undefined, connectionId);
  return (
    <output data-testid="identity">
      {JSON.stringify({
        model: config.currentModel,
        provider: config.currentProvider,
        display: config.displayModel,
        loading: config.isLoading,
      })}
    </output>
  );
}

function Harness(): React.JSX.Element {
  const { modelGroups } = useModelConfig();
  const labels = modelGroups.flatMap((group) =>
    group.models.map((model) => model.label),
  );
  return <output data-testid="models">{JSON.stringify(labels)}</output>;
}

// Exposes the grouping shape (header brand + each model's routing provider) so a
// test can assert brand grouping without changing routing.
function GroupHarness(): React.JSX.Element {
  const { modelGroups } = useModelConfig();
  const shape = modelGroups.map((g) => ({
    provider: g.provider,
    label: g.providerLabel,
    models: g.models.map((m) => ({ model: m.model, provider: m.provider })),
  }));
  return <output data-testid="groups">{JSON.stringify(shape)}</output>;
}

describe("useModelConfig", () => {
  let savedModels: SavedModel[];
  let emitModelLibraryChanged: (() => void) | null;

  beforeEach(() => {
    savedModels = [
      {
        id: "codex-gpt-55",
        name: "Codex CLI GPT-5.5",
        provider: "codex-cli",
        model: "gpt-5.5",
        baseUrl: "",
        createdAt: 1,
      },
    ];
    emitModelLibraryChanged = null;

    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        getModelConfig: vi.fn(async () => ({
          provider: "codex-cli",
          model: "gpt-5.5",
          baseUrl: "",
        })),
        listModels: vi.fn(async () => savedModels),
        getConnectionConfig: vi.fn(async () => ({ mode: "local" })),
        onConnectionConfigChanged: vi.fn(() => vi.fn()),
        onModelLibraryChanged: vi.fn((callback: () => void) => {
          emitModelLibraryChanged = callback;
          return vi.fn();
        }),
        setModelConfig: vi.fn(async () => true),
      },
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "hermesAPI");
  });

  it("publishes the current model without waiting for the library", async () => {
    const api = (
      window as unknown as {
        hermesAPI: { listModels: ReturnType<typeof vi.fn> };
      }
    ).hermesAPI;
    api.listModels.mockReturnValue(new Promise(() => {}));
    render(<IdentityHarness connectionId="local" />);
    await waitFor(() =>
      expect(screen.getByTestId("identity")).toHaveTextContent(
        '"model":"gpt-5.5"',
      ),
    );
    expect(screen.getByTestId("identity")).toHaveTextContent('"loading":false');
  });

  it("clears identity on a connection event before its replacement resolves", async () => {
    let emit: (config: { connectionId: string }) => void = () => {};
    const getModelConfig = vi.fn(async () => ({
      provider: "codex-cli",
      model: "local",
      baseUrl: "",
    }));
    const api = (window as unknown as { hermesAPI: Record<string, unknown> })
      .hermesAPI;
    api.getModelConfig = getModelConfig;
    api.onConnectionConfigChanged = (callback: typeof emit): (() => void) => {
      emit = callback;
      return () => {};
    };
    const { result } = renderHook(() => useModelConfig(undefined, "a"));
    await waitFor(() => expect(result.current.currentModel).toBe("local"));
    getModelConfig.mockReturnValue(new Promise(() => {}));
    act(() => emit({ connectionId: "a" }));
    expect(result.current.currentModel).toBe("");
    expect(result.current.displayModel).toBe("common.loading");
    expect(result.current.isLoading).toBe(true);
  });

  it("pins reads to the owning connection and ignores foreign broadcasts", async () => {
    let emit: (config: { connectionId: string }) => void = () => {};
    const api = (window as unknown as { hermesAPI: Record<string, unknown> })
      .hermesAPI;
    const getModelConfig = vi.fn(async () => ({
      provider: "custom",
      model: "local",
      baseUrl: "",
    }));
    const listModels = vi.fn(async () => savedModels);
    api.getModelConfig = getModelConfig;
    api.listModels = listModels;
    api.onConnectionConfigChanged = (callback: typeof emit): (() => void) => {
      emit = callback;
      return () => {};
    };
    const { result } = renderHook(() => useModelConfig("work", "local"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getModelConfig).toHaveBeenCalledWith("work", "local");
    expect(listModels).toHaveBeenCalledWith("local", "work");
    act(() => emit({ connectionId: "remote" }));
    expect(getModelConfig).toHaveBeenCalledTimes(1);
    expect(result.current.currentModel).toBe("local");
  });

  it("discards late model and library results across A-B-A and profile changes", async () => {
    type Identity = { provider: string; model: string; baseUrl: string };
    const modelResolvers: ((model: Identity) => void)[] = [];
    const libraryResolvers: ((models: SavedModel[]) => void)[] = [];
    const api = (window as unknown as { hermesAPI: Record<string, unknown> })
      .hermesAPI;
    api.getModelConfig = vi.fn(
      () => new Promise<Identity>((resolve) => modelResolvers.push(resolve)),
    );
    api.listModels = vi.fn(
      () =>
        new Promise<SavedModel[]>((resolve) => libraryResolvers.push(resolve)),
    );
    const { result, rerender } = renderHook(
      ({ id, profile }) => useModelConfig(profile, id),
      { initialProps: { id: "a", profile: "one" } },
    );
    rerender({ id: "b", profile: "one" });
    rerender({ id: "a", profile: "one" });
    await act(async () => {
      modelResolvers[2]({
        provider: "current",
        model: "new-a",
        baseUrl: "new-url",
      });
      libraryResolvers[2]([{ ...savedModels[0], name: "current library" }]);
    });
    await act(async () => {
      modelResolvers[0]({ provider: "stale", model: "old-a", baseUrl: "" });
      modelResolvers[1]({ provider: "stale", model: "old-b", baseUrl: "" });
      libraryResolvers[0]([{ ...savedModels[0], name: "stale library" }]);
      libraryResolvers[1]([]);
    });
    expect(result.current.currentModel).toBe("new-a");
    expect(result.current.currentProvider).toBe("current");
    expect(result.current.currentBaseUrl).toBe("new-url");
    expect(result.current.modelGroups[0].models[0].label).toBe(
      "current library",
    );
    rerender({ id: "a", profile: "two" });
    expect(result.current.currentModel).toBe("");
    expect(result.current.isLoading).toBe(true);
    await act(async () =>
      modelResolvers[3]({ provider: "profile-two", model: "two", baseUrl: "" }),
    );
    expect(result.current.currentModel).toBe("two");
  });

  it("keeps a session pick while the independent library resolves and refreshes", async () => {
    const api = (window as unknown as { hermesAPI: Record<string, unknown> })
      .hermesAPI;
    let resolveModels: (models: SavedModel[]) => void = () => {};
    api.listModels = vi.fn(
      () =>
        new Promise<SavedModel[]>((resolve) => {
          resolveModels = resolve;
        }),
    );
    const { result } = renderHook(() => useModelConfig(undefined, "a"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () =>
      result.current.selectModel("deepseek", "session", "", { persist: false }),
    );
    await act(async () => resolveModels(savedModels));
    expect(result.current.currentModel).toBe("session");
    expect(result.current.modelGroups.length).toBeGreaterThan(0);
    act(() => {
      emitModelLibraryChanged?.();
    });
    await act(async () => resolveModels(savedModels));
    expect(result.current.currentModel).toBe("session");
  });

  it("keeps model identity usable when the library request fails", async () => {
    const api = (
      window as unknown as {
        hermesAPI: { listModels: ReturnType<typeof vi.fn> };
      }
    ).hermesAPI;
    api.listModels.mockRejectedValue(new Error("library unavailable"));
    const { result } = renderHook(() => useModelConfig(undefined, "a"));
    await waitFor(() => expect(result.current.currentModel).toBe("gpt-5.5"));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.loadError).toBe("library unavailable");
  });

  it("does not mix local live discovery into a remote connection library", async () => {
    const api = (window as unknown as { hermesAPI: Record<string, unknown> })
      .hermesAPI;
    api.getConnectionConfig = vi.fn(async () => ({ mode: "remote" }));
    vi.mocked(useDiscoveredModels).mockClear();
    const { result } = renderHook(() => useModelConfig(undefined, "remote"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(
      vi
        .mocked(useDiscoveredModels)
        .mock.calls.every(([args]) => args.enabled === false),
    ).toBe(true);
  });

  it("reloads the chat picker when the model library changes", async () => {
    render(<Harness />);

    await waitFor(() => {
      expect(screen.getByTestId("models")).toHaveTextContent(
        "Codex CLI GPT-5.5",
      );
    });

    savedModels = [
      ...savedModels,
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        baseUrl: "",
        createdAt: 2,
      },
    ];

    await act(async () => {
      emitModelLibraryChanged?.();
    });

    await waitFor(() => {
      expect(screen.getByTestId("models")).toHaveTextContent("DeepSeek V4 Pro");
    });
  });

  it("groups a custom Hermes One model under the Hermes One brand while keeping custom routing", async () => {
    savedModels = [
      {
        id: "hs-swift",
        name: "hermesone-swift",
        provider: "custom",
        model: "hermesone-swift",
        baseUrl: "https://inference.hermesone.org/v1",
        createdAt: 1,
      },
    ];

    render(<GroupHarness />);

    await waitFor(() => {
      const groups = JSON.parse(
        screen.getByTestId("groups").textContent || "[]",
      );
      const hs = groups.find(
        (g: { label: string }) => g.label === "Hermes One",
      );
      expect(hs).toBeTruthy();
      // Not lumped under the generic OpenAI-compatible bucket.
      expect(hs.provider).toBe("hermesone");
      // Routing stays on `custom` + the base URL so the request still resolves.
      expect(hs.models[0]).toEqual({
        model: "hermesone-swift",
        provider: "custom",
      });
    });
  });
});
