import { useCallback, useEffect, useRef, useState } from "react";
import { LOCAL_PRESETS } from "../../../constants";
import {
  isBubbleMessage,
  markActiveTurnFailed,
  normalizeMessageText,
} from "../chatMessages";
import {
  applyDashboardStreamEvent,
  dashboardApprovalRequestId,
  type DashboardStreamEvent,
} from "../dashboardEventAdapter";
import { DashboardGatewayClient } from "../dashboardGatewayClient";
import { executeSlash, type SlashExecOutcome } from "../slashExec";
import {
  dbItemsToChatMessages,
  reconcileAfterDbRefresh,
  type DbHistoryItem,
} from "../sessionHistory";
import type { AgentCommandsCatalogResponse } from "../slash/types";
import type { ActiveTurn, Attachment, ChatMessage, UsageState } from "../types";
import type { DesktopSessionContinuationItem } from "../../../../../shared/session-continuation";
import {
  gatewayApprovalRequestId,
  normalizeApprovalRequest,
  type ApprovalChoice,
} from "../../../../../shared/chat-approval";

interface SessionResponse {
  info?: unknown;
  messages?: unknown[];
  message_count?: number;
  resumed?: string;
  /** True while the resumed session still has a live turn (issue #109). */
  running?: boolean;
  /** Gateway session status: "streaming" while a turn is in flight. */
  status?: string;
  session_id: string;
  stored_session_id?: string | null;
}

interface ModelOptionsResponse {
  model?: string;
  provider?: string;
  providers?: ModelOptionProvider[];
}

interface ModelOptionProvider {
  api_url?: string;
  base_url?: string;
  baseUrl?: string;
  is_current?: boolean;
  models?: string[];
  name?: string;
  slug: string;
}

interface SlashExecResponse {
  output?: string;
  warning?: string;
}

interface ImageAttachBytesResponse {
  attached?: boolean;
  message?: string;
  path?: string;
}

interface FileAttachResponse {
  attached?: boolean;
  message?: string;
  path?: string;
  ref_text?: string;
}

interface DashboardPromptClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

interface EnsureDashboardRuntimeSessionParams {
  client: DashboardPromptClient;
  contextFolder?: string | null;
  excludeSeedUserId?: string | null;
  forceCreate?: boolean;
  messages: ReadonlyArray<ChatMessage>;
  profile?: string;
  storedSessionId?: string | null;
}

interface EnsureDashboardRuntimeSessionResult {
  created: boolean;
  info?: unknown;
  /** True while the resumed session still has a live turn (issue #109). */
  running?: boolean;
  runtimeSessionId: string;
  storedSessionId: string;
}

interface UseDashboardChatTransportArgs {
  activeTurnRef: React.MutableRefObject<ActiveTurn | null>;
  connectionId?: string;
  connectionRevision?: number;
  contextFolder: string | null;
  connectionMode: DashboardConnectionMode;
  enabled: boolean;
  fallbackOnUnavailable: boolean;
  hermesSessionId: string | null;
  /** Write-through transcript ref from useTranscriptState — the synchronous
   *  source of truth this hook applies stream deltas to. Must be the same ref
   *  the provided `setMessages` maintains, or coalesced deltas can be lost. */
  messagesRef: React.MutableRefObject<ChatMessage[]>;
  model?: string;
  modelBaseUrl?: string;
  profile?: string;
  provider?: string;
  setHermesSessionId: (id: string) => void;
  setIsLoading: (loading: boolean) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setToolProgress: (tool: string | null) => void;
  setUsage: React.Dispatch<React.SetStateAction<UsageState | null>>;
  /** Called once per connection when the dashboard transport is found to be
   *  unavailable on a remote/SSH connection and the renderer is falling back to
   *  the legacy HTTP transport. Lets the UI surface a one-time notice. */
  onDashboardUnavailable?: (reason: string) => void;
  /** Live todo snapshot push (issue #126): fired on every `todo.updated`
   *  gateway event for this session so the chat context panel reflects the
   *  agent's task list while a turn runs. */
  onTodoState?: (snapshot: unknown) => void;
}

interface UseDashboardChatTransportResult {
  abort: () => void;
  enabled: boolean;
  /** True while a turn was retired as "continues on the agent" after a
   *  transport teardown (issue #76) and no resync has caught up yet. */
  hasDetachedTurn: boolean;
  /** True while this chat holds a pending command approval (issue #90). */
  hasPendingApproval: boolean;
  /** Catch the chat up after its transport was torn down mid-turn (issue
   *  #76): reconnect, resume the stored session (re-attaching the event
   *  stream of a still-running agent), and reconcile the transcript with
   *  state.db. No-op when there is nothing to resync. */
  resyncAfterDetach: () => Promise<void>;
  /** Whether the live session's approval guard is bypassed (session.info
   *  `yolo`: OR of the per-session flag, process env, approvals.mode=off).
   *  null = not known yet (no session.info seen for this session). */
  sessionYolo: boolean | null;
  /** Toggle the per-session approval bypass (config.set key=yolo,
   *  scope=session). Only affects the current chat; never persists. */
  toggleSessionYolo: (enabled: boolean) => Promise<boolean>;
  respondClarify: (
    requestId: string,
    answer: string,
    qid?: string,
  ) => Promise<boolean>;
  respondApproval: (
    requestId: string,
    choice: ApprovalChoice,
  ) => Promise<boolean>;
  sendMessage: (text: string, attachments?: Attachment[]) => Promise<boolean>;
  /**
   * Run a slash command through the gateway's `slash.exec` pipeline instead of
   * submitting it to the model as a literal prompt. `sys` renders command
   * output into the transcript; a `send` outcome hands an agent prompt back to
   * the caller so it can run a normal streaming turn.
   */
  execSlash: (
    command: string,
    sys: (text: string) => void,
  ) => Promise<SlashExecOutcome>;
  getCommandCatalog: () => Promise<AgentCommandsCatalogResponse>;
  /**
   * Launch a background (`/btw`, `/bg`, `/background`) prompt via the gateway's
   * `prompt.background` RPC. It runs a separate agent concurrently with the
   * main turn — so it never blocks or queues — and the answer arrives later as
   * a `background.complete` event rendered into the transcript.
   */
  runBackground: (text: string) => Promise<{ taskId?: string; error?: string }>;
}

interface PendingDashboardApproval {
  choices: ApprovalChoice[];
  gatewayRequestId: string | null;
  requestId: string;
  responding: boolean;
  sessionId: string;
}

interface DashboardSeedMessage {
  content: string;
  role: "assistant" | "user";
}

interface DashboardSeedOptions {
  excludeUserId?: string | null;
}

type DashboardConnectionMode = "local" | "remote" | "ssh";

export function dashboardChatEnabledFromEnv(
  value: string | undefined,
): boolean {
  return value !== "0" && value?.toLowerCase() !== "false";
}

export function dashboardChatEnabledForConnection(
  envValue: string | undefined,
  connectionModeLoaded: boolean,
  mode: "local" | "remote" | "ssh",
  preference: "auto" | "dashboard" | "legacy",
): boolean {
  if (!dashboardChatEnabledFromEnv(envValue) || !connectionModeLoaded) {
    return false;
  }
  if (preference === "legacy") return false;
  if (mode === "local") return true;
  if (mode === "remote") return true;
  return mode === "ssh";
}

export function dashboardShouldPersistLocalOverlays(
  _mode: DashboardConnectionMode,
): boolean {
  return true;
}

export function isDashboardSessionNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /session not found/i.test(message);
}

export function isDashboardSlashWorkerExitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /slash worker exited/i.test(message);
}

export async function submitDashboardPromptWithRecovery(
  client: DashboardPromptClient,
  params: {
    onRecoveredSessionId?: (sessionId: string) => void;
    canRecover?: () => boolean;
    sessionId: string;
    storedSessionId?: string | null;
    text: string;
    /** Scopes the turn to this profile on the UNIFIED machine dashboard. Without
     *  it, prompt.submit runs in the dashboard's launch profile (default), so a
     *  named profile's chat would answer as `default`. session create/resume
     *  already pass it; prompt.submit must too. */
    profile?: string;
  },
): Promise<string> {
  const profileParam =
    params.profile && params.profile !== "default"
      ? { profile: params.profile }
      : {};
  try {
    await client.request("prompt.submit", {
      session_id: params.sessionId,
      text: params.text,
      ...profileParam,
    });
    return params.sessionId;
  } catch (err) {
    if (
      params.canRecover?.() === false ||
      !params.storedSessionId ||
      !isDashboardSessionNotFoundError(err)
    ) {
      throw err;
    }

    const resumed = await client.request<SessionResponse>("session.resume", {
      session_id: params.storedSessionId,
      ...profileParam,
    });
    const recoveredSessionId = resumed?.session_id;
    if (!recoveredSessionId) {
      throw err;
    }

    params.onRecoveredSessionId?.(recoveredSessionId);
    await client.request("prompt.submit", {
      session_id: recoveredSessionId,
      text: params.text,
      ...profileParam,
    });
    return recoveredSessionId;
  }
}

export async function ensureDashboardRuntimeSession(
  params: EnsureDashboardRuntimeSessionParams,
): Promise<EnsureDashboardRuntimeSessionResult> {
  const cols = 96;
  const stored = params.forceCreate ? null : params.storedSessionId || null;

  if (stored) {
    try {
      const resumed = await params.client.request<SessionResponse>(
        "session.resume",
        {
          session_id: stored,
          cols,
          ...(params.profile ? { profile: params.profile } : {}),
        },
      );
      if (!resumed.session_id) {
        throw new Error("session.resume returned no session_id");
      }
      return {
        created: false,
        ...(resumed.info !== undefined ? { info: resumed.info } : {}),
        ...(resumed.running !== undefined ? { running: resumed.running } : {}),
        runtimeSessionId: resumed.session_id,
        storedSessionId: resumed.stored_session_id || resumed.resumed || stored,
      };
    } catch (err) {
      if (!isDashboardSessionNotFoundError(err)) {
        throw err;
      }
    }
  }

  const seedMessages = dashboardSeedMessagesFromTranscript(params.messages, {
    excludeUserId: params.excludeSeedUserId ?? null,
  });
  const created = await params.client.request<SessionResponse>(
    "session.create",
    {
      cols,
      ...(seedMessages.length > 0 ? { messages: seedMessages } : {}),
      ...(params.contextFolder ? { cwd: params.contextFolder } : {}),
      ...(params.profile ? { profile: params.profile } : {}),
    },
  );

  return {
    created: true,
    ...(created.info !== undefined ? { info: created.info } : {}),
    runtimeSessionId: created.session_id,
    storedSessionId: created.stored_session_id || created.session_id,
  };
}

export function dashboardModelCommand(
  provider: string | undefined,
  model: string | undefined,
): string | null {
  if (!provider || provider === "auto" || !model) return null;
  return `/model ${model} --provider ${provider}`;
}

function normalizeBaseUrl(value: string | undefined): string {
  return (value || "").trim().replace(/\/+$/, "").toLowerCase();
}

function providerBaseUrl(provider: ModelOptionProvider): string {
  return provider.api_url || provider.base_url || provider.baseUrl || "";
}

function modelIsListedByProvider(
  provider: ModelOptionProvider,
  model: string,
): boolean {
  return (provider.models ?? []).some((candidate) => candidate === model);
}

function builtInProviderForCustomBaseUrl(
  requestedBaseUrl: string,
  requestedModel: string,
  live: ModelOptionsResponse | null | undefined,
): string | null {
  const normalizedBaseUrl = normalizeBaseUrl(requestedBaseUrl);
  if (!normalizedBaseUrl) return null;

  const preset = LOCAL_PRESETS.find(
    (candidate) => normalizeBaseUrl(candidate.baseUrl) === normalizedBaseUrl,
  );
  if (!preset) return null;

  const provider = (live?.providers ?? []).find(
    (candidate) => candidate.slug === preset.id,
  );
  if (!provider || !modelIsListedByProvider(provider, requestedModel)) {
    return null;
  }

  return preset.id;
}

function modelOptionsSummary(
  live: ModelOptionsResponse | null | undefined,
): string {
  const providers = live?.providers ?? [];
  const custom = providers
    .filter((provider) => provider.slug?.toLowerCase().startsWith("custom:"))
    .slice(0, 8)
    .map((provider) => {
      const models = (provider.models ?? []).slice(0, 3).join(", ");
      const modelSuffix = models ? ` models=[${models}]` : "";
      const url = normalizeBaseUrl(providerBaseUrl(provider));
      const urlSuffix = url ? ` url=${url}` : "";
      return `${provider.slug}${urlSuffix}${modelSuffix}`;
    });

  return custom.length ? custom.join("; ") : "no custom providers listed";
}

function base64FromDataUrl(dataUrl: string | undefined): string {
  if (!dataUrl) return "";
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : "";
}

function safeAttachmentFilename(
  name: string | undefined,
  index: number,
): string {
  const trimmed = (name || "").trim();
  return trimmed || `image-${index + 1}.png`;
}

function safeFileAttachmentName(attachment: Attachment, index: number): string {
  const trimmed = (attachment.name || "").trim();
  if (trimmed) return trimmed;
  return `attachment-${index + 1}`;
}

function base64EncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function dashboardDataUrlForTextAttachment(
  attachment: Attachment,
): string | null {
  if (attachment.kind !== "text-file" || typeof attachment.text !== "string") {
    return null;
  }
  const mime = attachment.mime || "text/plain";
  return `data:${mime};base64,${base64EncodeUtf8(attachment.text)}`;
}

function dashboardAttachmentUnsupportedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unknown method|method not found|not found|unsupported/i.test(message);
}

export function dashboardPromptTextForAttachments(
  text: string,
  attachments?: Attachment[],
): string | null {
  if (!attachments?.length) return text;
  const supported = attachments.every(
    (attachment) =>
      attachment.kind === "image" ||
      attachment.kind === "text-file" ||
      attachment.kind === "path-ref",
  );
  if (!supported) return null;
  const images = attachments.filter(
    (attachment) => attachment.kind === "image",
  );
  if (images.some((image) => !base64FromDataUrl(image.dataUrl))) return null;
  const files = attachments.filter((attachment) => attachment.kind !== "image");
  const hasAttachableFiles = files.every((attachment) => {
    if (attachment.kind === "text-file") {
      return typeof attachment.text === "string";
    }
    return attachment.kind === "path-ref" && !!attachment.path;
  });
  if (!hasAttachableFiles) return null;
  if (text.trim()) return text;
  return images.length > 0 ? "What do you see in this image?" : "";
}

export function dashboardPromptTextWithAttachmentRefs(
  text: string,
  refs: string[],
): string {
  return [refs.join("\n").trim(), text.trim()].filter(Boolean).join("\n\n");
}

export async function syncDashboardAttachmentsForSubmit(
  client: DashboardPromptClient,
  sessionId: string,
  attachments?: Attachment[],
): Promise<{ handled: boolean; refs: string[] }> {
  const images = (attachments ?? []).filter(
    (attachment) => attachment.kind === "image",
  );
  const files = (attachments ?? []).filter(
    (attachment) => attachment.kind !== "image",
  );
  if (images.length === 0 && files.length === 0) {
    return { handled: true, refs: [] };
  }

  let attachedCount = 0;
  for (let index = 0; index < images.length; index++) {
    const image = images[index];
    const contentBase64 = base64FromDataUrl(image.dataUrl);
    if (!contentBase64) return { handled: false, refs: [] };

    try {
      const result = await client.request<ImageAttachBytesResponse>(
        "image.attach_bytes",
        {
          session_id: sessionId,
          content_base64: contentBase64,
          filename: safeAttachmentFilename(image.name, index),
        },
      );
      if (!result?.attached) {
        throw new Error(result?.message || `Could not attach ${image.name}`);
      }
      attachedCount += 1;
    } catch (err) {
      if (attachedCount === 0 && dashboardAttachmentUnsupportedError(err)) {
        return { handled: false, refs: [] };
      }
      throw err;
    }
  }

  const refs: string[] = [];
  for (let index = 0; index < files.length; index++) {
    const attachment = files[index];
    const name = safeFileAttachmentName(attachment, index);
    const params: Record<string, unknown> = {
      session_id: sessionId,
      name,
    };

    if (attachment.kind === "text-file") {
      const dataUrl = dashboardDataUrlForTextAttachment(attachment);
      if (!dataUrl) return { handled: false, refs: [] };
      params.data_url = dataUrl;
    } else if (attachment.kind === "path-ref" && attachment.path) {
      params.path = attachment.path;
    } else {
      return { handled: false, refs: [] };
    }

    try {
      const result = await client.request<FileAttachResponse>(
        "file.attach",
        params,
      );
      if (!result?.attached || !result.ref_text) {
        throw new Error(result?.message || `Could not attach ${name}`);
      }
      refs.push(result.ref_text);
      attachedCount += 1;
    } catch (err) {
      if (attachedCount === 0 && dashboardAttachmentUnsupportedError(err)) {
        return { handled: false, refs: [] };
      }
      throw err;
    }
  }

  return { handled: true, refs };
}

export function resolveDashboardProviderForModel(
  requestedProvider: string | undefined,
  requestedModel: string | undefined,
  modelBaseUrl: string | undefined,
  live: ModelOptionsResponse | null | undefined,
): string | undefined {
  if (requestedProvider !== "custom" || !requestedModel) {
    return requestedProvider;
  }

  const providers = live?.providers ?? [];
  const requestedBaseUrl = normalizeBaseUrl(modelBaseUrl);
  const model = requestedModel.trim();

  if (requestedBaseUrl) {
    const builtInProvider = builtInProviderForCustomBaseUrl(
      modelBaseUrl || "",
      model,
      live,
    );
    if (builtInProvider) return builtInProvider;
  }

  const customProviders = providers.filter((provider) =>
    provider.slug?.toLowerCase().startsWith("custom:"),
  );

  if (requestedBaseUrl) {
    // Match ANY provider row on the requested endpoint — named user providers
    // from config.yaml `providers:` (e.g. the mirrored `hermesone` entry) as
    // well as legacy `custom:<name>` rows. Falling through to bare "custom"
    // is the failure mode this avoids: the agent resolves `--provider custom`
    // against the session's *current* base URL, so a session sitting on
    // another provider would send this model to the wrong endpoint (the
    // hermesone-swift → Nous-proxy 404).
    const baseMatches = providers.filter(
      (provider) =>
        !!provider.slug &&
        normalizeBaseUrl(providerBaseUrl(provider)) === requestedBaseUrl,
    );
    return (
      baseMatches.find((provider) => modelIsListedByProvider(provider, model))
        ?.slug ||
      baseMatches.find((provider) => provider.is_current)?.slug ||
      baseMatches[0]?.slug ||
      requestedProvider
    );
  }

  return (
    customProviders.find((provider) => modelIsListedByProvider(provider, model))
      ?.slug ||
    customProviders.find((provider) => provider.is_current)?.slug ||
    requestedProvider
  );
}

// A /moa one-shot in flight: the gateway switched the live session to the
// virtual moa provider for one turn (issue #138) while the chat's configured
// provider is a normal one. Model enforcement must stand down for this turn.
export function isTransientMoaTurn(
  requestedProvider: string | undefined,
  live: ModelOptionsResponse | null | undefined,
): boolean {
  const liveProvider = (live?.provider || "").trim().toLowerCase();
  const requested = (requestedProvider || "").trim().toLowerCase();
  return liveProvider === "moa" && requested !== "moa";
}

export function dashboardModelMatches(
  requestedProvider: string | undefined,
  requestedModel: string | undefined,
  live: ModelOptionsResponse | null | undefined,
): boolean {
  if (!requestedProvider || requestedProvider === "auto" || !requestedModel) {
    return true;
  }

  const liveProvider = (live?.provider || "").trim().toLowerCase();
  const liveModel = (live?.model || "").trim();
  const provider = requestedProvider.trim().toLowerCase();
  const model = requestedModel.trim();

  if (!liveProvider || !liveModel) return false;
  if (liveModel !== model) return false;
  if (liveProvider === provider) return true;

  // Named custom providers can be reported by Hermes Agent as custom:<slug>
  // while Hermes One's older model config still treats them as custom rows.
  return provider === "custom" && liveProvider.startsWith("custom:");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// The backend keeps the per-session approval bypass (yolo) in process memory
// only, so a locally spawned backend loses it on app restart (issue #115).
// The transport persists the user's choice per stored session and re-applies
// it once per runtime session when the backend reports it off.
const SESSION_YOLO_STORAGE_KEY = "hermes.sessionYolo.v1";

function sessionYoloStorageKey(
  connectionId: string | undefined,
  profile: string | undefined,
  sessionId: string,
): string {
  return `${SESSION_YOLO_STORAGE_KEY}:${connectionId ?? "local"}:${profile ?? "default"}:${sessionId}`;
}

function readStoredSessionYolo(
  connectionId: string | undefined,
  profile: string | undefined,
  sessionId: string | null,
): boolean {
  if (!sessionId) return false;
  try {
    return (
      window.localStorage.getItem(
        sessionYoloStorageKey(connectionId, profile, sessionId),
      ) === "1"
    );
  } catch {
    return false;
  }
}

function writeStoredSessionYolo(
  connectionId: string | undefined,
  profile: string | undefined,
  sessionId: string | null,
  enabled: boolean | null,
): void {
  if (!sessionId) return;
  const key = sessionYoloStorageKey(connectionId, profile, sessionId);
  try {
    if (enabled === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, enabled ? "1" : "0");
    }
  } catch {
    // localStorage unavailable (privacy mode) — persistence degrades to the
    // pre-fix behavior (flag lost on restart), never breaks the toggle.
  }
}

function payloadTextLength(
  payload: Record<string, unknown>,
  key: string,
): number {
  return typeof payload[key] === "string" ? payload[key].length : 0;
}

interface DashboardEventSummary {
  eventSessionId: string | null;
  hasUsage: boolean;
  payloadKeys: string[];
  reasoningLength: number;
  renderedLength: number;
  runtimeSessionId: string | null;
  status: "accepted" | "dropped";
  textLength: number;
  timestamp: string;
  type: string;
}

declare global {
  interface Window {
    __HERMES_DASHBOARD_EVENTS__?: DashboardEventSummary[];
  }
}

function logDashboardEvent(
  event: DashboardStreamEvent,
  status: "accepted" | "dropped",
  runtimeSessionId: string | null,
): void {
  if (import.meta.env.VITE_HERMES_DESKTOP_DASHBOARD_EVENT_LOG !== "1") return;
  const payload = asRecord(event.payload);
  const summary: DashboardEventSummary = {
    timestamp: new Date().toISOString(),
    status,
    type: event.type,
    eventSessionId: event.session_id || null,
    runtimeSessionId,
    payloadKeys: Object.keys(payload).sort(),
    textLength: payloadTextLength(payload, "text"),
    renderedLength: payloadTextLength(payload, "rendered"),
    reasoningLength: payloadTextLength(payload, "reasoning"),
    hasUsage: !!payload.usage,
  };

  const events = window.__HERMES_DASHBOARD_EVENTS__ ?? [];
  events.push(summary);
  window.__HERMES_DASHBOARD_EVENTS__ = events.slice(-200);
  console.info("[Hermes dashboard event]", summary);
}

export function usageFromPayload(payload: unknown): Partial<UsageState> | null {
  const usage = asRecord(asRecord(payload).usage);
  // The Hermes gateway (`_get_usage` in tui_gateway/server.py) emits
  // snake-case, non-`_tokens` keys: input/output/prompt/completion/total plus
  // context_used/context_max/context_percent when the context compressor is
  // active. Older OpenAI-style payloads use prompt_tokens/promptTokens. Read
  // every spelling so the context gauge works regardless of which backend/
  // provider produced the usage record — no chars/4 estimate needed because
  // the gateway already reports exact counts.
  const promptTokens = Number(
    usage.input ??
      usage.prompt ??
      usage.prompt_tokens ??
      usage.promptTokens ??
      0,
  );
  const completionTokens = Number(
    usage.output ??
      usage.completion ??
      usage.completion_tokens ??
      usage.completionTokens ??
      0,
  );
  const totalTokens = Number(
    usage.total ??
      usage.total_tokens ??
      usage.totalTokens ??
      promptTokens + completionTokens,
  );
  // context_used = the current turn's prompt-token occupancy of the context
  // window (compressor's last_prompt_tokens), which is exactly what the gauge
  // wants — a live snapshot, not a cross-turn sum. Fall back to the latest
  // prompt count when the compressor hasn't reported yet.
  const contextUsed = Number(usage.context_used ?? 0);
  const contextMax = Number(usage.context_max ?? 0);
  if (!promptTokens && !completionTokens && !totalTokens && !contextUsed) {
    return null;
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    contextTokens: contextUsed || promptTokens || undefined,
    contextWindowTokens: contextMax || undefined,
  };
}

function messageChars(message: ChatMessage): number {
  if ("content" in message) return message.content?.length ?? 0;
  switch (message.kind) {
    case "reasoning":
      return message.text.length;
    case "tool_call":
      return message.name.length + message.args.length;
    case "clarify":
      return message.question.length;
    case "approval":
      return message.description.length + message.command.length;
    default:
      return 0;
  }
}

/**
 * Rough context-occupancy estimate (~4 chars/token) from the transcript, used
 * as a last resort when the provider omits usage counts so the context gauge
 * still renders (it only shows when `contextTokens` is set — see Chat.tsx).
 *
 * `contextTokens` means the turn's PROMPT-side occupancy, and by the time
 * `message.complete` is handled the just-finished assistant reply has already
 * been reconciled into `messagesRef.current` — so the last assistant bubble
 * (specifically the bubble, not trailing tool/reasoning sub-rows, which were
 * part of the prompt loop) is subtracted back out.
 *
 * Inherently a floor: system prompt, tool schemas, and attachments aren't
 * visible to the renderer.
 */
export function estimateContextTokens(
  messages: ReadonlyArray<ChatMessage>,
): number {
  let totalChars = 0;
  let lastAssistantBubbleChars = 0;
  for (const message of messages) {
    const chars = messageChars(message);
    totalChars += chars;
    const isBubble = message.kind === undefined || message.kind === "assistant";
    if (message.role === "agent" && isBubble) {
      lastAssistantBubbleChars = chars;
    }
  }
  return Math.max(Math.round((totalChars - lastAssistantBubbleChars) / 4), 0);
}

export function completionFailed(payload: unknown): boolean {
  const row = asRecord(payload);
  const status = String(row.status || "").toLowerCase();
  if (status === "error" || status === "failed") return true;
  if (typeof row.error === "string" && row.error.trim()) return true;
  if (row.ok === false || row.success === false) return true;
  const text = String(row.text || row.rendered || "").trim();
  return /^(error:\s*)?(error code:\s*\d+|api call failed after \d+ retries|hermes dashboard did not switch\b)/i.test(
    text,
  );
}

function completionErrorMessage(payload: unknown): string {
  const row = asRecord(payload);
  const raw = String(row.error || row.text || row.rendered || "").trim();
  return raw.replace(/^error\s*:\s*/i, "") || "Hermes reported an error";
}

function userContentById(
  messages: ReadonlyArray<ChatMessage>,
  userId: string | null | undefined,
): string {
  if (!userId) return "";
  const message = messages.find(
    (candidate) =>
      isBubbleMessage(candidate) &&
      candidate.role === "user" &&
      candidate.id === userId,
  );
  return message && isBubbleMessage(message) ? message.content || "" : "";
}

function previousUserIdBefore(
  messages: ReadonlyArray<ChatMessage>,
  beforeIndex: number,
): string | null {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const message = messages[i];
    if (isBubbleMessage(message) && message.role === "user") return message.id;
    if (
      isBubbleMessage(message) &&
      message.role === "agent" &&
      !message.error
    ) {
      return null;
    }
  }
  return null;
}

export function dashboardSeedMessagesFromTranscript(
  messages: ReadonlyArray<ChatMessage>,
  options: DashboardSeedOptions = {},
): DashboardSeedMessage[] {
  const failedUserIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (isBubbleMessage(message) && message.role === "agent" && message.error) {
      const userId = previousUserIdBefore(messages, i);
      if (userId) failedUserIds.add(userId);
    }
  }

  const seed: DashboardSeedMessage[] = [];
  for (const message of messages) {
    if (!isBubbleMessage(message)) continue;
    if (message.role === "user" && message.id === options.excludeUserId)
      continue;
    if (message.localOnly || message.error || message.pending) continue;
    if (failedUserIds.has(message.id)) continue;
    const content = normalizeMessageText(message.content);
    if (!content) continue;
    seed.push({
      role: message.role === "agent" ? "assistant" : "user",
      content,
    });
  }
  return seed;
}

export function dashboardContinuationItemsFromTranscript(
  messages: ReadonlyArray<ChatMessage>,
  options: DashboardSeedOptions = {},
): DesktopSessionContinuationItem[] {
  const items: DesktopSessionContinuationItem[] = [];

  for (const message of messages) {
    if (isBubbleMessage(message)) {
      if (message.role === "user" && message.id === options.excludeUserId) {
        continue;
      }

      if (message.role === "user") {
        const content = message.content || "";
        if (!normalizeMessageText(content) && !message.attachments?.length) {
          continue;
        }
        items.push({
          kind: "user",
          content,
          ...(message.attachments?.length
            ? { attachments: message.attachments }
            : {}),
        });
        continue;
      }

      const content = message.content || "";
      const error = message.error || "";
      if (
        !normalizeMessageText(content) &&
        !normalizeMessageText(error) &&
        !message.attachments?.length
      ) {
        continue;
      }
      items.push({
        kind: "assistant",
        content,
        ...(error ? { error } : {}),
        ...(message.attachments?.length
          ? { attachments: message.attachments }
          : {}),
      });
      continue;
    }

    if (message.kind === "reasoning") {
      if (!normalizeMessageText(message.text)) continue;
      items.push({ kind: "reasoning", text: message.text });
      continue;
    }

    if (message.kind === "tool_call") {
      items.push({
        kind: "tool_call",
        callId: message.callId,
        name: message.name,
        args: message.args,
      });
      continue;
    }

    if (message.kind === "tool_result") {
      const content = message.content || "";
      if (!normalizeMessageText(content) && !message.attachments?.length) {
        continue;
      }
      items.push({
        kind: "tool_result",
        callId: message.callId,
        name: message.name,
        content,
        ...(message.attachments?.length
          ? { attachments: message.attachments }
          : {}),
      });
    }
  }

  return items;
}

export function useDashboardChatTransport({
  activeTurnRef,
  connectionId,
  connectionRevision,
  contextFolder,
  connectionMode,
  enabled,
  fallbackOnUnavailable,
  hermesSessionId,
  messagesRef,
  model,
  modelBaseUrl,
  profile,
  provider,
  setHermesSessionId,
  setIsLoading,
  setMessages,
  setToolProgress,
  setUsage,
  onDashboardUnavailable,
  onTodoState,
}: UseDashboardChatTransportArgs): UseDashboardChatTransportResult {
  const clientRef = useRef<DashboardGatewayClient | null>(null);
  const connectingRef = useRef<Promise<DashboardGatewayClient> | null>(null);
  const clientGenerationRef = useRef(0);
  // Sticky "dashboard transport can't connect on this remote/SSH connection"
  // flag. The dashboard WebSocket (`/api/ws`) never connects against a tunneled
  // `hermes gateway` (issue #667), so once we've learned it's unavailable we
  // fail `ensureClient` fast on every later message instead of re-running the
  // multi-second status+probe — letting the caller fall back to legacy HTTP
  // immediately. Reset on connection change (see the effect below).
  const dashboardUnavailableRef = useRef(false);
  const runtimeSessionIdRef = useRef<string | null>(null);
  const storedSessionIdRef = useRef<string | null>(hermesSessionId);
  const reasoningSegmentClosedRef = useRef(false);
  const appliedModelRef = useRef<string | null>(null);
  const recreateRuntimeSessionRef = useRef(false);
  const lastRuntimeSessionWasCreatedRef = useRef(false);
  // Approval-bypass indicator from the live session.info events. null until the
  // first session.info for the current runtime session arrives; reset on
  // session/connection change so a stale flag never leaks across chats.
  const [sessionYolo, setSessionYolo] = useState<boolean | null>(null);
  const sessionYoloSessionRef = useRef<string | null>(null);
  // Restoration of the persisted bypass (issue #115) fires at most once per
  // runtime session: the ref holds the id we already re-applied it for (or
  // decided not to), so repeated session.info events never re-send.
  const sessionYoloRestoredForRef = useRef<string | null>(null);
  const pendingClarifyRef = useRef<{
    requestId: string;
    /** qids of a batch request still unanswered; empty/undefined for a
     *  single-question request. The pending slot is released when the backend
     *  reports no remaining questions. */
    remainingQids: Set<string>;
    sessionId: string | null;
    responding: boolean;
    activeTurn: ActiveTurn | null;
  } | null>(null);
  const pendingApprovalsRef = useRef<PendingDashboardApproval[]>([]);
  // Sidebar bullet state (issue #90): true while this chat holds a pending
  // command approval. Backed by the ref (kept in sync at every mutation) so
  // Layout can lift it onto the ChatRun without touching the transcript.
  const [hasPendingApproval, setHasPendingApproval] = useState(false);
  const setPendingApprovals = useCallback(
    (next: PendingDashboardApproval[]): void => {
      pendingApprovalsRef.current = next;
      setHasPendingApproval(next.length > 0);
    },
    [],
  );
  const approvalNonceRef = useRef(0);
  const pendingRecoveredContinuationRef = useRef<
    DesktopSessionContinuationItem[]
  >([]);
  const lastSyncedCwdRef = useRef<string | null>(null);
  // Delta coalescing: streaming events arrive many times per second, and each
  // `setMessages` costs a full transcript reconciliation. Deltas are applied
  // to `messagesRef` synchronously — the write-through ref from
  // useTranscriptState is the source of truth every transcript writer builds
  // on — while the React commit is batched to one per animation frame. The
  // flush publishes whatever the ref holds at frame time, so a frame that
  // fires after another writer took over simply republishes (or advances to)
  // that newer state; it can never resurrect an older transcript. That
  // one-way property is what previously required a pinned-array guard here,
  // and it dropped chunks when a functional writer forked from a pre-delta
  // commit (#757's coalesced twin).
  const deltaFlushHandleRef = useRef<number | null>(null);

  const cancelScheduledFlush = useCallback((): void => {
    if (deltaFlushHandleRef.current === null) return;
    const cancel =
      typeof cancelAnimationFrame === "function"
        ? cancelAnimationFrame
        : clearTimeout;
    cancel(deltaFlushHandleRef.current);
    deltaFlushHandleRef.current = null;
  }, []);

  // Coalesced commit for high-frequency streaming events; at most one
  // `setMessages` per animation frame while a burst of deltas lands.
  const scheduleDeltaFlush = useCallback((): void => {
    if (deltaFlushHandleRef.current !== null) return;
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb: FrameRequestCallback): number =>
            setTimeout(() => cb(0), 16) as unknown as number;
    deltaFlushHandleRef.current = raf(() => {
      deltaFlushHandleRef.current = null;
      setMessages(messagesRef.current);
    });
  }, [setMessages, messagesRef]);

  // Immediate commit for lifecycle events, superseding any pending frame.
  const flushDeltasNow = useCallback(
    (next: ChatMessage[]): void => {
      cancelScheduledFlush();
      setMessages(next);
    },
    [cancelScheduledFlush, setMessages],
  );

  const expirePendingClarifyRef = useRef<(failActiveTurn?: boolean) => void>(
    () => undefined,
  );
  expirePendingClarifyRef.current = (failActiveTurn = false): void => {
    const pending = pendingClarifyRef.current;
    pendingClarifyRef.current = null;
    if (!pending) return;
    if (
      failActiveTurn &&
      pending.responding &&
      activeTurnRef.current === pending.activeTurn
    ) {
      if (activeTurnRef.current) activeTurnRef.current.status = "failed";
      activeTurnRef.current = null;
      setToolProgress(null);
      setIsLoading(false);
    }
    setMessages((current) =>
      current.map((message) =>
        message.kind === "clarify" &&
        message.responsePath === "dashboard" &&
        message.requestId === pending.requestId &&
        !message.resolved
          ? { ...message, unavailable: true }
          : message,
      ),
    );
  };

  const expirePendingApprovalsRef = useRef<(failActiveTurn?: boolean) => void>(
    () => undefined,
  );
  expirePendingApprovalsRef.current = (failActiveTurn = false): void => {
    if (pendingApprovalsRef.current.length === 0) return;
    const pendingIds = new Set(
      pendingApprovalsRef.current.map(({ requestId }) => requestId),
    );
    setPendingApprovals([]);
    setMessages((current) => {
      const unavailable = current.map((message) =>
        message.kind === "approval" &&
        pendingIds.has(message.requestId) &&
        !message.resolved
          ? { ...message, unavailable: true }
          : message,
      );
      messagesRef.current = unavailable;
      return unavailable;
    });
    if (failActiveTurn) {
      const activeTurn = activeTurnRef.current;
      if (activeTurn) activeTurn.status = "failed";
      activeTurnRef.current = null;
      setToolProgress(null);
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // Cancel any pending coalesced flush on unmount/teardown — just avoids a
    // setState-after-unmount; nothing is lost, the ref stays the truth.
    return cancelScheduledFlush;
  }, [cancelScheduledFlush]);

  useEffect(() => {
    // Clearing the transcript invalidates pending cards without copying a
    // potentially stale React snapshot back over coalesced stream deltas.
    if (messagesRef.current.length === 0) {
      setPendingApprovals([]);
      pendingClarifyRef.current = null;
    }
  });

  useEffect(() => {
    if (hermesSessionId === storedSessionIdRef.current) return;
    expirePendingApprovalsRef.current();
    storedSessionIdRef.current = hermesSessionId;
    runtimeSessionIdRef.current = null;
    reasoningSegmentClosedRef.current = false;
    appliedModelRef.current = null;
    recreateRuntimeSessionRef.current = false;
    lastRuntimeSessionWasCreatedRef.current = false;
    expirePendingClarifyRef.current();
    lastSyncedCwdRef.current = null;
    // A different chat never inherits the previous chat's approval flag; the
    // next session.info for the new runtime session will repopulate it.
    sessionYoloSessionRef.current = null;
    setSessionYolo(null);
  }, [hermesSessionId]);

  useEffect(() => {
    appliedModelRef.current = null;
  }, [model, provider]);

  // True when a previously-running turn was detached from its event stream
  // (connection switch / WS drop) and retired with a "continues on the agent"
  // marker (issue #76). Cleared once a resync catches the chat up. State (not
  // just a ref) so the owning Chat re-renders and can trigger the resync.
  const [detachedSessionId, setDetachedSessionId] = useState<string | null>(
    null,
  );
  const detachedSessionIdRef = useRef<string | null>(null);
  // The transport-binding effect below also runs on MOUNT, where there is
  // nothing to tear down — retire only on an actual deps change.
  const transportBoundRef = useRef(false);

  // Retire a still-running turn whose event stream is going away (deliberate
  // teardown or WebSocket drop): message.complete can no longer arrive, so
  // clear the spinner and tell the user the agent keeps running server-side.
  // The next prompt on this chat resumes the session, and session.resume
  // replays/reconciles what was missed (issue #76).
  const retireDetachedTurn = useCallback((): void => {
    const activeTurn = activeTurnRef.current;
    if (!activeTurn || activeTurn.status !== "running") return;
    activeTurn.status = "failed";
    activeTurnRef.current = null;
    // Remember the session so a later reactivation can resync (issue #76).
    detachedSessionIdRef.current = storedSessionIdRef.current;
    setDetachedSessionId(storedSessionIdRef.current);
    setMessages((prev) => [
      ...prev,
      {
        id: `continued-${Date.now()}`,
        role: "agent",
        content:
          "Connection switched — the turn continues on the agent. Reopen this chat to catch up on its result.",
        pending: false,
        localOnly: true,
        ...(activeTurn.turnId ? { turnId: activeTurn.turnId } : {}),
      },
    ]);
    setToolProgress(null);
    setIsLoading(false);
  }, [activeTurnRef, setIsLoading, setMessages, setToolProgress]);

  // Latest-ref: the teardown effect and ensureClient's onClose must not
  // re-run merely because this callback's identity changed (setter props can
  // be unstable), so callers go through the ref.
  const retireDetachedTurnRef = useRef(retireDetachedTurn);
  retireDetachedTurnRef.current = retireDetachedTurn;

  // After an accidental WebSocket drop retired a still-running turn (issue
  // #76), wait out the immediate reconnect window, then re-resume: when the
  // agent is still up and the turn still runs, the resume re-attaches the
  // event stream and ensureRuntimeSession restores the spinner/Stop state
  // (issue #109). Runs only when the retire actually fired (a detached
  // marker was set); otherwise the drop happened while idle and there is
  // nothing to restore. Goes through a latest-ref because resyncAfterDetach
  // is declared later in the hook.
  const resyncAfterDetachRef = useRef<() => Promise<void>>(async () => {});
  const probeRestoreAfterDrop = useCallback((): void => {
    window.setTimeout(() => {
      if (detachedSessionIdRef.current) void resyncAfterDetachRef.current();
    }, 1500);
  }, []);
  const probeRestoreAfterDropRef = useRef(probeRestoreAfterDrop);
  probeRestoreAfterDropRef.current = probeRestoreAfterDrop;

  useEffect(() => {
    // Teardown of the transport binding (connection switch, profile switch,
    // connection config change): the WebSocket is deliberately closed below,
    // so a turn that is still running will never receive its
    // message.complete. Retire it in the UI instead of leaving the spinner
    // dangling forever (issue #76). Skipped on the initial mount.
    if (transportBoundRef.current) retireDetachedTurnRef.current();
    transportBoundRef.current = true;
    clientGenerationRef.current += 1;
    dashboardUnavailableRef.current = false;
    expirePendingApprovalsRef.current(true);
    clientRef.current?.close();
    clientRef.current = null;
    connectingRef.current = null;
    runtimeSessionIdRef.current = null;
    sessionYoloSessionRef.current = null;
    setSessionYolo(null);
    reasoningSegmentClosedRef.current = false;
    appliedModelRef.current = null;
    recreateRuntimeSessionRef.current = false;
    lastRuntimeSessionWasCreatedRef.current = false;
    expirePendingClarifyRef.current();
    pendingRecoveredContinuationRef.current = [];
    lastSyncedCwdRef.current = null;
  }, [connectionId, connectionMode, connectionRevision, profile]);

  const handleGatewayEvent = useCallback(
    (event: DashboardStreamEvent): void => {
      const runtimeSessionId = runtimeSessionIdRef.current;
      if (
        event.session_id &&
        runtimeSessionId &&
        event.session_id !== runtimeSessionId
      ) {
        logDashboardEvent(event, "dropped", runtimeSessionId);
        return;
      }
      logDashboardEvent(event, "accepted", runtimeSessionId);

      if (event.type === "session.info") {
        const recordRuntimeInfo = window.hermesAPI.recordAgentRuntimeInfo;
        if (typeof recordRuntimeInfo === "function") {
          void recordRuntimeInfo(event.payload, profile, connectionId).catch(
            () => undefined,
          );
        }
        // Reflect the live approval-bypass flag (OR of session flag, process
        // env, approvals.mode=off) emitted after every toggle and on resume.
        if (
          !event.session_id ||
          event.session_id === runtimeSessionIdRef.current ||
          event.session_id === storedSessionIdRef.current
        ) {
          const payloadYolo = asRecord(event.payload)?.yolo;
          if (typeof payloadYolo === "boolean") {
            sessionYoloSessionRef.current = runtimeSessionIdRef.current;
            setSessionYolo(payloadYolo);
          }
        }
        return;
      }

      // Live todo snapshots (issue #126): every todo_list mutation emits a
      // full snapshot; push it to the chat context panel. No messages change.
      if (event.type === "todo.updated") {
        onTodoState?.(event.payload);
        return;
      }

      // Background (`/btw`) prompts run on a separate agent and report back via
      // `background.complete` — outside the main turn lifecycle, so render the
      // answer as a standalone agent message without touching isLoading or the
      // active turn.
      if (event.type === "background.complete") {
        const p =
          event.payload && typeof event.payload === "object"
            ? (event.payload as { task_id?: string; text?: string })
            : {};
        const label = p.task_id ? `[bg ${p.task_id}] ` : "[bg] ";
        const body = String(p.text ?? "").trim() || "(no output)";
        const appended: ChatMessage[] = [
          ...messagesRef.current,
          {
            id: `bg-${p.task_id || Date.now()}`,
            role: "agent",
            content: `${label}${body}`,
          },
        ];
        flushDeltasNow(appended);
        return;
      }

      const failed =
        event.type === "message.complete" && completionFailed(event.payload);
      const approvalRequestId =
        event.type === "approval.request"
          ? dashboardApprovalRequestId(
              event,
              Date.now(),
              ++approvalNonceRef.current,
            )
          : undefined;
      if (approvalRequestId) {
        const sessionId = event.session_id || runtimeSessionId;
        if (sessionId) {
          if (
            !pendingApprovalsRef.current.some(
              (pending) => pending.requestId === approvalRequestId,
            )
          ) {
            setPendingApprovals([
              ...pendingApprovalsRef.current,
              {
                requestId: approvalRequestId,
                gatewayRequestId: gatewayApprovalRequestId(event.payload),
                responding: false,
                sessionId,
                choices: normalizeApprovalRequest(
                  event.payload,
                  approvalRequestId,
                ).choices,
              },
            ]);
          }
        }
      }
      const next = applyDashboardStreamEvent(
        {
          messages: messagesRef.current,
          reasoningSegmentClosed: reasoningSegmentClosedRef.current,
        },
        event,
        {
          activeTurn: activeTurnRef.current,
          approvalRequestId,
          renderAssistantDeltas: connectionMode === "local",
        },
      );
      reasoningSegmentClosedRef.current = next.reasoningSegmentClosed;
      const nextMessages = failed
        ? markActiveTurnFailed(
            next.messages,
            completionErrorMessage(event.payload),
            activeTurnRef.current,
          )
        : next.messages;
      messagesRef.current = nextMessages;
      // High-frequency stream events coalesce into one commit per frame;
      // lifecycle events (start/complete/clarify/tool boundaries) commit
      // immediately so dependent state (isLoading, toolProgress, approval
      // cards) can't observe a stale transcript.
      const isCoalescableDelta =
        event.type === "message.delta" ||
        event.type === "thinking.delta" ||
        event.type === "reasoning.delta" ||
        event.type === "tool.progress" ||
        event.type === "tool.generating";
      if (isCoalescableDelta) {
        scheduleDeltaFlush();
      } else {
        flushDeltasNow(nextMessages);
      }

      if (
        event.type === "approval.request" &&
        !gatewayApprovalRequestId(event.payload)
      ) {
        // A local display ID cannot safely select a command in an upstream
        // FIFO queue. Stop instead of asking the user to approve an unknown target.
        expirePendingApprovalsRef.current(true);
        if (runtimeSessionId) {
          void clientRef.current
            ?.request("session.interrupt", { session_id: runtimeSessionId })
            .catch(() => undefined);
        }
        return;
      }

      if (event.type === "message.complete") {
        // A reply RPC can be acknowledged after the resumed turn finishes.
        if (!pendingClarifyRef.current?.responding)
          expirePendingClarifyRef.current();
        expirePendingApprovalsRef.current();
        if (failed) {
          appliedModelRef.current = null;
          recreateRuntimeSessionRef.current = true;
          const storedSessionId = storedSessionIdRef.current;
          const userContent = userContentById(
            messagesRef.current,
            activeTurnRef.current?.userId,
          );
          const recordLocalError = window.hermesAPI.recordSessionLocalError;
          if (
            dashboardShouldPersistLocalOverlays(connectionMode) &&
            storedSessionId &&
            userContent &&
            typeof recordLocalError === "function"
          ) {
            void recordLocalError(storedSessionId, {
              userContent,
              error: completionErrorMessage(event.payload),
            }).catch(() => undefined);
          }
        }
        const activeTurn = activeTurnRef.current;
        if (activeTurn) activeTurn.status = failed ? "failed" : "completed";
        activeTurnRef.current = null;
        setToolProgress(null);
        setIsLoading(false);
        const usage = usageFromPayload(event.payload);
        if (usage || !failed) {
          // The gauge only renders when `contextTokens` is set, so it must be
          // populated even when the provider omits usage — entirely
          // (usageFromPayload → null) or just the prompt-side counts. Exact
          // payload values win; otherwise fall back to the chars/4 transcript
          // estimate, then to the previous turn's value. A failed turn with no
          // usage doesn't fabricate one — nothing new entered the context.
          const estimatedContextTokens = estimateContextTokens(
            messagesRef.current,
          );
          setUsage((prev) => ({
            promptTokens:
              (prev?.promptTokens || 0) + (usage?.promptTokens || 0),
            completionTokens:
              (prev?.completionTokens || 0) + (usage?.completionTokens || 0),
            totalTokens: (prev?.totalTokens || 0) + (usage?.totalTokens || 0),
            cost: prev?.cost,
            contextTokens:
              usage?.contextTokens ||
              estimatedContextTokens ||
              prev?.contextTokens,
            contextWindowTokens:
              usage?.contextWindowTokens || prev?.contextWindowTokens,
            cacheReadTokens: prev?.cacheReadTokens,
            cacheWriteTokens: prev?.cacheWriteTokens,
          }));
        }
      }

      if (event.type === "clarify.expire" || event.type === "clarify.request") {
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as { request_id?: unknown })
            : {};
        const requestId =
          typeof payload.request_id === "string" ? payload.request_id : "";
        const pending = pendingClarifyRef.current;
        if (event.type === "clarify.expire") {
          if (!requestId || pending?.requestId !== requestId) return;
          expirePendingClarifyRef.current();
          // The Agent's blocking prompt returns on timeout and the original
          // turn resumes. Keep tracking it until message.complete arrives.
          if (pending.activeTurn?.status === "running") {
            activeTurnRef.current = pending.activeTurn;
            setIsLoading(true);
          }
          return;
        }
        // Replays must not retire a newer question or clear a turn that has
        // already resumed while its answer RPC is still being acknowledged.
        if (!requestId || pending?.requestId === requestId) return;
        const card = messagesRef.current.find(
          (message) =>
            message.kind === "clarify" &&
            message.responsePath === "dashboard" &&
            message.requestId === requestId,
        );
        if (card?.kind !== "clarify" || card.resolved || card.unavailable)
          return;
        expirePendingClarifyRef.current();
        // Batch requests share one request_id; collect every unresolved qid of
        // this request so per-question answers can retire the pending slot only
        // when the backend confirms nothing remains.
        const remainingQids = new Set<string>();
        for (const message of messagesRef.current) {
          if (
            message.kind === "clarify" &&
            message.responsePath === "dashboard" &&
            message.requestId === requestId &&
            !message.resolved &&
            !message.unavailable &&
            message.qid
          ) {
            remainingQids.add(message.qid);
          }
        }
        pendingClarifyRef.current = {
          requestId,
          remainingQids,
          sessionId: runtimeSessionId,
          responding: false,
          activeTurn: activeTurnRef.current,
        };
        activeTurnRef.current = null;
        setToolProgress(null);
        setIsLoading(false);
      }
    },
    [
      activeTurnRef,
      connectionId,
      connectionMode,
      flushDeltasNow,
      setPendingApprovals,
      messagesRef,
      scheduleDeltaFlush,
      profile,
      setIsLoading,
      setToolProgress,
      setUsage,
    ],
  );

  const ensureClient =
    useCallback(async (): Promise<DashboardGatewayClient> => {
      const existing = clientRef.current;
      if (existing?.connected) return existing;
      // Already known unavailable on this remote/SSH connection — fail fast so the
      // caller falls back to legacy without re-running the slow status+probe.
      if (dashboardUnavailableRef.current) {
        throw new Error("Hermes dashboard transport is unavailable");
      }
      if (connectingRef.current) return connectingRef.current;

      const generation = clientGenerationRef.current;
      const pending = (async () => {
        // The dashboard `/api/ws` is the ONLY chat transport when a dashboard is
        // available (matching apps/desktop, which has no /v1 chat path). A WS
        // drop / "socket hang up" — e.g. a momentary SSH tunnel blip — is
        // TRANSIENT and must reconnect, NOT fall back to the main-process /v1
        // path: over the dashboard tunnel /v1 doesn't exist and 405s. So retry
        // the connect (re-running startDashboard each attempt to re-establish the
        // tunnel). Only a genuinely-absent dashboard (running=false) latches the
        // negative flag and lets the caller drop to legacy gateway /v1.
        let lastConnectErr: unknown = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          const status = await window.hermesAPI.startDashboard(
            profile,
            connectionId,
          );
          if (clientGenerationRef.current !== generation) {
            throw new Error("Hermes dashboard connection was superseded");
          }
          if (!status.running || !status.connection) {
            if (status.needsOAuthLogin) {
              const error = new Error(
                status.error || "Remote gateway sign-in is required",
              ) as Error & { dashboardWasReachable?: boolean };
              error.dashboardWasReachable = true;
              throw error;
            }
            // No dashboard on this remote (gateway-only install). Latch + notify
            // only in auto mode where we actually fall back to legacy.
            if (
              connectionMode !== "local" &&
              fallbackOnUnavailable &&
              !dashboardUnavailableRef.current
            ) {
              dashboardUnavailableRef.current = true;
              onDashboardUnavailable?.(
                status.error || "Hermes dashboard transport is unavailable",
              );
            }
            throw new Error(
              status.error || "Hermes dashboard transport is unavailable",
            );
          }
          const client: DashboardGatewayClient = new DashboardGatewayClient({
            onEvent: handleGatewayEvent,
            onClose: () => {
              if (clientRef.current === client) {
                expirePendingClarifyRef.current(true);
                expirePendingApprovalsRef.current(true);
                clientRef.current = null;
                // The socket dropped outside a deliberate teardown (tunnel
                // blip, remote restart). A running turn can no longer hear
                // its message.complete on THIS socket — retire it in the UI;
                // ensureClient reconnects on the next prompt and
                // session.resume reconciles the missed tail (issue #76).
                retireDetachedTurnRef.current();
                // The socket that owned the runtime-session binding is gone;
                // clear the binding so the probe's resync re-resumes (the
                // backend re-attaches the live session's event stream and
                // reports its `running` flag) instead of skipping the resume
                // on a stale runtime id (issue #109).
                runtimeSessionIdRef.current = null;
                // If the agent is still reachable over HTTP, the resume probe
                // re-attaches the turn's event stream on a fresh socket and
                // restores the running state the retire above cleared (issue
                // #109). Best-effort: a dead dashboard just leaves the
                // detached marker, exactly as before.
                probeRestoreAfterDropRef.current();
              }
            },
          });
          try {
            const freshUrl = window.hermesAPI.freshDashboardWsUrl
              ? await window.hermesAPI.freshDashboardWsUrl(
                  profile,
                  connectionId,
                )
              : status.connection.wsUrl;
            if (!freshUrl) {
              throw new Error("Hermes dashboard WebSocket URL is unavailable");
            }
            await client.connect(freshUrl);
          } catch (err) {
            lastConnectErr = err;
            client.close();
            if (clientGenerationRef.current !== generation) {
              throw new Error("Hermes dashboard connection was superseded");
            }
            // Transient connect failure while the dashboard IS up — back off and
            // retry (the tunnel may be re-establishing).
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
            continue;
          }
          if (clientGenerationRef.current !== generation) {
            client.close();
            throw new Error("Hermes dashboard connection was superseded");
          }
          clientRef.current = client;
          return client;
        }
        // Dashboard was up but the WS wouldn't stay connected. Tag the error so
        // the caller fails the turn (and lets the user retry) instead of POSTing
        // /v1 to the dashboard tunnel (which 405s).
        const err = new Error(
          lastConnectErr instanceof Error
            ? `Hermes dashboard chat connection failed: ${lastConnectErr.message}`
            : "Hermes dashboard chat connection failed",
        ) as Error & { dashboardWasReachable?: boolean };
        err.dashboardWasReachable = true;
        throw err;
      })();
      connectingRef.current = pending;

      try {
        return await pending;
      } finally {
        if (connectingRef.current === pending) {
          connectingRef.current = null;
        }
      }
    }, [
      handleGatewayEvent,
      profile,
      connectionId,
      connectionMode,
      fallbackOnUnavailable,
      onDashboardUnavailable,
      onTodoState,
    ]);

  // Restore the UI's run state from the backend's truth (issue #109): the
  // gateway keeps authoritative `running` flags, and session.resume reports
  // them plus re-attaches the event stream of a still-running turn — deltas
  // and message.complete then arrive on this client like for a local send.
  // A synthetic activeTurn carries no turnId/userId; the reconcile path does
  // not key on them for a resumed turn, and an eventual completion clears
  // the spinner without needing a matching user bubble.
  const seedRunStateFromResume = useCallback(
    (running: boolean): void => {
      if (running) {
        if (!activeTurnRef.current) {
          activeTurnRef.current = {
            turnId: "",
            userId: "",
            startIndex: messagesRef.current.length,
            status: "running",
          };
        } else {
          activeTurnRef.current.status = "running";
        }
        setIsLoading(true);
      }
    },
    [activeTurnRef, messagesRef, setIsLoading],
  );

  const ensureRuntimeSession = useCallback(
    async (
      client: DashboardGatewayClient,
      options: {
        excludeSeedUserId?: string | null;
        forceCreate?: boolean;
      } = {},
    ): Promise<string> => {
      let targetSessionId = runtimeSessionIdRef.current;
      let justCreated = false;

      if (!targetSessionId) {
        const stored = storedSessionIdRef.current;
        const excludeSeedUserId =
          options.excludeSeedUserId ?? activeTurnRef.current?.userId ?? null;
        const response = await ensureDashboardRuntimeSession({
          client,
          contextFolder,
          excludeSeedUserId,
          forceCreate: options.forceCreate ?? false,
          messages: messagesRef.current,
          profile,
          storedSessionId: stored,
        });
        const recordRuntimeInfo = window.hermesAPI.recordAgentRuntimeInfo;
        if (typeof recordRuntimeInfo === "function") {
          void recordRuntimeInfo(response.info, profile, connectionId).catch(
            () => undefined,
          );
        }

        if (stored && response.created) {
          pendingRecoveredContinuationRef.current =
            dashboardContinuationItemsFromTranscript(messagesRef.current, {
              excludeUserId: excludeSeedUserId,
            });
        }

        targetSessionId = response.runtimeSessionId;
        runtimeSessionIdRef.current = targetSessionId;
        lastRuntimeSessionWasCreatedRef.current = response.created;
        justCreated = response.created;
        if (!justCreated && response.running) {
          // The resumed session still has a live turn (re-opened chat, app
          // restart, post-detach resync): restore the spinner/Stop state the
          // renderer lost (issue #109).
          seedRunStateFromResume(true);
        }
        if (justCreated && contextFolder) {
          lastSyncedCwdRef.current = contextFolder;
        }
        const storedId = response.storedSessionId;
        storedSessionIdRef.current = storedId;
        recreateRuntimeSessionRef.current = false;
        setHermesSessionId(storedId);
        // Restore the persisted per-session approval bypass (issue #115):
        // the backend keeps it in process memory only, so after an app
        // restart the resumed session reports it off (a lazy resume carries
        // no yolo at all). Re-apply the user's stored choice once per runtime
        // session — only when the stored choice is ON and the backend's own
        // reported state (when present) is OFF. This is the authoritative
        // restore point: it runs on chat open, not only when session.info
        // happens to arrive.
        if (
          !justCreated &&
          sessionYoloRestoredForRef.current !== targetSessionId &&
          readStoredSessionYolo(connectionId, profile, storedId)
        ) {
          const reportedYolo = asRecord(response.info)?.yolo;
          if (reportedYolo !== true) {
            sessionYoloRestoredForRef.current = targetSessionId;
            void client
              .request("config.set", {
                key: "yolo",
                value: "1",
                scope: "session",
                session_id: targetSessionId,
              })
              .then((result) => {
                if (clientRef.current !== client) return;
                const value = (result as { value?: string } | undefined)?.value;
                if (value === undefined || value === "1") {
                  sessionYoloSessionRef.current = targetSessionId;
                  setSessionYolo(true);
                }
              })
              .catch(() => {
                if (sessionYoloRestoredForRef.current === targetSessionId) {
                  sessionYoloRestoredForRef.current = null;
                }
              });
          }
        }
      }

      if (
        contextFolder &&
        targetSessionId &&
        lastSyncedCwdRef.current !== contextFolder
      ) {
        lastSyncedCwdRef.current = contextFolder;
        await client
          .request("session.cwd.set", {
            session_id: targetSessionId,
            cwd: contextFolder,
          })
          .catch((err) => {
            lastSyncedCwdRef.current = null;
            console.warn("Failed to sync dashboard CWD:", err);
          });
      }

      return targetSessionId;
    },
    [
      activeTurnRef,
      connectionId,
      contextFolder,
      messagesRef,
      profile,
      seedRunStateFromResume,
      setHermesSessionId,
    ],
  );

  // Eagerly resume a chat whose persisted approval bypass is ON (issue #115):
  // opening the chat (not just sending a message) must light the shield and
  // re-apply the flag to the fresh backend. Nothing else on chat open calls
  // ensureRuntimeSession, and the restore inside it is the authoritative point.
  const sessionYoloEagerRestoredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (sessionYoloEagerRestoredRef.current === hermesSessionId) return;
    if (!readStoredSessionYolo(connectionId, profile, hermesSessionId)) {
      return;
    }
    sessionYoloEagerRestoredRef.current = hermesSessionId;
    void ensureClient()
      .then((client) => ensureRuntimeSession(client))
      .catch(() => {
        // Leave the marker: a manual prompt retries the resume (and its own
        // restore) — do not re-run the eager path on every render.
      });
  }, [hermesSessionId, enabled, connectionId, profile]);

  const ensureSelectedModel = useCallback(
    async (
      client: DashboardGatewayClient,
      sessionId: string,
    ): Promise<string> => {
      const command = dashboardModelCommand(provider, model);
      if (!command) return sessionId;
      const resetRuntimeSession = async (
        targetSessionId: string,
      ): Promise<string> => {
        const storedSessionId = storedSessionIdRef.current;
        await client
          .request("session.close", { session_id: targetSessionId })
          .catch(() => undefined);
        runtimeSessionIdRef.current = null;
        setPendingApprovals([]);
        storedSessionIdRef.current = storedSessionId;
        reasoningSegmentClosedRef.current = false;
        appliedModelRef.current = null;
        return ensureRuntimeSession(client);
      };

      const switchAndValidate = async (
        targetSessionId: string,
      ): Promise<string> => {
        let before = await client.request<ModelOptionsResponse>(
          "model.options",
          {
            session_id: targetSessionId,
          },
        );
        // /moa is a one-shot: the gateway switches the live session to the moa
        // provider for a single turn and restores the configured model after
        // it (issue #138). While that turn is in flight the live provider IS
        // moa on purpose — enforcing the chat's configured model here would
        // force /model back mid-turn and fail validation, killing the MoA run.
        if (isTransientMoaTurn(provider, before)) return targetSessionId;
        let dashboardProvider = resolveDashboardProviderForModel(
          provider,
          model,
          modelBaseUrl,
          before,
        );

        if (
          storedSessionIdRef.current &&
          !dashboardModelMatches(dashboardProvider, model, before) &&
          (provider === "custom" ||
            (before.provider || "").toLowerCase().startsWith("custom"))
        ) {
          targetSessionId = await resetRuntimeSession(targetSessionId);
          before = await client.request<ModelOptionsResponse>("model.options", {
            session_id: targetSessionId,
          });
          dashboardProvider = resolveDashboardProviderForModel(
            provider,
            model,
            modelBaseUrl,
            before,
          );
          if (dashboardModelMatches(dashboardProvider, model, before)) {
            appliedModelRef.current = `${targetSessionId}\n${dashboardProvider}\n${model}`;
            return targetSessionId;
          }
        }

        if (
          provider === "custom" &&
          dashboardProvider === "custom" &&
          storedSessionIdRef.current
        ) {
          targetSessionId = await resetRuntimeSession(targetSessionId);

          const rebuilt = await client.request<ModelOptionsResponse>(
            "model.options",
            {
              session_id: targetSessionId,
            },
          );
          if (dashboardModelMatches("custom", model, rebuilt)) {
            appliedModelRef.current = `${targetSessionId}\ncustom\n${model}`;
            return targetSessionId;
          }
        }

        const resolvedCommand = dashboardModelCommand(dashboardProvider, model);
        if (!resolvedCommand) return targetSessionId;
        const key = `${targetSessionId}\n${dashboardProvider}\n${model}`;
        let slashResponse: SlashExecResponse | null = null;
        if (appliedModelRef.current !== key) {
          slashResponse = await client.request<SlashExecResponse>(
            "slash.exec",
            {
              session_id: targetSessionId,
              command: resolvedCommand,
            },
          );
        }

        // `before` is already the live state for this send. Only re-read after
        // slash.exec, which is the sole operation above that can change it.
        // This avoids a duplicate model.options round-trip on every later turn.
        const live = slashResponse
          ? await client.request<ModelOptionsResponse>("model.options", {
              session_id: targetSessionId,
            })
          : before;
        if (!dashboardModelMatches(dashboardProvider, model, live)) {
          appliedModelRef.current = null;
          const warning = slashResponse?.warning
            ? `; /model warning: ${slashResponse.warning}`
            : "";
          const output = slashResponse?.output
            ? `; /model output: ${slashResponse.output}`
            : "";
          throw new Error(
            `Hermes dashboard did not switch to ${dashboardProvider}/${model}; live model is ${live.provider || "unknown"}/${live.model || "unknown"}${warning}${output}; custom inventory: ${modelOptionsSummary(before)}`,
          );
        }
        appliedModelRef.current = key;
        return targetSessionId;
      };

      try {
        return await switchAndValidate(sessionId);
      } catch (err) {
        if (!isDashboardSlashWorkerExitError(err)) throw err;
        appliedModelRef.current = null;
        const freshSessionId = await resetRuntimeSession(sessionId);
        return switchAndValidate(freshSessionId);
      }
    },
    [ensureRuntimeSession, model, modelBaseUrl, provider, setPendingApprovals],
  );

  const syncDashboardAttachments = useCallback(
    async (
      client: DashboardGatewayClient,
      sessionId: string,
      attachments?: Attachment[],
    ): Promise<{ handled: boolean; refs: string[] }> => {
      return syncDashboardAttachmentsForSubmit(client, sessionId, attachments);
    },
    [],
  );

  const respondClarify = useCallback(
    async (
      requestId: string,
      answer: string,
      qid?: string,
    ): Promise<boolean> => {
      const pending = pendingClarifyRef.current;
      const client = clientRef.current;
      if (
        !enabled ||
        !pending ||
        pending.requestId !== requestId ||
        pending.responding ||
        pending.sessionId !== runtimeSessionIdRef.current ||
        !client?.connected
      )
        return false;
      pending.responding = true;
      activeTurnRef.current = pending.activeTurn;
      setIsLoading(true);
      try {
        // Batch answers carry the question's wire id so the backend locks one
        // question at a time; a single-question answer omits it.
        const result = await client.request<{
          status?: string;
          remaining?: string[];
        }>("clarify.respond", {
          request_id: requestId,
          answer,
          ...(qid ? { question_id: qid } : {}),
        });
        if (
          !pendingClarifyRef.current ||
          pending.sessionId !== runtimeSessionIdRef.current ||
          clientRef.current !== client
        )
          return false;
        if (result?.status !== "ok") {
          if (pendingClarifyRef.current === pending) {
            setIsLoading(false);
            activeTurnRef.current = null;
            expirePendingClarifyRef.current();
          }
          return false;
        }
        // Batch: the backend reports the still-open qids. Resolve only the
        // answered card and keep the pending slot (and the turn) alive while
        // questions remain; an empty/absent list retires the whole request.
        const remaining = Array.isArray(result.remaining)
          ? result.remaining.filter((item): item is string => !!item)
          : [];
        if (qid && remaining.length > 0) {
          if (pendingClarifyRef.current === pending)
            pending.remainingQids = new Set(remaining);
          setMessages((current) =>
            current.map((message) =>
              message.kind === "clarify" &&
              message.responsePath === "dashboard" &&
              message.requestId === requestId &&
              message.qid === qid
                ? { ...message, answer, resolved: true, unavailable: false }
                : message,
            ),
          );
          return true;
        }
        if (pendingClarifyRef.current === pending)
          pendingClarifyRef.current = null;
        setMessages((current) =>
          current.map((message) =>
            message.kind === "clarify" &&
            message.responsePath === "dashboard" &&
            message.requestId === requestId
              ? {
                  ...message,
                  answer: message.qid === qid ? answer : message.answer,
                  resolved: true,
                  unavailable: false,
                }
              : message,
          ),
        );
        return true;
      } catch {
        if (pendingClarifyRef.current === pending) {
          setIsLoading(false);
          activeTurnRef.current = null;
        }
        return false;
      } finally {
        pending.responding = false;
      }
    },
    [enabled, setMessages, activeTurnRef, setIsLoading],
  );

  const sendMessage = useCallback(
    async (text: string, attachments?: Attachment[]): Promise<boolean> => {
      if (!enabled) return false;
      const pendingClarifyRequestId = pendingClarifyRef.current?.requestId;
      if (pendingClarifyRequestId) {
        try {
          if (!(await respondClarify(pendingClarifyRequestId, text))) {
            throw new Error(
              "Could not deliver the clarification answer. Retry from the question card.",
            );
          }
          return true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const activeTurn = activeTurnRef.current;
          if (activeTurn) activeTurn.status = "failed";
          setMessages((prev) =>
            markActiveTurnFailed(prev, message, activeTurn),
          );
          activeTurnRef.current = null;
          setToolProgress(null);
          setIsLoading(false);
          return true;
        }
      }
      const dashboardText = dashboardPromptTextForAttachments(
        text,
        attachments,
      );
      const mergePendingRecoveredContinuation = (
        existing: DesktopSessionContinuationItem[],
      ): DesktopSessionContinuationItem[] => {
        if (pendingRecoveredContinuationRef.current.length === 0) {
          return existing;
        }
        const pending = pendingRecoveredContinuationRef.current;
        pendingRecoveredContinuationRef.current = [];
        return existing.length > 0 ? existing : pending;
      };
      const recordContinuationItems = async (
        items: DesktopSessionContinuationItem[],
      ): Promise<void> => {
        const storedSessionId = storedSessionIdRef.current;
        const recordContinuation = window.hermesAPI.recordSessionContinuation;
        if (
          dashboardShouldPersistLocalOverlays(connectionMode) &&
          storedSessionId &&
          items.length > 0 &&
          typeof recordContinuation === "function"
        ) {
          await recordContinuation(storedSessionId, items).catch(
            () => undefined,
          );
        }
      };
      const failActiveTurn = (message: string): true => {
        const activeTurn = activeTurnRef.current;
        if (activeTurn) activeTurn.status = "failed";
        if (pendingApprovalsRef.current.length) {
          expirePendingApprovalsRef.current();
          void clientRef.current
            ?.request("session.interrupt", {
              session_id: runtimeSessionIdRef.current,
            })
            .catch(() => undefined);
        }
        setMessages((prev) => markActiveTurnFailed(prev, message, activeTurn));
        const storedSessionId = storedSessionIdRef.current;
        const userContent = userContentById(
          messagesRef.current,
          activeTurn?.userId,
        );
        const recordLocalError = window.hermesAPI.recordSessionLocalError;
        if (
          dashboardShouldPersistLocalOverlays(connectionMode) &&
          storedSessionId &&
          userContent &&
          typeof recordLocalError === "function"
        ) {
          void recordLocalError(storedSessionId, {
            userContent,
            error: message,
          }).catch(() => undefined);
        }
        activeTurnRef.current = null;
        setToolProgress(null);
        setIsLoading(false);
        return true;
      };
      if (dashboardText === null) {
        if (fallbackOnUnavailable) return false;
        return failActiveTurn(
          "Dashboard chat supports image attachments only in this build. Use Auto or Legacy for mixed file attachments.",
        );
      }

      let client: DashboardGatewayClient;
      try {
        client = await ensureClient();
      } catch (err) {
        // Dashboard was reachable but the chat WS wouldn't connect: do NOT fall
        // back to the /v1 path — over the dashboard tunnel /v1 doesn't exist and
        // 405s. Surface the error so the user retries on the same transport.
        if (
          (err as { dashboardWasReachable?: boolean })?.dashboardWasReachable
        ) {
          const message = err instanceof Error ? err.message : String(err);
          return failActiveTurn(message);
        }
        if (fallbackOnUnavailable) {
          console.warn("Falling back to legacy chat transport.", err);
          return false;
        }
        const message = err instanceof Error ? err.message : String(err);
        return failActiveTurn(message);
      }

      try {
        let continuationItems: DesktopSessionContinuationItem[] = [];
        const forceCreateRuntime = recreateRuntimeSessionRef.current;
        if (recreateRuntimeSessionRef.current) {
          continuationItems = dashboardContinuationItemsFromTranscript(
            messagesRef.current,
            { excludeUserId: activeTurnRef.current?.userId ?? null },
          );
          const staleRuntimeSessionId = runtimeSessionIdRef.current;
          if (staleRuntimeSessionId) {
            await client
              .request("session.close", { session_id: staleRuntimeSessionId })
              .catch(() => undefined);
          }
          runtimeSessionIdRef.current = null;
          setPendingApprovals([]);
          reasoningSegmentClosedRef.current = false;
          appliedModelRef.current = null;
        }
        const runtimeSessionId = await ensureRuntimeSession(client, {
          forceCreate: forceCreateRuntime,
        });
        if (
          lastRuntimeSessionWasCreatedRef.current ||
          pendingRecoveredContinuationRef.current.length > 0
        ) {
          continuationItems =
            mergePendingRecoveredContinuation(continuationItems);
        } else {
          continuationItems = [];
        }
        await recordContinuationItems(continuationItems);
        const selectedSessionId = await ensureSelectedModel(
          client,
          runtimeSessionId,
        );
        await recordContinuationItems(mergePendingRecoveredContinuation([]));
        const syncedAttachments = await syncDashboardAttachments(
          client,
          selectedSessionId,
          attachments,
        );
        if (!syncedAttachments.handled) {
          if (fallbackOnUnavailable) return false;
          return failActiveTurn(
            "Hermes dashboard could not attach the selected file. Use Auto or Legacy to fall back to the legacy attachment path.",
          );
        }
        const submitText = dashboardPromptTextWithAttachmentRefs(
          dashboardText,
          syncedAttachments.refs,
        );
        const approvalNonceBeforeSubmit = approvalNonceRef.current;
        await submitDashboardPromptWithRecovery(client, {
          canRecover: () =>
            approvalNonceRef.current === approvalNonceBeforeSubmit,
          sessionId: selectedSessionId,
          storedSessionId: storedSessionIdRef.current,
          text: submitText,
          profile,
          onRecoveredSessionId: (recoveredSessionId) => {
            runtimeSessionIdRef.current = recoveredSessionId;
          },
        });
        return true;
      } catch (err) {
        appliedModelRef.current = null;
        recreateRuntimeSessionRef.current = true;
        const message = err instanceof Error ? err.message : String(err);
        return failActiveTurn(message);
      }
    },
    [
      activeTurnRef,
      respondClarify,
      connectionMode,
      enabled,
      setPendingApprovals,
      fallbackOnUnavailable,
      ensureClient,
      ensureRuntimeSession,
      ensureSelectedModel,
      syncDashboardAttachments,
      messagesRef,
      setIsLoading,
      setMessages,
      setToolProgress,
      profile,
    ],
  );

  const respondApproval = useCallback(
    async (requestId: string, choice: ApprovalChoice): Promise<boolean> => {
      const pending = pendingApprovalsRef.current[0];
      const runtimeSessionId = runtimeSessionIdRef.current;
      if (
        !enabled ||
        !pending ||
        pending.responding ||
        !pending.gatewayRequestId ||
        pending.requestId !== requestId ||
        pending.sessionId !== runtimeSessionId ||
        !pending.choices.includes(choice)
      ) {
        return false;
      }

      const client = clientRef.current;
      if (!client?.connected) return false;
      pending.responding = true;
      try {
        const result = await client.request<{ resolved?: unknown }>(
          "approval.respond",
          {
            session_id: pending.sessionId,
            request_id: pending.gatewayRequestId,
            choice,
            all: false,
          },
        );
        if (pendingApprovalsRef.current[0] !== pending) return false;
        if (result?.resolved !== 1) {
          expirePendingApprovalsRef.current(true);
          void client
            .request("session.interrupt", { session_id: pending.sessionId })
            .catch(() => undefined);
          return false;
        }
        setPendingApprovals(pendingApprovalsRef.current.slice(1));
        return true;
      } catch {
        return false;
      } finally {
        if (pendingApprovalsRef.current[0] === pending) {
          pending.responding = false;
        }
      }
    },
    [enabled, setPendingApprovals],
  );

  const execSlash = useCallback(
    async (
      command: string,
      sys: (text: string) => void,
    ): Promise<SlashExecOutcome> => {
      if (!enabled) {
        return { kind: "error", message: "dashboard transport disabled" };
      }
      try {
        const client = await ensureClient();
        const runtimeSessionId = await ensureRuntimeSession(client);
        const sessionId = await ensureSelectedModel(client, runtimeSessionId);
        return await executeSlash({
          command,
          sessionId,
          request: (method, params) => client.request(method, params),
          sys,
        });
      } catch (err) {
        return {
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    [enabled, ensureClient, ensureRuntimeSession, ensureSelectedModel],
  );

  const getCommandCatalog =
    useCallback(async (): Promise<AgentCommandsCatalogResponse> => {
      if (!enabled) {
        throw new Error("dashboard transport disabled");
      }
      const client = await ensureClient();
      return client.request<AgentCommandsCatalogResponse>(
        "commands.catalog",
        {},
      );
    }, [enabled, ensureClient]);

  const runBackground = useCallback(
    async (text: string): Promise<{ taskId?: string; error?: string }> => {
      if (!enabled) return { error: "dashboard transport disabled" };
      try {
        const client = await ensureClient();
        const runtimeSessionId = await ensureRuntimeSession(client);
        const sessionId = await ensureSelectedModel(client, runtimeSessionId);
        const r = await client.request<{ task_id?: string }>(
          "prompt.background",
          {
            session_id: sessionId,
            text,
            ...(profile && profile !== "default" ? { profile } : {}),
          },
        );
        return { taskId: r?.task_id };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    [enabled, ensureClient, ensureRuntimeSession, ensureSelectedModel, profile],
  );

  const toggleSessionYolo = useCallback(
    async (next: boolean): Promise<boolean> => {
      if (!enabled) return false;
      const client = clientRef.current;
      if (!client?.connected) return false;
      let sessionId = runtimeSessionIdRef.current;
      if (!sessionId) {
        // No runtime session yet (chat idle since open) — create/resume one so
        // the flag attaches to the session the next prompt will run in.
        try {
          sessionId = await ensureRuntimeSession(client);
        } catch {
          return false;
        }
      }
      if (!sessionId || clientRef.current !== client) return false;
      try {
        const result = await client.request<{ value?: string }>("config.set", {
          key: "yolo",
          value: next ? "1" : "0",
          scope: "session",
          session_id: sessionId,
        });
        // Persist the user's choice per stored session (issue #115) so a
        // backend restart can restore it. Keyed by the STORED id, which is
        // stable across app restarts, unlike the runtime id.
        if (clientRef.current === client) {
          writeStoredSessionYolo(
            connectionId,
            profile,
            storedSessionIdRef.current ?? sessionId,
            next,
          );
        }
        // Optimistically mirror the requested state; the authoritative
        // session.info emitted by the backend lands a beat later and corrects
        // any drift (e.g. approvals.mode=off keeps yolo true after "off").
        if (clientRef.current === client) {
          sessionYoloSessionRef.current = sessionId;
          setSessionYolo(next);
        }
        return result?.value !== undefined ? result.value === "1" : next;
      } catch {
        return false;
      }
    },
    [enabled, ensureRuntimeSession, connectionId, profile],
  );

  const abort = useCallback(() => {
    expirePendingClarifyRef.current();
    expirePendingApprovalsRef.current();
    const client = clientRef.current;
    const sessionId = runtimeSessionIdRef.current;
    if (!enabled || !client || !sessionId) return;
    void client
      .request("session.interrupt", { session_id: sessionId })
      .catch(() => {
        client.close();
      });
  }, [enabled]);

  // Catch a chat up after its transport was torn down mid-turn (issue #76):
  // reconnect, resume the stored session (the backend re-attaches the event
  // stream of a STILL-RUNNING session via _resume_reuse_live, so further
  // deltas/complete stream live again), and reconcile the transcript with the
  // canonical state.db rows so anything emitted while detached appears.
  // Failure is silent by design: the user can still send a new prompt, and
  // ensureRuntimeSession performs the same resume on the next send.
  const resyncAfterDetach = useCallback(async (): Promise<void> => {
    // @lat: [[dashboard-detach#Resync on reactivation]]
    if (!enabled) return;
    const storedSessionId = storedSessionIdRef.current;
    if (!storedSessionId) return;
    try {
      const client = await ensureClient();
      if (clientRef.current !== client) return;
      const response = await ensureRuntimeSession(client);
      // ensureRuntimeSession seeds the run state (spinner/Stop) from the
      // resume response's `running` flag when the turn is still live (issue
      // #109); a finished turn leaves the retired marker's state as-is.
      void response;
      // Transcript catch-up over the canonical DB — the same path the legacy
      // transport's end-of-stream refresh uses. Requires the raw DB items;
      // getSessionMessages returns them per connection/profile.
      const items = (await window.hermesAPI.getSessionMessages(
        storedSessionIdRef.current ?? storedSessionId,
        connectionId,
        profile,
      )) as unknown[];
      const dbMessages = dbItemsToChatMessages(items as DbHistoryItem[]);
      if (dbMessages.length > 0) {
        flushDeltasNow(
          reconcileAfterDbRefresh(messagesRef.current, dbMessages, {}),
        );
      }
      detachedSessionIdRef.current = null;
      setDetachedSessionId(null);
    } catch {
      // Leave the marker; a manual prompt retries the resume path.
    }
  }, [
    connectionId,
    ensureClient,
    ensureRuntimeSession,
    flushDeltasNow,
    messagesRef,
    profile,
    enabled,
  ]);
  resyncAfterDetachRef.current = resyncAfterDetach;

  useEffect(
    () => () => {
      expirePendingClarifyRef.current();
      expirePendingApprovalsRef.current();
      clientRef.current?.close();
      clientRef.current = null;
    },
    [],
  );

  return {
    abort,
    enabled,
    hasDetachedTurn: detachedSessionId !== null,
    hasPendingApproval,
    resyncAfterDetach,
    sessionYolo,
    toggleSessionYolo,
    respondApproval,
    respondClarify,
    sendMessage,
    execSlash,
    getCommandCatalog,
    runBackground,
  };
}
