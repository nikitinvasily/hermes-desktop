import type { ConnectionConfig } from "./config";
import { remoteDashboardRequestJson } from "./remote-api";
import { remoteRequestJson } from "./remote-sessions";
import { remoteGetHermesHome } from "./remote-metadata";
import { parseMemoryLimitsConfig } from "./memory-limits";
import type { MemoryInfo, MemoryEntry } from "./memory";
import type { ToolsetInfo } from "./tools";
import type { MemoryProviderInfo } from "./installer";

// Remote (HTTP) mode routing for the Settings-family screens. Until now the
// corresponding IPC handlers fell through to LOCAL files in remote mode, so
// connected to a remote dashboard the app showed (and mutated!) the Mac's own
// ~/.hermes — issue #51. The dashboard serves the real state over REST:
//   config   → GET/PUT /api/config (deep-merge PUT; dotted paths unsupported —
//              use /api/config/raw for reads + /api/fs/write-text for surgical
//              writes, mirroring the YAML-splicing the SSH path does)
//   env      → GET /api/env (redacted) / GET /api/fs/read-text on the .env
//   memory   → /api/fs/read-text + /api/fs/write-text on MEMORY.md/USER.md
//   soul     → GET/PUT /api/profiles/{n}/soul (falling back to /api/fs)
//   logs     → GET /api/logs
//   toolsets → GET /api/tools/toolsets + PUT /api/tools/toolsets/{name}
//   profiles → GET /api/profiles, DELETE /api/profiles/{n},
//              POST /api/profiles/{n}/model for the model default
//   gateway  → GET /api/status (gateway_running), POST /api/gateway/start|stop
//   doctor   → POST /api/ops/doctor (spawned action; tail /api/actions)
// SSH mode keeps its own exec path (ssh-remote.ts) and is unaffected.
// @lat: [[connections#Connections#Session locations#Remote settings parity]]

type RemoteRecord = Record<string, unknown>;

function asRecord(value: unknown): RemoteRecord {
  return value && typeof value === "object" ? (value as RemoteRecord) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// ── paths on the remote host ────────────────────────────────────────────────

function remoteProfileHome(home: string, profile?: string): string {
  const trimmed = profile?.trim();
  if (!trimmed || trimmed === "default") return home;
  return `${home.replace(/\/+$/, "")}/profiles/${trimmed}`;
}

function remoteMemoryFilePath(home: string, profile?: string): string {
  return `${remoteProfileHome(home, profile)}/memories/MEMORY.md`;
}

function remoteUserFilePath(home: string, profile?: string): string {
  return `${remoteProfileHome(home, profile)}/memories/USER.md`;
}

function remoteSoulFilePath(home: string, profile?: string): string {
  return `${remoteProfileHome(home, profile)}/SOUL.md`;
}

function remoteEnvFilePath(home: string, profile?: string): string {
  return `${remoteProfileHome(home, profile)}/.env`;
}

function remoteConfigFilePath(home: string, profile?: string): string {
  return `${remoteProfileHome(home, profile)}/config.yaml`;
}

// Cached agent home — the same cache idea as remote-sessions' homes cache: the
// sidebar already pays one /api/profiles round trip, settings must not add one
// per field. Invalidated by remoteInvalidateSettingsCaches() on connection
// switches.
let cachedHermesHome: { home: string; at: number } | null = null;
const HOME_TTL_MS = 5 * 60 * 1000;

async function remoteHome(
  conn: ConnectionConfig,
  profile?: string,
): Promise<string> {
  if (cachedHermesHome && Date.now() - cachedHermesHome.at < HOME_TTL_MS) {
    return cachedHermesHome.home;
  }
  let home = await remoteGetHermesHome({ ...conn, profile });
  if (!home) {
    // A gated (non-loopback) dashboard deliberately omits hermes_home from the
    // PUBLIC /api/status payload (deployment recon stays loopback-only), so an
    // authenticated remote client cannot learn the home from status. The
    // profiles router is auth-gated (served through the same OAuth/token
    // transport as every other settings call) and reports each profile's path.
    const trimmed = profile?.trim();
    const wanted = !trimmed || trimmed === "default" ? null : trimmed;
    const rows = await remoteDashboardRequestJson<{ profiles?: unknown }>(
      { ...conn, apiKey: "" },
      "/api/profiles",
      {},
      profile,
    );
    const list = Array.isArray(rows?.profiles) ? rows.profiles : [];
    const match =
      (wanted
        ? list.find((row) => {
            const r = asRecord(row);
            return stringValue(r.name) === wanted;
          })
        : undefined) ??
      list.find((row) => asRecord(row).is_default === true) ??
      list[0];
    home = stringValue(asRecord(match).path);
  }
  if (!home)
    throw new Error("Remote dashboard did not report its Hermes home.");
  cachedHermesHome = { home, at: Date.now() };
  return home;
}

export function remoteInvalidateSettingsCaches(): void {
  cachedHermesHome = null;
}

// ── fs helpers over the dashboard REST API ─────────────────────────────────

async function remoteReadTextFile(
  conn: ConnectionConfig,
  path: string,
  profile?: string,
): Promise<string> {
  const data = await remoteDashboardRequestJson<{
    text?: string;
    truncated?: boolean;
  }>(conn, `/api/fs/read-text?path=${encodeURIComponent(path)}`, {}, profile);
  return stringValue(data?.text);
}

async function remoteWriteTextFile(
  conn: ConnectionConfig,
  path: string,
  content: string,
  profile?: string,
): Promise<void> {
  await remoteDashboardRequestJson(
    conn,
    "/api/fs/write-text",
    { method: "POST", body: { path, content } },
    profile,
  );
}

// ── memory entries (same serialization as memory.ts / ssh-remote.ts) ───────

// The local/SSH paths share the parser through memory.ts; import it instead of
// duplicating the entry format a third time.
import {
  parseMemoryEntries,
  serializeEntries,
  type MemoryEntry,
} from "./memory";

export async function remoteReadMemory(
  conn: ConnectionConfig,
  profile?: string,
): Promise<MemoryInfo> {
  const home = await remoteHome(conn, profile);
  // A missing USER.md/MEMORY.md is the normal "not written yet" state —
  // readMemory returns empty content for it locally; mirror that instead of
  // failing the whole read (a fresh remote home has neither file).
  const [memoryContent, userContent, configContent, stats] = await Promise.all([
    remoteReadTextFile(
      conn,
      remoteMemoryFilePath(home, profile),
      profile,
    ).catch(() => ""),
    remoteReadTextFile(conn, remoteUserFilePath(home, profile), profile).catch(
      () => "",
    ),
    remoteReadTextFile(
      conn,
      remoteConfigFilePath(home, profile),
      profile,
    ).catch(() => ""),
    remoteDashboardRequestJson(conn, "/api/status", {}, profile)
      .then(
        (s) =>
          ({
            totalSessions: numberValue(asRecord(s).active_sessions),
            totalMessages: 0,
          }) as { totalSessions: number; totalMessages: number },
      )
      .catch(
        () =>
          ({ totalSessions: 0, totalMessages: 0 }) as {
            totalSessions: number;
            totalMessages: number;
          },
      ),
  ]);
  const limits = parseMemoryLimitsConfig(configContent);

  return {
    memory: {
      content: memoryContent,
      exists: memoryContent.length > 0,
      lastModified: null,
      entries: parseMemoryEntries(memoryContent),
      charCount: memoryContent.length,
      charLimit: limits.memoryCharLimit,
    },
    user: {
      content: userContent,
      exists: userContent.length > 0,
      lastModified: null,
      charCount: userContent.length,
      charLimit: limits.userCharLimit,
    },
    stats,
  };
}

async function remoteRewriteMemoryFile(
  conn: ConnectionConfig,
  path: string,
  profile: string | undefined,
  limit: number,
  rewrite: (entries: MemoryEntry[]) => MemoryEntry[],
): Promise<{ success: boolean; error?: string }> {
  const current = await remoteReadTextFile(conn, path, profile);
  const entries = parseMemoryEntries(current);
  const next = serializeEntries(rewrite(entries));
  if (next.length > limit) {
    return {
      success: false,
      error: `Would exceed memory limit (${next.length}/${limit} chars)`,
    };
  }
  await remoteWriteTextFile(conn, path, next, profile);
  return { success: true };
}

export async function remoteAddMemoryEntry(
  conn: ConnectionConfig,
  content: string,
  profile?: string,
): Promise<{ success: boolean; error?: string }> {
  const home = await remoteHome(conn, profile);
  const configContent = await remoteReadTextFile(
    conn,
    remoteConfigFilePath(home, profile),
    profile,
  );
  const limits = parseMemoryLimitsConfig(configContent);
  return remoteRewriteMemoryFile(
    conn,
    remoteMemoryFilePath(home, profile),
    profile,
    limits.memoryCharLimit,
    (entries) => [
      ...entries,
      { index: entries.length, content: content.trim() },
    ],
  );
}

export async function remoteUpdateMemoryEntry(
  conn: ConnectionConfig,
  index: number,
  content: string,
  profile?: string,
): Promise<{ success: boolean; error?: string }> {
  const home = await remoteHome(conn, profile);
  const configContent = await remoteReadTextFile(
    conn,
    remoteConfigFilePath(home, profile),
    profile,
  );
  const limits = parseMemoryLimitsConfig(configContent);
  return remoteRewriteMemoryFile(
    conn,
    remoteMemoryFilePath(home, profile),
    profile,
    limits.memoryCharLimit,
    (entries) => {
      if (index < 0 || index >= entries.length) return entries;
      entries[index] = { ...entries[index], content: content.trim() };
      return entries;
    },
  );
}

export async function remoteRemoveMemoryEntry(
  conn: ConnectionConfig,
  index: number,
  profile?: string,
): Promise<boolean> {
  const home = await remoteHome(conn, profile);
  const result = await remoteRewriteMemoryFile(
    conn,
    remoteMemoryFilePath(home, profile),
    profile,
    Number.MAX_SAFE_INTEGER,
    (entries) => {
      if (index < 0 || index >= entries.length) return entries;
      entries.splice(index, 1);
      return entries;
    },
  );
  return result.success;
}

export async function remoteWriteUserProfile(
  conn: ConnectionConfig,
  content: string,
  profile?: string,
): Promise<{ success: boolean; error?: string }> {
  const home = await remoteHome(conn, profile);
  const configContent = await remoteReadTextFile(
    conn,
    remoteConfigFilePath(home, profile),
    profile,
  );
  const limits = parseMemoryLimitsConfig(configContent);
  if (content.length > limits.userCharLimit) {
    return {
      success: false,
      error: `Would exceed user profile limit (${content.length}/${limits.userCharLimit} chars)`,
    };
  }
  await remoteWriteTextFile(
    conn,
    remoteUserFilePath(home, profile),
    content,
    profile,
  );
  return { success: true };
}

// ── soul ────────────────────────────────────────────────────────────────────

export async function remoteReadSoul(
  conn: ConnectionConfig,
  profile?: string,
): Promise<string> {
  // Preferred: the dashboard's own soul route (works even when /api/fs is
  // restricted). Fallback: raw file read.
  try {
    const named = profile && profile !== "default" ? profile : "";
    const path = named
      ? `/api/profiles/${encodeURIComponent(named)}/soul`
      : "/api/profiles/default/soul";
    const data = await remoteDashboardRequestJson<{
      content?: string;
      soul?: string;
    }>(conn, path, {}, profile);
    const content = stringValue(data?.content ?? data?.soul);
    if (content) return content;
  } catch {
    // fall through to the fs route
  }
  const home = await remoteHome(conn, profile);
  return remoteReadTextFile(conn, remoteSoulFilePath(home, profile), profile);
}

export async function remoteWriteSoul(
  conn: ConnectionConfig,
  content: string,
  profile?: string,
): Promise<boolean> {
  try {
    const named = profile && profile !== "default" ? profile : "default";
    await remoteDashboardRequestJson(
      conn,
      `/api/profiles/${encodeURIComponent(named)}/soul`,
      { method: "PUT", body: { content } },
      profile,
    );
    return true;
  } catch {
    // Older dashboards without the soul route: write the file directly.
    const home = await remoteHome(conn, profile);
    await remoteWriteTextFile(
      conn,
      remoteSoulFilePath(home, profile),
      content,
      profile,
    );
    return true;
  }
}

export async function remoteResetSoul(
  conn: ConnectionConfig,
  profile?: string,
): Promise<string> {
  // There is no dedicated REST reset; restore the same shipped default the
  // local resetSoul and sshResetSoul write (identical template in both).
  const { DEFAULT_SOUL } = await import("./soul");
  const content = DEFAULT_SOUL;
  const ok = await remoteWriteSoul(conn, content, profile);
  if (!ok) throw new Error("Failed to reset SOUL.md on the remote dashboard.");
  return content;
}

// ── toolsets ────────────────────────────────────────────────────────────────

export async function remoteGetToolsets(
  conn: ConnectionConfig,
  profile?: string,
): Promise<ToolsetInfo[]> {
  const data = await remoteDashboardRequestJson<unknown>(
    conn,
    "/api/tools/toolsets",
    {},
    profile,
  );
  const rows = Array.isArray(data) ? data : [];
  return rows
    .map((row): ToolsetInfo | null => {
      const r = asRecord(row);
      const key = stringValue(r.name);
      if (!key) return null;
      return {
        key,
        label: stringValue(r.label) || key,
        description: stringValue(r.description),
        enabled: r.enabled === true || r.available === true,
      };
    })
    .filter((t): t is ToolsetInfo => t !== null);
}

export async function remoteSetToolsetEnabled(
  conn: ConnectionConfig,
  key: string,
  enabled: boolean,
  profile?: string,
): Promise<boolean> {
  await remoteDashboardRequestJson(
    conn,
    `/api/tools/toolsets/${encodeURIComponent(key)}`,
    { method: "PUT", body: { enabled } },
    profile,
  );
  return true;
}

// ── logs ────────────────────────────────────────────────────────────────────

export async function remoteReadLogs(
  conn: ConnectionConfig,
  logFile = "agent",
  lines = 300,
  profile?: string,
): Promise<{ content: string; path: string }> {
  const data = await remoteDashboardRequestJson<{
    lines?: unknown;
    file?: string;
  }>(
    conn,
    `/api/logs?file=${encodeURIComponent(logFile)}&lines=${Math.min(lines, 2000)}`,
    {},
    profile,
  );
  const rows = Array.isArray(data?.lines) ? data.lines : [];
  const content = rows
    .map((line) =>
      typeof line === "string" ? line : stringValue(asRecord(line).text),
    )
    .filter(Boolean)
    .join("\n");
  return { content, path: `remote:${stringValue(data?.file) || logFile}` };
}

// ── gateway status / lifecycle ─────────────────────────────────────────────

export async function remoteGatewayStatus(
  conn: ConnectionConfig,
  profile?: string,
): Promise<boolean> {
  const status = await remoteDashboardRequestJson<unknown>(
    conn,
    "/api/status",
    {},
    profile,
  );
  return asRecord(status).gateway_running === true;
}

export async function remoteStartGateway(
  conn: ConnectionConfig,
  profile?: string,
): Promise<void> {
  await remoteDashboardRequestJson(
    conn,
    "/api/gateway/start",
    { method: "POST", body: {} },
    profile,
  );
}

export async function remoteStopGateway(
  conn: ConnectionConfig,
  profile?: string,
): Promise<void> {
  await remoteDashboardRequestJson(
    conn,
    "/api/gateway/stop",
    { method: "POST", body: {} },
    profile,
  );
}

// ── profiles ────────────────────────────────────────────────────────────────

export interface RemoteProfileInfo {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
  isActive: boolean;
  model: string;
  provider: string;
  hasEnv: boolean;
  hasSoul: boolean;
  skillCount: number;
  gatewayRunning: boolean;
}

export async function remoteListProfiles(
  conn: ConnectionConfig,
): Promise<RemoteProfileInfo[]> {
  const data = await remoteDashboardRequestJson<{ profiles?: unknown }>(
    conn,
    "/api/profiles",
    {},
  );
  const rows = Array.isArray(data?.profiles) ? data.profiles : [];
  return rows.map((row): RemoteProfileInfo => {
    const r = asRecord(row);
    const name = stringValue(r.name) || "default";
    return {
      id: name,
      name: stringValue(r.display_name) || name,
      path: stringValue(r.path),
      isDefault: r.is_default === true,
      isActive: r.is_default === true, // overridden by the caller with the LOCAL selection
      model: stringValue(r.model),
      provider: stringValue(r.provider) || "auto",
      hasEnv: r.has_env === true,
      hasSoul: true, // not in the payload; the Soul screen reads it separately
      skillCount: numberValue(r.skill_count),
      gatewayRunning: r.gateway_running === true,
    } as RemoteProfileInfo;
  });
}

// ── config / env ────────────────────────────────────────────────────────────

export async function remoteGetConfigValue(
  conn: ConnectionConfig,
  key: string,
  profile?: string,
): Promise<string | null> {
  // The dashboard config GET deep-normalizes; for a single dotted key the raw
  // YAML + the same indentation-aware reader the local path uses is both
  // simpler and consistent across dashboards.
  const home = await remoteHome(conn, profile);
  const content = await remoteReadTextFile(
    conn,
    remoteConfigFilePath(home, profile),
    profile,
  ).catch(() => "");
  if (!content) return null;
  const { getYamlPath } = await import("./yaml-path");
  return getYamlPath(content, key);
}

export async function remoteSetConfigValue(
  conn: ConnectionConfig,
  key: string,
  value: string,
  profile?: string,
): Promise<void> {
  // Mirrors sshSetConfigValue's surgical YAML splice: read raw, splice the
  // single value, write back. /api/config PUT deep-merges unknown nested keys
  // dangerously for a single-key setter.
  if (/["\\\n\r]/.test(value)) {
    throw new Error(
      'Config value contains illegal characters: ", \\, or newline',
    );
  }
  const home = await remoteHome(conn, profile);
  const path = remoteConfigFilePath(home, profile);
  const content = await remoteReadTextFile(conn, path, profile);
  if (!content) return;
  const { locateInYaml } = await import("./ssh-remote");
  const hit = locateInYaml(content, key);
  let updated: string;
  if (hit) {
    updated =
      content.slice(0, hit.valueStart) +
      `"${value}"` +
      content.slice(hit.valueEnd);
  } else if (!key.includes(".")) {
    const sep = content.endsWith("\n") || content === "" ? "" : "\n";
    updated = `${content}${sep}${key}: "${value}"\n`;
  } else {
    // Missing nested path — don't guess where to materialize a parent block.
    return;
  }
  await remoteWriteTextFile(conn, path, updated, profile);
}

export async function remoteReadEnv(
  conn: ConnectionConfig,
  profile?: string,
): Promise<Record<string, string>> {
  const home = await remoteHome(conn, profile);
  const content = await remoteReadTextFile(
    conn,
    remoteEnvFilePath(home, profile),
    profile,
  ).catch(() => "");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eqIdx = trimmed.indexOf("=");
    const k = trimmed.substring(0, eqIdx).trim();
    let v = trimmed.substring(eqIdx + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1);
    if (v) result[k] = v;
  }
  // Home Assistant alias groups — mirror sshReadEnv so the Providers screen
  // shows the value regardless of which naming convention the server uses.
  const HA_ALIAS_GROUPS: string[][] = [
    ["HASS_URL", "HOMEASSISTANT_URL", "HA_URL"],
    ["HASS_TOKEN", "HOMEASSISTANT_TOKEN", "HA_TOKEN"],
  ];
  for (const group of HA_ALIAS_GROUPS) {
    const present = group.find((k) => result[k]);
    if (present) {
      for (const k of group) {
        if (!result[k] && result[present]) result[k] = result[present];
      }
    }
  }
  return result;
}

export async function remoteSetEnvValue(
  conn: ConnectionConfig,
  key: string,
  value: string,
  profile?: string,
): Promise<void> {
  await remoteDashboardRequestJson(
    conn,
    "/api/env",
    { method: "PUT", body: { key, value } },
    profile,
  );
}

// ── doctor / dump (spawned actions) ────────────────────────────────────────

export async function remoteRunDoctor(conn: ConnectionConfig): Promise<string> {
  const started = await remoteDashboardRequestJson<{ name?: string }>(
    conn,
    "/api/ops/doctor",
    { method: "POST", body: {} },
  );
  const name = stringValue(started?.name) || "doctor";
  // Tail the spawned action until it exits (bounded).
  for (let i = 0; i < 120; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const status = await remoteDashboardRequestJson<{
      running?: boolean;
      exit_code?: number | null;
      lines?: unknown;
    }>(conn, `/api/actions/${encodeURIComponent(name)}/status`, {});
    if (status?.running) continue;
    const rows = Array.isArray(status?.lines) ? status.lines : [];
    return rows
      .map((l) => (typeof l === "string" ? l : stringValue(asRecord(l).text)))
      .join("\n");
  }
  return "Doctor is still running on the remote dashboard; see /api/actions/doctor/status.";
}

export async function remoteRunDump(conn: ConnectionConfig): Promise<string> {
  const started = await remoteDashboardRequestJson<{ name?: string }>(
    conn,
    "/api/ops/dump",
    { method: "POST", body: {} },
  );
  const name = stringValue(started?.name) || "dump";
  for (let i = 0; i < 120; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const status = await remoteDashboardRequestJson<{
      running?: boolean;
      lines?: unknown;
    }>(conn, `/api/actions/${encodeURIComponent(name)}/status`, {});
    if (status?.running) continue;
    const rows = Array.isArray(status?.lines) ? status.lines : [];
    return rows
      .map((l) => (typeof l === "string" ? l : stringValue(asRecord(l).text)))
      .join("\n");
  }
  return "Dump is still running on the remote dashboard.";
}

// ── profile lifecycle ───────────────────────────────────────────────────────

export async function remoteCreateProfile(
  conn: ConnectionConfig,
  name: string,
  cloneFrom: string | null,
): Promise<{ success: boolean; error?: string }> {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) return { success: false, error: "Invalid profile name" };
  try {
    await remoteDashboardRequestJson(conn, "/api/profiles", {
      method: "POST",
      body: cloneFrom ? { name: safe, clone_from: cloneFrom } : { name: safe },
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function remoteSetActiveProfile(
  conn: ConnectionConfig,
  name: string,
): Promise<void> {
  // The desktop keeps its OWN active-profile selection locally (same rule as
  // the SSH branch of set-active-profile); this only ensures the target
  // profile's gateway is up on the server, mirroring the SSH behavior.
  const status = await remoteGatewayStatus(conn, name).catch(() => false);
  if (!status) {
    await remoteStartGateway(conn, name).catch(() => undefined);
  }
}

// ── gateway screen: API server key ─────────────────────────────────────────

export interface RemoteApiServerKeyStatus {
  hasKey: boolean;
  checkedAt: number;
}

export async function remoteGetApiServerKeyStatus(
  conn: ConnectionConfig,
  profile?: string,
): Promise<RemoteApiServerKeyStatus> {
  // The dashboard's .env view is redacted; the raw .env through /api/fs tells
  // us presence without ever shipping the secret to the client.
  const env = await remoteReadEnv(conn, profile).catch(
    () => ({}) as Record<string, string>,
  );
  return {
    hasKey: Boolean(env.API_SERVER_KEY && env.API_SERVER_KEY.trim()),
    checkedAt: Date.now(),
  };
}

export async function remoteGenerateApiServerKey(
  conn: ConnectionConfig,
  profile?: string,
): Promise<string> {
  const { randomUUID } = await import("crypto");
  const key = `desk-${randomUUID()}`;
  await remoteSetEnvValue(conn, "API_SERVER_KEY", key, profile);
  // Match the local behavior: restart so the gateway picks the key up. The
  // restart targets the requested profile's gateway on the server.
  try {
    await remoteDashboardRequestJson(
      conn,
      "/api/gateway/restart",
      { method: "POST", body: {} },
      profile,
    );
  } catch {
    // A restart failure must not lose the write — the key is already saved.
  }
  return key;
}

// ── providers screen: credential pool ──────────────────────────────────────

export interface RemoteCredentialPoolEntry {
  index: number;
  id: string;
  label: string;
  authType: string;
  source: string;
  priority: number;
  lastStatus: string | null;
  requestCount: number;
  tokenPreview: string;
  hasRefresh: boolean;
}

export async function remoteGetCredentialPool(
  conn: ConnectionConfig,
): Promise<Array<{ provider: string; entries: RemoteCredentialPoolEntry[] }>> {
  const data = await remoteDashboardRequestJson<{
    providers?: Array<{ provider?: string; entries?: unknown }>;
  }>(conn, "/api/credentials/pool", {});
  const rows = Array.isArray(data?.providers) ? data.providers : [];
  return rows.flatMap(
    (
      row,
    ): Array<{ provider: string; entries: RemoteCredentialPoolEntry[] }> => {
      const provider = typeof row?.provider === "string" ? row.provider : "";
      if (!provider) return [];
      const entries = (Array.isArray(row.entries) ? row.entries : []).map(
        (entry): RemoteCredentialPoolEntry => {
          const r = asRecord(entry);
          return {
            index: numberValue(r.index),
            id: stringValue(r.id),
            label: stringValue(r.label),
            authType: stringValue(r.auth_type),
            source: stringValue(r.source),
            priority: numberValue(r.priority),
            lastStatus:
              typeof r.last_status === "string" && r.last_status
                ? r.last_status
                : null,
            requestCount: numberValue(r.request_count),
            tokenPreview: stringValue(r.token_preview),
            hasRefresh: r.has_refresh === true,
          };
        },
      );
      return [{ provider, entries }];
    },
  );
}

export async function remoteAddCredentialPoolEntry(
  conn: ConnectionConfig,
  provider: string,
  apiKey: string,
  label: string,
): Promise<RemoteCredentialPoolEntry[]> {
  await remoteDashboardRequestJson(conn, "/api/credentials/pool", {
    method: "POST",
    body: { provider, api_key: apiKey, label },
  });
  // Return the refreshed pool rows for the provider so the UI updates.
  const rows = await remoteGetCredentialPool(conn);
  return rows.find((r) => r.provider === provider)?.entries ?? [];
}

export async function remoteRemoveCredentialPoolEntry(
  conn: ConnectionConfig,
  provider: string,
  index: number,
): Promise<void> {
  await remoteDashboardRequestJson(
    conn,
    `/api/credentials/pool/${encodeURIComponent(provider)}/${index}`,
    { method: "DELETE" },
  );
}

// ── providers screen: custom endpoints ─────────────────────────────────────

/** Mirrors CustomProviderRecord (shared/custom-providers): the Providers
 * screen renders `name` and `baseUrl`, `createdAt` only sorts. The dashboard
 * endpoint response shape is normalized defensively. */
export interface RemoteCustomProviderRecord {
  id: string;
  name: string;
  baseUrl: string;
  createdAt: number;
}

export async function remoteListCustomProviders(
  conn: ConnectionConfig,
  profile?: string,
): Promise<RemoteCustomProviderRecord[]> {
  const data = await remoteDashboardRequestJson<Record<string, unknown>>(
    conn,
    "/api/providers/custom-endpoints",
    {},
    profile,
  );
  const rowsRaw = Array.isArray(data?.endpoints)
    ? (data.endpoints as unknown[])
    : Array.isArray(data?.providers)
      ? (data.providers as unknown[])
      : Array.isArray(data)
        ? (data as unknown[])
        : [];
  return rowsRaw
    .map((row): RemoteCustomProviderRecord | null => {
      const r = asRecord(row);
      const id = stringValue(r.id ?? r.endpoint_id);
      const baseUrl = stringValue(r.base_url ?? r.url);
      if (!id && !baseUrl) return null;
      return {
        id: id || baseUrl,
        name: stringValue(r.name ?? r.label) || stringValue(r.model) || baseUrl,
        baseUrl,
        createdAt: numberValue(r.created_at, Date.now()),
      };
    })
    .filter((r): r is RemoteCustomProviderRecord => r !== null);
}

// ── memory providers ───────────────────────────────────────────────────────

export async function remoteDiscoverMemoryProviders(
  conn: ConnectionConfig,
  profile?: string,
): Promise<MemoryProviderInfo[]> {
  const data = await remoteDashboardRequestJson<{
    providers?: { statuses?: unknown; active?: string };
  }>(conn, "/api/memory", {}, profile);
  const raw = asRecord(data);
  const statusesRow = asRecord(raw.providers);
  const rows: unknown[] = Array.isArray(statusesRow.statuses)
    ? statusesRow.statuses
    : Array.isArray(raw.providers)
      ? (raw.providers as unknown[])
      : [];
  const active = stringValue(raw.active);
  return rows
    .map((row) => {
      const r = asRecord(row);
      const name =
        stringValue(r.name) || stringValue(r.provider) || stringValue(r.id);
      if (!name) return null;
      return {
        name,
        description: stringValue(r.description),
        installed: r.available === true || r.installed === true,
        active: name === active || r.active === true,
        envVars: Array.isArray(r.env_vars)
          ? r.env_vars.map(stringValue).filter(Boolean)
          : [],
      } satisfies MemoryProviderInfo;
    })
    .filter((p): p is MemoryProviderInfo => p !== null);
}

export { remoteRequestJson };
