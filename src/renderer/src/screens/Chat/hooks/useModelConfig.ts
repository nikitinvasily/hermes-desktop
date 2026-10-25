import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PROVIDERS, displayBrandFromConfig } from "../../../constants";
import { useDiscoveredModels } from "../../../hooks/useDiscoveredModels";
import { useI18n } from "../../../components/useI18n";
import type { ModelGroup } from "../types";

const OLLAMA_CLOUD_PROVIDER = "ollama-cloud";
const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";

/**
 * Named providers (deepseek, groq, anthropic, …) have a hardcoded canonical
 * base_url in hermes-agent's PROVIDER_REGISTRY, so a stored `baseUrl` on those
 * entries can be stale and would misroute the request. Keep the baseUrl only
 * for `custom` and `ollama-cloud` entries, where it is authoritative; clear it
 * otherwise so the backend falls back to the provider's canonical URL. Shared
 * by `selectModel` and the chat-screen session override so they can't drift.
 */
export function effectiveOverrideBaseUrl(
  provider: string,
  baseUrl: string,
): string {
  return provider === "custom" || provider === OLLAMA_CLOUD_PROVIDER
    ? baseUrl
    : "";
}

interface SavedModelForPicker {
  provider: string;
  model: string;
  name: string;
  baseUrl?: string;
}

function mergeLiveOllamaCloudModels(
  savedModels: SavedModelForPicker[],
  liveModels: string[],
  liveStatus: string,
): SavedModelForPicker[] {
  if (liveStatus !== "ok" || liveModels.length === 0) {
    return savedModels;
  }

  const liveEntries = Array.from(new Set(liveModels))
    .sort()
    .map((model) => ({
      provider: OLLAMA_CLOUD_PROVIDER,
      model,
      name: `Ollama Cloud · ${model}`,
      baseUrl: OLLAMA_CLOUD_BASE_URL,
    }));

  return [
    ...savedModels.filter((model) => model.provider !== OLLAMA_CLOUD_PROVIDER),
    ...liveEntries,
  ];
}

interface UseModelConfigResult {
  currentModel: string;
  currentProvider: string;
  currentBaseUrl: string;
  modelGroups: ModelGroup[];
  displayModel: string;
  /** Set when the last model/config load failed (remote down, auth expired,
   *  gateway error). Cleared on the next successful reload. Empty string
   *  when the library loaded fine but is simply empty. */
  loadError: string;
  isLoading: boolean;
  reload: () => Promise<void>;
  selectModel: (
    provider: string,
    model: string,
    baseUrl: string,
    options?: { persist?: boolean },
  ) => Promise<void>;
}

function groupModelsByProvider(models: SavedModelForPicker[]): ModelGroup[] {
  const groupMap = new Map<string, ModelGroup>();
  for (const m of models) {
    // Group by display brand so OpenAI-compatible providers stored as `custom`
    // (Hermes One, Groq, …) show under their own header instead of the generic
    // "OpenAI Compatible / Local" bucket. Each model keeps its raw provider +
    // baseUrl below so selection/routing is unchanged.
    const brand = displayBrandFromConfig(m.provider, m.baseUrl || "");
    if (!groupMap.has(brand)) {
      groupMap.set(brand, {
        provider: brand,
        providerLabel: PROVIDERS.labels[brand] || brand,
        models: [],
      });
    }
    groupMap.get(brand)!.models.push({
      provider: m.provider,
      model: m.model,
      label: m.name,
      baseUrl: m.baseUrl || "",
    });
  }
  return Array.from(groupMap.values());
}

// @lat: [[model-selection#Session model override#Connection-scoped loading]]
export function useModelConfig(
  profile?: string,
  connectionId?: string,
): UseModelConfigResult {
  const { t } = useI18n();
  const [currentModel, setCurrentModel] = useState("");
  const [currentProvider, setCurrentProvider] = useState("auto");
  const [currentBaseUrl, setCurrentBaseUrl] = useState("");
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([]);
  const [savedModels, setSavedModels] = useState<SavedModelForPicker[]>([]);
  const [loadError, setLoadError] = useState("");
  const loadSeqRef = useRef(0);
  const scope = JSON.stringify([connectionId, profile]);
  const [identityScope, setIdentityScope] = useState(scope);
  const [isLoading, setIsLoading] = useState(true);
  const selectionRef = useRef(false);
  const [localDiscoveryScope, setLocalDiscoveryScope] = useState<string | null>(
    null,
  );
  // Live discovery reads local credentials. Remote/SSH catalogs belong to the
  // selected server and must never be augmented with the Mac's models.
  useEffect(() => {
    if (!connectionId) return;
    let cancelled = false;
    void window.hermesAPI
      .getConnectionConfig(connectionId)
      .then((config) => {
        if (!cancelled)
          setLocalDiscoveryScope(config.mode === "local" ? scope : null);
      })
      .catch(() => {
        if (!cancelled) setLocalDiscoveryScope(null);
      });
    return (): void => {
      cancelled = true;
    };
  }, [connectionId, scope]);
  const allowLocalDiscovery = !connectionId || localDiscoveryScope === scope;

  const ollamaCloudDiscovery = useDiscoveredModels({
    provider: OLLAMA_CLOUD_PROVIDER,
    profile,
    enabled: allowLocalDiscovery,
  });

  const modelsForPicker = useMemo(
    () =>
      mergeLiveOllamaCloudModels(
        savedModels,
        allowLocalDiscovery ? ollamaCloudDiscovery.models : [],
        ollamaCloudDiscovery.status,
      ),
    [
      savedModels,
      ollamaCloudDiscovery.models,
      ollamaCloudDiscovery.status,
      allowLocalDiscovery,
    ],
  );

  const reload = useCallback(async (): Promise<void> => {
    const seq = ++loadSeqRef.current;
    setLoadError("");
    // The selected model is latency-critical; a slow library must not hold it up.
    await Promise.all([
      (async (): Promise<void> => {
        try {
          const mc = await window.hermesAPI.getModelConfig(
            profile,
            connectionId,
          );
          if (seq !== loadSeqRef.current || selectionRef.current) return;
          setIdentityScope(scope);
          setCurrentModel(mc.model);
          setCurrentProvider(mc.provider);
          setCurrentBaseUrl(mc.baseUrl);
        } catch (err) {
          if (seq !== loadSeqRef.current) return;
          setLoadError(err instanceof Error ? err.message : String(err));
        } finally {
          if (seq === loadSeqRef.current) setIsLoading(false);
        }
      })(),
      (async (): Promise<void> => {
        try {
          const models = await window.hermesAPI.listModels(
            connectionId,
            profile,
          );
          if (seq === loadSeqRef.current) setSavedModels(models);
        } catch (err) {
          if (seq === loadSeqRef.current) {
            setLoadError(err instanceof Error ? err.message : String(err));
          }
        }
      })(),
    ]);
  }, [profile, connectionId, scope]);

  // Initial load + reload whenever the profile changes (canonical
  // load-on-mount; setState happens inside `reload` via an awaited IPC call).
  useEffect(() => {
    selectionRef.current = false;
    setIdentityScope(scope);
    setCurrentModel("");
    setCurrentProvider("auto");
    setCurrentBaseUrl("");
    setSavedModels([]);
    setIsLoading(true);
    void reload();
    const sequence = loadSeqRef;
    return (): void => {
      ++sequence.current;
    };
  }, [reload, scope]);

  useEffect(() => {
    setModelGroups(groupModelsByProvider(modelsForPicker));
  }, [modelsForPicker]);

  useEffect(() => {
    return window.hermesAPI.onConnectionConfigChanged((config) => {
      if (connectionId && config.connectionId !== connectionId) return;
      if (!selectionRef.current) {
        setCurrentModel("");
        setCurrentProvider("auto");
        setCurrentBaseUrl("");
        setIsLoading(true);
      }
      setSavedModels([]);
      void reload();
    });
  }, [reload, connectionId]);

  useEffect(() => {
    return window.hermesAPI.onModelLibraryChanged(() => {
      void reload();
    });
  }, [reload]);

  const selectModel = useCallback(
    async (
      provider: string,
      model: string,
      baseUrl: string,
      { persist = true }: { persist?: boolean } = {},
    ): Promise<void> => {
      const effectiveBaseUrl = effectiveOverrideBaseUrl(provider, baseUrl);
      setIdentityScope(scope);
      setIsLoading(false);
      setCurrentModel(model);
      setCurrentProvider(provider);
      setCurrentBaseUrl(effectiveBaseUrl);
      // Session-only selection: update local state only, do not write to
      // config.yaml so the global default model is preserved (issue #688).
      // Keep the session pick across background config/library refreshes without
      // cancelling the independent model-library request.
      if (!persist) {
        selectionRef.current = true;
        return;
      }
      const seq = ++loadSeqRef.current;
      try {
        await window.hermesAPI.setModelConfig(
          provider,
          model,
          effectiveBaseUrl,
          profile,
        );
        const mc = await window.hermesAPI.getModelConfig(profile, connectionId);
        if (seq !== loadSeqRef.current) return;
        setCurrentModel(mc.model);
        setCurrentProvider(mc.provider);
        setCurrentBaseUrl(mc.baseUrl);
      } catch (err) {
        if (seq === loadSeqRef.current) await reload();
        throw err;
      }
    },
    [profile, connectionId, reload, scope],
  );

  const scopeMatches = identityScope === scope;
  const loading = !scopeMatches || isLoading;
  const displayModel = useMemo(
    () =>
      loading
        ? t("common.loading")
        : currentModel
          ? currentModel.split("/").pop() || currentModel
          : currentProvider === "auto"
            ? t("chat.auto")
            : t("chat.noModel"),
    [currentModel, currentProvider, loading, t],
  );

  return {
    currentModel: scopeMatches ? currentModel : "",
    currentProvider: scopeMatches ? currentProvider : "auto",
    currentBaseUrl: scopeMatches ? currentBaseUrl : "",
    modelGroups: scopeMatches ? modelGroups : [],
    displayModel,
    isLoading: loading,
    loadError,
    reload,
    selectModel,
  };
}
