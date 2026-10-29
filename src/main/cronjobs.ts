import { existsSync } from "fs";
import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { HERMES_HOME, HERMES_PYTHON, hermesCliArgs } from "./installer";
import { profileHome, getActiveProfileNameSync } from "./utils";
import {
  isRemoteMode,
  isRemoteOnlyMode,
  getApiUrl,
  getRemoteAuthHeader,
  normaliseRemoteUrl,
} from "./hermes";
import { remoteDashboardRequestJson } from "./remote-api";
import { probeRemoteAuthMode } from "./remote-oauth";
import { dashboardApiUrl } from "./remote-sessions";
import {
  getActiveConnection,
  getConnectionConfig,
  type ConnectionConfig,
} from "./config";
import { HIDDEN_SUBPROCESS_OPTIONS } from "./process-options";
import { sshRunCron } from "./ssh-remote";
import type { SshConfig } from "./ssh-tunnel";

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  state: "active" | "paused" | "completed";
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  repeat: { times: number | null; completed: number } | null;
  deliver: string[];
  skills: string[];
  script: string | null;
}

function jobsFilePath(profile?: string): string {
  return join(profileHome(profile), "cron", "jobs.json");
}

function normalizeJob(job: Record<string, unknown>): CronJob | null {
  if (!job.id) return null;
  const enabled = job.enabled !== false;
  let state: CronJob["state"] = "active";
  if (job.state === "completed") state = "completed";
  else if (job.state === "paused" || !enabled) state = "paused";
  const schedule = job.schedule as { value?: string } | string | undefined;
  return {
    id: String(job.id),
    name: (job.name as string) || "(unnamed)",
    schedule:
      (job.schedule_display as string) ||
      (typeof schedule === "object" ? schedule?.value : schedule) ||
      "?",
    prompt: (job.prompt as string) || "",
    state,
    enabled,
    next_run_at: (job.next_run_at as string) || null,
    last_run_at: (job.last_run_at as string) || null,
    last_status: (job.last_status as string) || null,
    last_error: (job.last_error as string) || null,
    repeat: (job.repeat as CronJob["repeat"]) || null,
    deliver: Array.isArray(job.deliver)
      ? (job.deliver as string[])
      : job.deliver
        ? [job.deliver as string]
        : ["local"],
    skills:
      (job.skills as string[]) || (job.skill ? [job.skill as string] : []),
    script: (job.script as string) || null,
  };
}

function parseCronState(raw: string | undefined): CronJob["state"] {
  const state = (raw || "").trim().toLowerCase();
  if (state === "paused") return "paused";
  if (state === "completed") return "completed";
  return "active";
}

function parseRepeat(value: string | undefined): CronJob["repeat"] {
  const raw = (value || "").trim();
  if (!raw) return null;
  if (raw === "∞" || raw.toLowerCase() === "infinite") {
    return { times: null, completed: 0 };
  }
  const fraction = raw.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fraction) {
    return {
      completed: Number(fraction[1]),
      times: Number(fraction[2]),
    };
  }
  const times = Number(raw);
  return Number.isFinite(times) ? { times, completed: 0 } : null;
}

function splitCsvish(value: string | undefined): string[] {
  const raw = (value || "").trim();
  if (!raw) return [];
  return raw
    .split(/,\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseLastRun(value: string | undefined): {
  last_run_at: string | null;
  last_status: string | null;
} {
  const raw = (value || "").trim();
  if (!raw) return { last_run_at: null, last_status: null };
  const match = raw.match(/^(.+?)(?:\s{2,}(\S.*))?$/);
  return {
    last_run_at: match?.[1]?.trim() || raw,
    last_status: match?.[2]?.trim() || null,
  };
}

export function parseCronListOutput(output: string): CronJob[] {
  const jobs: CronJob[] = [];
  let current: {
    id: string;
    state: CronJob["state"];
    fields: Record<string, string>;
  } | null = null;

  function flush(): void {
    if (!current) return;
    const lastRun = parseLastRun(current.fields["Last run"]);
    const state = current.state;
    const deliver = splitCsvish(current.fields.Deliver);
    jobs.push({
      id: current.id,
      name: current.fields.Name || "(unnamed)",
      schedule: current.fields.Schedule || "?",
      prompt: current.fields.Prompt || "",
      state,
      enabled: state === "active",
      next_run_at: current.fields["Next run"] || null,
      last_run_at: lastRun.last_run_at,
      last_status: lastRun.last_status,
      last_error: current.fields.Error || null,
      repeat: parseRepeat(current.fields.Repeat),
      deliver: deliver.length > 0 ? deliver : ["local"],
      skills: splitCsvish(current.fields.Skills),
      script: current.fields.Script || null,
    });
    current = null;
  }

  for (const line of output.split(/\r?\n/)) {
    const jobMatch = line.match(/^\s*([A-Za-z0-9_-]+)\s+\[([^\]]+)\]\s*$/);
    if (jobMatch) {
      flush();
      current = {
        id: jobMatch[1],
        state: parseCronState(jobMatch[2]),
        fields: {},
      };
      continue;
    }

    if (!current) continue;
    const fieldMatch = line.match(/^\s{2,}([^:]+):\s*(.*)$/);
    if (fieldMatch) {
      current.fields[fieldMatch[1].trim()] = fieldMatch[2].trim();
    }
  }

  flush();
  return jobs;
}

function getSshCronConfig(profile?: string): SshConfig | null {
  if (!profile || profile === "default" || !isRemoteMode()) return null;
  const conn = getConnectionConfig();
  return conn.mode === "ssh" && conn.ssh ? conn.ssh : null;
}

async function runNamedProfileSshCron(
  args: string[],
  profile?: string,
): Promise<{ success: boolean; output: string; error?: string } | null> {
  const ssh = getSshCronConfig(profile);
  if (!ssh) return null;
  const res = await sshRunCron(ssh, args, { profile, timeoutMs: 15000 });
  return {
    success: res.success,
    output: res.stdout || "",
    error: res.error,
  };
}

// ---- SSH-tunnel cron helpers (flavor-probing fetch; only used when the
// connection rides the SSH tunnel, whose local port may point at either the
// unified dashboard or the legacy gateway api_server). ----

async function sshCronFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    ...getRemoteAuthHeader(),
    ...((init.headers as Record<string, string>) || {}),
  };
  return fetch(`${await getSshCronApiUrl(headers)}${path}`, {
    ...init,
    headers,
  });
}

async function getSshCronApiUrl(
  headers: Record<string, string>,
): Promise<string> {
  try {
    return getApiUrl();
  } catch (err) {
    const conn = getConnectionConfig();
    if (conn.mode !== "ssh" || !conn.ssh?.localPort) throw err;

    // Schedules/Cron can be opened without first running the Chat path that
    // starts/refreshes the in-process SSH tunnel state. As a narrow fallback for
    // that screen, probe the configured/default local SSH port before using it.
    // This port may be stale if startSshTunnel() had to choose a different free
    // port, so a failed /health check preserves getApiUrl()'s original error
    // instead of sending authenticated API requests to an unrelated service.
    const fallbackUrl = normaliseRemoteUrl(
      `http://127.0.0.1:${conn.ssh.localPort}`,
    );
    if (await isSshCronFallbackHealthy(fallbackUrl, headers))
      return fallbackUrl;
    throw err;
  }
}

async function isSshCronFallbackHealthy(
  apiUrl: string,
  headers: Record<string, string>,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`${apiUrl}/health`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function remoteJsonError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: string;
      detail?: string;
    };
    // FastAPI dashboards put the message in `detail`; the gateway api_server
    // uses `error`. Surface whichever is present.
    return body.error || body.detail || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

// The remote HTTP cron surface has two flavors, disjoint by endpoint:
// - the gateway api_server (`/v1` transport): `/api/jobs` with a
//   `{jobs: [...]}` wrapper and `POST .../run` to fire;
// - the unified dashboard (`/api/*` transport): `/api/cron/jobs` with a bare
//   array response and `POST .../trigger` to fire.
// Asking one for the other's route is a silent 404 — the Schedules screen
// rendered empty against a dashboard because `/api/jobs` does not exist
// there. Probe before each operation (uncached: the local tunnel port is
// stable but the remote target behind it flips dashboard↔gateway when the
// user switches chat transport, so a cached flavor would go stale).
type RemoteCronFlavor = "dashboard" | "legacy";

async function remoteCronFlavor(
  headers: Record<string, string>,
): Promise<RemoteCronFlavor> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(
      `${await getSshCronApiUrl(headers)}/api/cron/jobs`,
      {
        method: "GET",
        headers,
        signal: controller.signal,
      },
    );
    return res.ok ? "dashboard" : "legacy";
  } catch {
    // Unreachable remote / dead tunnel: keep the legacy routes so the
    // subsequent request fails with the same behavior as before.
    return "legacy";
  } finally {
    clearTimeout(timeout);
  }
}

// Direct remote (HTTP) connections always talk to the unified dashboard, whose
// auth may be OAuth (cookie jar) rather than a static token.
// remoteDashboardRequestJson resolves the auth mode (including the auto probe)
// and routes oauth connections through the Electron cookie session — the same
// request boundary every other remote-parity screen uses. Do NOT call
// remoteRequestJson directly here: without the connection's mode/authMode it
// silently falls back to the token transport and a gated dashboard 401s.
async function remoteCronJson<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
  } = {},
  profile?: string,
): Promise<T> {
  const conn = getConnectionConfig();
  return remoteDashboardRequestJson<T>(conn, path, options, profile);
}

function remoteCronErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read cron jobs from the jobs.json file (async to avoid blocking the main process).
 * In remote mode, fetches from the Hermes API server's /api/jobs endpoint instead.
 */
export async function listCronJobs(
  includeDisabled = true,
  profile?: string,
): Promise<CronJob[]> {
  const sshResult = await runNamedProfileSshCron(
    includeDisabled ? ["list", "--all"] : ["list"],
    profile,
  );
  if (sshResult) {
    if (!sshResult.success) {
      console.error("[CRON] remote SSH list failed:", sshResult.error);
      return [];
    }
    const jobs = parseCronListOutput(sshResult.output);
    return includeDisabled ? jobs : jobs.filter((job) => job.enabled);
  }

  if (isRemoteOnlyMode()) {
    // Direct remote: unified dashboard REST through the oauth-aware transport.
    try {
      const raw = await remoteCronJson<Record<string, unknown>[]>(
        "/api/cron/jobs",
        {},
        profile,
      );
      const jobs: CronJob[] = [];
      for (const job of raw) {
        const normalized = normalizeJob(job);
        if (!normalized) continue;
        if (!includeDisabled && !normalized.enabled) continue;
        jobs.push(normalized);
      }
      return jobs;
    } catch (err) {
      console.error("[CRON] remote list error:", remoteCronErrorMessage(err));
      return [];
    }
  }

  if (isRemoteMode()) {
    // SSH tunnel: flavor-probe between dashboard and gateway api_server.
    try {
      const headers = getRemoteAuthHeader();
      const flavor = await remoteCronFlavor(headers);
      const profileQs =
        profile && profile !== "default"
          ? `${includeDisabled ? "&" : "?"}profile=${encodeURIComponent(profile)}`
          : "";
      const path =
        flavor === "dashboard"
          ? `/api/cron/jobs${includeDisabled ? "?include_disabled=true" : ""}${profileQs}`
          : `/api/jobs${includeDisabled ? "?include_disabled=true" : ""}`;
      const res = await sshCronFetch(path);
      if (!res.ok) {
        console.error("[CRON] remote list failed:", await remoteJsonError(res));
        return [];
      }
      const body = (await res.json()) as
        | Record<string, unknown>[]
        | { jobs?: Record<string, unknown>[] };
      const raw = Array.isArray(body) ? body : body.jobs || [];
      const jobs: CronJob[] = [];
      for (const job of raw) {
        const normalized = normalizeJob(job);
        if (!normalized) continue;
        if (!includeDisabled && !normalized.enabled) continue;
        jobs.push(normalized);
      }
      return jobs;
    } catch (err) {
      console.error("[CRON] remote list error:", err);
      return [];
    }
  }

  const filePath = jobsFilePath(profile);
  if (!existsSync(filePath)) return [];

  try {
    const content = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    const raw = Array.isArray(parsed) ? parsed : parsed.jobs || [];
    const jobs: CronJob[] = [];

    for (const job of raw) {
      const normalized = normalizeJob(job);
      if (!normalized) continue;
      if (!includeDisabled && !normalized.enabled) continue;
      jobs.push(normalized);
    }

    return jobs;
  } catch (err) {
    console.error("[CRON] Failed to read jobs file:", err);
    return [];
  }
}

/**
 * Run a hermes cron CLI command and return the result.
 */
function runCronCommand(
  args: string[],
  profile?: string,
): Promise<{ success: boolean; output: string; error?: string }> {
  const cliArgs = hermesCliArgs();
  if (profile && profile !== "default") {
    cliArgs.push("-p", profile);
  }
  cliArgs.push("cron", ...args);

  return new Promise((resolve) => {
    execFile(
      HERMES_PYTHON,
      cliArgs,
      {
        cwd: join(HERMES_HOME, "hermes-agent"),
        timeout: 15000,
        ...HIDDEN_SUBPROCESS_OPTIONS,
      },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            success: false,
            output: stdout || "",
            error: stderr || err.message,
          });
        } else {
          resolve({ success: true, output: stdout || "" });
        }
      },
    );
  });
}

export async function createCronJob(
  schedule: string,
  prompt?: string,
  name?: string,
  deliver?: string,
  profile?: string,
): Promise<{ success: boolean; error?: string }> {
  const args = ["create", schedule];
  if (prompt) args.push(prompt);
  if (name) args.push("--name", name);
  if (deliver) args.push("--deliver", deliver);

  const sshResult = await runNamedProfileSshCron(args, profile);
  if (sshResult) {
    return { success: sshResult.success, error: sshResult.error };
  }

  if (isRemoteOnlyMode()) {
    // Direct remote: unified dashboard REST through the oauth-aware transport.
    try {
      await remoteCronJson(
        "/api/cron/jobs",
        {
          method: "POST",
          body: {
            name: name || "",
            schedule,
            prompt: prompt || "",
            deliver: deliver || "local",
          },
        },
        profile,
      );
      return { success: true };
    } catch (err) {
      return { success: false, error: remoteCronErrorMessage(err) };
    }
  }

  if (isRemoteMode()) {
    // SSH tunnel: flavor-probe between dashboard and gateway api_server.
    try {
      const headers = getRemoteAuthHeader();
      const flavor = await remoteCronFlavor(headers);
      const path =
        flavor === "dashboard"
          ? `/api/cron/jobs${profile && profile !== "default" ? `?profile=${encodeURIComponent(profile)}` : ""}`
          : "/api/jobs";
      const res = await sshCronFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name || "",
          schedule,
          prompt: prompt || "",
          deliver: deliver || "local",
        }),
      });
      if (!res.ok) {
        return { success: false, error: await remoteJsonError(res) };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  const result = await runCronCommand(args, profile);
  return { success: result.success, error: result.error };
}

export async function removeCronJob(
  jobId: string,
  profile?: string,
): Promise<{ success: boolean; error?: string }> {
  if (!jobId) return { success: false, error: "Missing job ID" };
  const sshResult = await runNamedProfileSshCron(["remove", jobId], profile);
  if (sshResult) {
    return { success: sshResult.success, error: sshResult.error };
  }
  if (isRemoteOnlyMode()) {
    // Direct remote: unified dashboard REST through the oauth-aware transport.
    try {
      await remoteCronJson(
        `/api/cron/jobs/${encodeURIComponent(jobId)}`,
        { method: "DELETE" },
        profile,
      );
      return { success: true };
    } catch (err) {
      return { success: false, error: remoteCronErrorMessage(err) };
    }
  }

  if (isRemoteMode()) {
    // SSH tunnel: flavor-probe between dashboard and gateway api_server.
    try {
      const headers = getRemoteAuthHeader();
      const flavor = await remoteCronFlavor(headers);
      const base =
        flavor === "dashboard"
          ? `/api/cron/jobs/${encodeURIComponent(jobId)}`
          : `/api/jobs/${encodeURIComponent(jobId)}`;
      const qs =
        flavor === "dashboard" && profile && profile !== "default"
          ? `?profile=${encodeURIComponent(profile)}`
          : "";
      const res = await sshCronFetch(`${base}${qs}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        return { success: false, error: await remoteJsonError(res) };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
  const result = await runCronCommand(["remove", jobId], profile);
  return { success: result.success, error: result.error };
}

async function remoteJobAction(
  jobId: string,
  action: "pause" | "resume" | "run",
  profile?: string,
): Promise<{ success: boolean; error?: string }> {
  const sshResult = await runNamedProfileSshCron([action, jobId], profile);
  if (sshResult) {
    return { success: sshResult.success, error: sshResult.error };
  }
  if (!isRemoteOnlyMode()) {
    // SSH tunnel: no unified transport — the local port may point at either
    // the dashboard or the gateway api_server, so probe the flavor and use
    // bare fetch with the tunnel auth header, as before.
    try {
      const headers = getRemoteAuthHeader();
      const flavor = await remoteCronFlavor(headers);
      // The dashboard fires a job with POST .../trigger; the gateway
      // api_server uses POST .../run for the same action.
      const actionPath =
        action === "run" && flavor === "dashboard" ? "trigger" : action;
      const qs =
        flavor === "dashboard" && profile && profile !== "default"
          ? `?profile=${encodeURIComponent(profile)}`
          : "";
      const res = await sshCronFetch(
        flavor === "dashboard"
          ? `/api/cron/jobs/${encodeURIComponent(jobId)}/${actionPath}${qs}`
          : `/api/jobs/${encodeURIComponent(jobId)}/${actionPath}`,
        { method: "POST" },
      );
      if (!res.ok) {
        return { success: false, error: await remoteJsonError(res) };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
  // Direct remote: dashboard REST through the oauth-aware transport.
  try {
    // The dashboard fires a job with POST .../trigger; the gateway
    // api_server uses POST .../run for the same action.
    const actionPath = action === "run" ? "trigger" : action;
    await remoteCronJson(
      `/api/cron/jobs/${encodeURIComponent(jobId)}/${actionPath}`,
      { method: "POST" },
      profile,
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: remoteCronErrorMessage(err) };
  }
}

export async function pauseCronJob(
  jobId: string,
  profile?: string,
): Promise<{ success: boolean; error?: string }> {
  if (!jobId) return { success: false, error: "Missing job ID" };
  if (isRemoteMode()) return remoteJobAction(jobId, "pause", profile);
  const result = await runCronCommand(["pause", jobId], profile);
  return { success: result.success, error: result.error };
}

export async function resumeCronJob(
  jobId: string,
  profile?: string,
): Promise<{ success: boolean; error?: string }> {
  if (!jobId) return { success: false, error: "Missing job ID" };
  if (isRemoteMode()) return remoteJobAction(jobId, "resume", profile);
  const result = await runCronCommand(["resume", jobId], profile);
  return { success: result.success, error: result.error };
}

export async function triggerCronJob(
  jobId: string,
  profile?: string,
): Promise<{ success: boolean; error?: string }> {
  if (!jobId) return { success: false, error: "Missing job ID" };
  if (isRemoteMode()) return remoteJobAction(jobId, "run", profile);
  const result = await runCronCommand(["run", jobId], profile);
  return { success: result.success, error: result.error };
}

// This fork does not yet have the upstream shared profile-editor-target module.
// Keep the history binding local rather than importing unrelated editor changes.
export interface ProfileEditorTarget {
  connectionId: string;
  profile: string;
  mode: "local" | "remote" | "ssh";
  scopeToken: string;
}

const historyScopeKey = randomBytes(32);
let historyAuthRevision = 0;
let historyAuthChanges = 0;
const observedCookieStores = new WeakSet<Electron.Cookies>();

export function invalidateCronHistoryAuth(notify?: () => void): void {
  historyAuthRevision++;
  try {
    notify?.();
  } catch {
    // A closed window or failed UI delivery must never interrupt authentication.
  }
}

/** Cookie refresh/expiry also changes principal identity outside login IPC. */
export function observeCronHistoryCookies(
  cookies: Electron.Cookies,
  notify?: () => void,
): void {
  if (observedCookieStores.has(cookies)) return;
  observedCookieStores.add(cookies);
  cookies.on("changed", () => invalidateCronHistoryAuth(notify));
}

/** Fence history while a dashboard sign-in/logout changes its principal. */
export async function withCronHistoryAuthChange<T>(
  action: () => Promise<T>,
  notify?: () => void,
): Promise<T> {
  historyAuthChanges++;
  invalidateCronHistoryAuth(notify);
  try {
    return await action();
  } finally {
    historyAuthChanges--;
    invalidateCronHistoryAuth(notify);
  }
}

function historyScopeToken(connectionId: string, profile: string): string {
  const connection = getConnectionConfig(connectionId);
  if (connection.mode === "remote" && historyAuthChanges)
    throw new Error(
      "Remote sign-in is changing; reload history after it finishes.",
    );
  return createHmac("sha256", historyScopeKey)
    .update(
      JSON.stringify([
        connectionId,
        profile,
        connection,
        connection.mode === "remote" ? historyAuthRevision : 0,
      ]),
    )
    .digest("hex");
}

export function captureProfileEditorTarget(
  profile?: string,
  connectionId?: string,
): ProfileEditorTarget {
  const activeId = getActiveConnection().connectionId;
  if (connectionId && connectionId !== activeId)
    throw new Error("The editor connection is no longer selected.");
  const conn = getConnectionConfig(activeId);
  const selectedProfile =
    profile?.trim() ||
    (conn.mode === "remote" ? "default" : getActiveProfileNameSync());
  return {
    connectionId: activeId,
    profile: selectedProfile,
    mode: conn.mode,
    scopeToken: historyScopeToken(activeId, selectedProfile),
  };
}

function historyTarget(
  profile?: string,
  target?: ProfileEditorTarget,
): {
  connection: ConnectionConfig;
  profile: string;
  assertCurrent: () => void;
} {
  const captured = captureProfileEditorTarget(
    profile ?? target?.profile,
    target?.connectionId,
  );
  const matches = (a: ProfileEditorTarget, b: ProfileEditorTarget): boolean =>
    a.connectionId === b.connectionId &&
    a.profile === b.profile &&
    a.mode === b.mode &&
    a.scopeToken === b.scopeToken;
  if (target && !matches(captured, target))
    throw new Error("The editor target changed; reload history.");
  const activeProfile = getActiveProfileNameSync();
  const connection = structuredClone(
    getConnectionConfig(captured.connectionId),
  );
  return {
    connection,
    profile: captured.profile,
    assertCurrent: () => {
      const current = captureProfileEditorTarget(
        captured.profile,
        captured.connectionId,
      );
      if (
        !matches(captured, current) ||
        getActiveProfileNameSync() !== activeProfile
      )
        throw new Error(
          "The history connection, profile or authentication changed; reload history.",
        );
    },
  };
}

// ── Run history / output ────────────────────────────────────────────────────

export interface CronRun {
  /** Opaque run id: a `cron_<job>_<ts>` session id, `cron_output:<job>:<stem>`, or `file:<name>` locally. */
  id: string;
  source: string;
  started_at: number | string | null;
  ended_at: number | string | null;
  title: string;
  preview: string;
  message_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  is_active: boolean;
}

export interface CronRunsResult {
  success: boolean;
  runs: CronRun[];
  error?: string;
  /** The connection mode or server does not expose run history. */
  unsupported?: boolean;
}

export interface CronRunOutputResult {
  success: boolean;
  output: string;
  /** True when the text is only a preview of the real output. */
  partial?: boolean;
  /** True when the output was cut to fit MAX_RUN_OUTPUT_CHARS. */
  truncated?: boolean;
  error?: string;
  unsupported?: boolean;
}

const MAX_RUN_OUTPUT_CHARS = 200_000;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function clampRunOutput(text: string): { output: string; truncated: boolean } {
  return text.length > MAX_RUN_OUTPUT_CHARS
    ? { output: text.slice(0, MAX_RUN_OUTPUT_CHARS), truncated: true }
    : { output: text, truncated: false };
}

function remoteRunsUnsupported(err: unknown): boolean {
  const status = (err as { statusCode?: number } | null | undefined)
    ?.statusCode;
  return status === 404 || status === 405;
}

interface LocalRunDirectory {
  path: string;
  assertCurrent: () => Promise<void>;
}

/** Read a bounded prefix and bind the fd to the selected tree before release. */
async function readFilePreview(
  path: string,
  chars: number,
  directory: LocalRunDirectory,
): Promise<string> {
  const { open, lstat } = await import("fs/promises");
  // Reject an observed ancestor swap before sampling a potentially foreign leaf.
  // Recheck after open/read as well: O_NOFOLLOW protects only the final segment.
  await directory.assertCurrent();
  const expected = await lstat(path);
  if (!expected.isFile()) throw new Error("Run output is not a file.");
  const { constants } = await import("fs");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino
    )
      throw new Error("Run output changed while it was being opened.");
    const assertSelectedFile = async (): Promise<void> => {
      await directory.assertCurrent();
      const selected = await lstat(path);
      if (
        !selected.isFile() ||
        selected.dev !== opened.dev ||
        selected.ino !== opened.ino
      )
        throw new Error(
          "Run output no longer belongs to the selected directory.",
        );
      await directory.assertCurrent();
    };
    await assertSelectedFile();
    const buf = Buffer.alloc(chars * 4);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    await assertSelectedFile();
    return buf.toString("utf-8", 0, bytesRead).slice(0, chars);
  } finally {
    await handle.close();
  }
}

async function localRunDir(
  jobId: string,
  profile?: string,
): Promise<LocalRunDirectory> {
  const { lstat, realpath } = await import("fs/promises");
  const { relative, isAbsolute, sep } = await import("path");
  const root = profileHome("default");
  const selected = relative(root, profileHome(profile));
  if (isAbsolute(selected) || selected.split(sep).includes(".."))
    throw new Error("Run output profile is outside the Hermes home.");
  // The configured home (including a root symlink/junction) is trusted relocation.
  // Below it, neither the profiles container nor a named profile may be an alias.
  let dir = await realpath(root);
  const directories: { path: string; dev: number; ino: number }[] = [];
  for (const segment of [
    "",
    ...selected.split(sep).filter(Boolean),
    "cron",
    "output",
    jobId,
  ]) {
    dir = join(dir, segment);
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Run output directory is not a safe directory.");
    directories.push({ path: dir, dev: stat.dev, ino: stat.ino });
  }
  // Node has no portable openat-style directory-relative open. These identity
  // checks detect observed swaps (including restore around a read); they are
  // not an atomic sandbox against an attacker racing every pathname lookup.
  return {
    path: dir,
    assertCurrent: async () => {
      for (const expected of directories) {
        const current = await lstat(expected.path);
        if (
          !current.isDirectory() ||
          current.dev !== expected.dev ||
          current.ino !== expected.ino
        )
          throw new Error(
            "Run output directory changed while it was being read.",
          );
      }
    },
  };
}

function runLimit(limit: number): number {
  return Number.isFinite(limit)
    ? Math.max(1, Math.min(100, Math.floor(limit)))
    : 20;
}

function asRunNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeRun(
  raw: Record<string, unknown>,
  previewChars: number,
): CronRun {
  const time = (v: unknown): number | string | null =>
    typeof v === "string" ? v : asRunNumber(v);
  return {
    id: String(raw.id ?? ""),
    source: String(raw.source ?? ""),
    started_at: time(raw.started_at),
    ended_at: time(raw.ended_at),
    title: typeof raw.title === "string" ? raw.title.slice(0, 300) : "",
    preview:
      typeof raw.preview === "string" ? raw.preview.slice(0, previewChars) : "",
    message_count: asRunNumber(raw.message_count) ?? 0,
    input_tokens: asRunNumber(raw.input_tokens),
    output_tokens: asRunNumber(raw.output_tokens),
    is_active: raw.is_active === true,
  };
}

/** History is dashboard-only; never fall back to a gateway or local data. */
async function historyJson<T>(
  conn: ConnectionConfig,
  path: string,
  profile: string | undefined,
  assertCurrent: () => void,
): Promise<T> {
  assertCurrent();
  const mode =
    conn.remoteAuthMode === "auto"
      ? (await probeRemoteAuthMode(conn.remoteUrl)).authMode
      : conn.remoteAuthMode;
  assertCurrent();
  const scopedPath = `${path}${path.includes("?") ? "&" : "?"}profile=${encodeURIComponent(profile || "default")}`;
  let result: T;
  if (mode === "token" && !conn.apiKey.trim()) {
    const url = new URL(
      dashboardApiUrl({ remoteUrl: conn.remoteUrl, apiKey: "" }, scopedPath),
    );
    const headers: Record<string, string> = {};
    if (url.username || url.password) {
      headers.Authorization = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
      url.username = "";
      url.password = "";
    }
    const response = await fetch(url.toString(), {
      headers,
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw Object.assign(new Error(`Run history HTTP ${response.status}`), {
        statusCode: response.status,
      });
    result = (await response.json()) as T;
  } else {
    result = await remoteDashboardRequestJson<T>(
      { ...conn, remoteAuthMode: mode },
      scopedPath,
      {},
      profile,
    );
  }
  assertCurrent();
  return result;
}

async function remoteRunList(
  jobId: string,
  limit: number,
  conn: ConnectionConfig,
  profile: string | undefined,
  assertCurrent: () => void,
  previewChars = 300,
): Promise<CronRun[]> {
  const data = await historyJson<{ runs: unknown }>(
    conn,
    `/api/cron/jobs/${encodeURIComponent(jobId)}/runs?limit=${runLimit(limit)}`,
    profile,
    assertCurrent,
  );
  if (
    !Array.isArray(data?.runs) ||
    data.runs.some(
      (row) =>
        !row ||
        typeof row !== "object" ||
        typeof row.id !== "string" ||
        !SAFE_SEGMENT.test(row.id),
    )
  )
    throw new Error("Run history response was invalid.");
  return data.runs
    .slice(0, runLimit(limit))
    .map((row) => normalizeRun(row, previewChars));
}

/** Newest markdown outputs for the selected local profile. */
export async function listCronRuns(
  jobId: string,
  limit = 20,
  profile?: string,
  target?: ProfileEditorTarget,
): Promise<CronRunsResult> {
  try {
    if (typeof jobId !== "string" || !SAFE_SEGMENT.test(jobId))
      throw new Error("Invalid job ID");
    if (getConnectionConfig().mode === "ssh")
      return {
        success: false,
        runs: [],
        unsupported: true,
        error: "Run history is not available over SSH yet.",
      };
    const resolved = historyTarget(profile, target);
    const { connection: conn, assertCurrent } = resolved;
    profile = resolved.profile;
    if (conn.mode === "remote") {
      const runs = await remoteRunList(
        jobId,
        limit,
        conn,
        profile,
        assertCurrent,
      );
      assertCurrent();
      return { success: true, runs };
    }
    let directory: LocalRunDirectory;
    try {
      directory = await localRunDir(jobId, profile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        assertCurrent();
        return { success: true, runs: [] };
      }
      throw error;
    }
    const dir = directory.path;
    const { readdir, lstat } = await import("fs/promises");
    const stats = await Promise.all(
      (await readdir(dir))
        .filter((name) => name.endsWith(".md") && SAFE_SEGMENT.test(name))
        .map(async (name) => {
          const stat = await lstat(join(dir, name));
          return stat.isFile() ? { name, mtimeMs: stat.mtimeMs } : null;
        }),
    );
    const newest = stats
      .filter(
        (entry): entry is { name: string; mtimeMs: number } => entry !== null,
      )
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, runLimit(limit));
    const runs = await Promise.all(
      newest.map(
        async ({ name, mtimeMs }): Promise<CronRun> => ({
          id: `file:${name}`,
          source: "cron_output",
          started_at: mtimeMs / 1000,
          ended_at: null,
          title: name.replace(/\.md$/, ""),
          preview: await readFilePreview(join(dir, name), 300, directory),
          message_count: 0,
          input_tokens: null,
          output_tokens: null,
          is_active: false,
        }),
      ),
    );
    await directory.assertCurrent();
    assertCurrent();
    return { success: true, runs };
  } catch (err) {
    return {
      success: false,
      runs: [],
      unsupported: remoteRunsUnsupported(err),
      error: remoteCronErrorMessage(err),
    };
  }
}

export async function getCronRunOutput(
  jobId: string,
  runId: string,
  profile?: string,
  target?: ProfileEditorTarget,
): Promise<CronRunOutputResult> {
  try {
    if (getConnectionConfig().mode === "ssh")
      return {
        success: false,
        output: "",
        unsupported: true,
        error: "Run output is not available over SSH yet.",
      };
    const resolved = historyTarget(profile, target);
    const { connection: conn, assertCurrent } = resolved;
    profile = resolved.profile;
    if (
      typeof jobId !== "string" ||
      typeof runId !== "string" ||
      !SAFE_SEGMENT.test(jobId) ||
      !SAFE_SEGMENT.test(runId)
    )
      throw new Error("Invalid run ID");
    if (conn.mode === "remote") {
      const runs = await remoteRunList(
        jobId,
        100,
        conn,
        profile,
        assertCurrent,
        MAX_RUN_OUTPUT_CHARS + 1,
      );
      assertCurrent();
      const run = runs.find((item) => item.id === runId);
      if (!run) throw new Error("Run not found in this job's history.");
      if (run.source === "cron_output")
        return { success: true, ...clampRunOutput(run.preview), partial: true };
      const data = await historyJson<{ messages: unknown }>(
        conn,
        `/api/sessions/${encodeURIComponent(runId)}/messages?order=oldest&limit=500`,
        profile,
        assertCurrent,
      );
      if (
        !Array.isArray(data?.messages) ||
        data.messages.some((message) => !message || typeof message !== "object")
      )
        throw new Error("Run output response was invalid.");
      const text = data.messages
        .slice(0, 500)
        .filter((m) => m.display_kind !== "hidden")
        .map((m) => {
          const role = String(m.role ?? "message");
          const raw = m.display_content ?? m.content;
          const content =
            typeof raw === "string" ? raw : raw ? JSON.stringify(raw) : "";
          return content.trim() ? `[${role}]\n${content}` : "";
        })
        .filter(Boolean)
        .join("\n\n");
      assertCurrent();
      return {
        success: true,
        ...clampRunOutput(text),
        partial: data.messages.length >= 500,
      };
    }
    if (
      !SAFE_SEGMENT.test(jobId) ||
      !runId.startsWith("file:") ||
      !SAFE_SEGMENT.test(runId.slice(5)) ||
      !runId.endsWith(".md")
    )
      throw new Error("Invalid run ID");
    const directory = await localRunDir(jobId, profile);
    const text = await readFilePreview(
      join(directory.path, runId.slice(5)),
      MAX_RUN_OUTPUT_CHARS + 1,
      directory,
    );
    await directory.assertCurrent();
    assertCurrent();
    return { success: true, ...clampRunOutput(text) };
  } catch (err) {
    return {
      success: false,
      output: "",
      unsupported: remoteRunsUnsupported(err),
      error: remoteCronErrorMessage(err),
    };
  }
}
