/**
 * Remote (direct HTTP) branches for the Discover marketplace's server-side
 * state: what is installed on the SERVER, and "Set up" actions that install
 * onto the SERVER through the dashboard REST API (issue #88).
 *
 * The catalog itself (fetchRegistry / fetchRegistryDetail) reads public
 * GitHub and stays machine-independent — no remote variant needed. What is
 * per-machine: the installed marker lists and every install action, which
 * otherwise silently read/wrote the LOCAL ~/.hermes (the issue #51
 * local-fallthrough class).
 */

import { remoteDashboardRequestJson } from "./remote-api";
import { remoteHome, remoteInvalidateSettingsCaches } from "./remote-settings";
import type { ConnectionConfig } from "./config";
import {
  fetchManifest,
  listFolderFiles,
  renderMcpYaml,
  REGISTRY_RAW_BASE,
  type EntryManifest,
} from "./registry";
import type {
  RegistryItem,
  InstalledRegistry,
  RegistryKind,
} from "../shared/registry";

export interface RemoteInstallResult {
  success: boolean;
  error?: string;
}

// ── installed marker lists (server state) ──────────────────────────────────

interface RemoteSkillRow {
  name?: string;
}

interface RemoteMcpRow {
  name?: string;
}

/** Server-side "installed" lists for the Discover tabs' Installed badges. */
export async function remoteListInstalledRegistry(
  conn: ConnectionConfig,
  profile?: string,
): Promise<InstalledRegistry> {
  const skills: string[] = [];
  const mcps: string[] = [];
  const workflows: string[] = [];

  try {
    const rows = await remoteDashboardRequestJson<RemoteSkillRow[]>(
      conn,
      "/api/skills",
      {},
      profile,
    );
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (typeof row?.name === "string" && row.name) skills.push(row.name);
      }
    }
  } catch {
    /* unreachable remote: leave empty, the UI shows no markers */
  }

  try {
    const body = await remoteDashboardRequestJson<
      RemoteMcpRow[] | { servers?: RemoteMcpRow[] }
    >(conn, "/api/mcp/servers", {}, profile);
    const rows = Array.isArray(body) ? body : (body?.servers ?? []);
    for (const row of rows) {
      if (typeof row?.name === "string" && row.name) mcps.push(row.name);
    }
  } catch {
    /* ignore */
  }

  try {
    const home = await remoteHome(conn, profile);
    const body = await remoteDashboardRequestJson<{
      entries?: { name?: string; isDirectory?: boolean }[];
    }>(
      conn,
      `/api/fs/list?path=${encodeURIComponent(joinPosix(home, "workflows"))}`,
      {},
      profile,
    );
    for (const entry of body?.entries ?? []) {
      if (!entry?.name) continue;
      // Workflows install as either <id>.<ext> files or <id>/ folders.
      workflows.push(entry.name.replace(/\.(js|mjs|ts|json)$/, ""));
    }
  } catch {
    /* workflows dir may not exist yet on a fresh server */
  }

  return { skills, mcps, workflows };
}

// ── remote filesystem plumbing ─────────────────────────────────────────────

function joinPosix(...parts: string[]): string {
  return parts
    .filter((p) => p !== "" && p !== undefined && p !== null)
    .join("/")
    .replace(/\/{2,}/g, "/");
}

async function remoteMkdir(
  conn: ConnectionConfig,
  path: string,
  profile?: string,
): Promise<void> {
  await remoteDashboardRequestJson(
    conn,
    "/api/files/mkdir",
    { method: "POST", body: { path } },
    profile,
  );
}

async function remoteWriteText(
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

/**
 * Download the entry's folder from the registry repo (on THIS machine) and
 * upload every file to the server, creating directories along the way.
 */
async function uploadRegistryFolder(
  conn: ConnectionConfig,
  repoFolder: string,
  destDir: string,
  profile?: string,
): Promise<RemoteInstallResult> {
  const files = await listFolderFiles(repoFolder);
  if (files.length === 0) {
    return { success: false, error: "No files found for this entry" };
  }
  // Collect every directory we touch so mkdir calls can be deduplicated.
  const dirs = new Set<string>();
  for (const file of files) {
    const rel = file.slice(repoFolder.length + 1);
    const parts = rel.split("/");
    parts.pop();
    let acc = destDir;
    dirs.add(acc);
    for (const part of parts) {
      acc = joinPosix(acc, part);
      dirs.add(acc);
    }
  }
  for (const dir of dirs) {
    try {
      await remoteMkdir(conn, dir, profile);
    } catch {
      // "already exists" is fine; a genuinely failed mkdir surfaces on the
      // subsequent write with the server's own error text.
    }
  }
  for (const file of files) {
    const rel = file.slice(repoFolder.length + 1);
    const res = await fetch(`${REGISTRY_RAW_BASE}/${file}`);
    if (!res.ok) return { success: false, error: `Fetch failed: ${rel}` };
    const body = await res.text();
    try {
      await remoteWriteText(conn, joinPosix(destDir, rel), body, profile);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : `Upload failed: ${rel}`,
      };
    }
  }
  return { success: true };
}

// ── per-kind installers ────────────────────────────────────────────────────

/** Append an MCP server block to the SERVER's config.yaml (same splice as local). */
async function remoteInstallMcp(
  conn: ConnectionConfig,
  item: RegistryItem,
  profile?: string,
): Promise<RemoteInstallResult> {
  if (!item.path) return { success: false, error: "MCP entry has no path" };
  const m = await fetchManifest(item.path);
  if (!m || (!m.url && !m.command)) {
    return { success: false, error: "MCP manifest has no connection config" };
  }
  const home = await remoteHome(conn, profile);
  const configPath = joinPosix(home, "config.yaml");
  let content = "";
  try {
    content = await readRemoteText(conn, configPath, profile);
  } catch {
    content = ""; // no config yet — the block below creates the section
  }
  const block = renderMcpYaml(item.id, m);
  const sectionRe = /^mcp_servers:\s*\n/m;
  if (sectionRe.test(content)) {
    if (new RegExp(`^[ ]{2}${item.id}:\\s*$`, "m").test(content)) {
      return { success: false, error: "Already configured" };
    }
    content = content.replace(sectionRe, (mm) => mm + block);
  } else {
    if (content.length && !content.endsWith("\n")) content += "\n";
    content += `mcp_servers:\n${block}`;
  }
  try {
    await remoteWriteText(conn, configPath, content, profile);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to write config",
    };
  }
}

async function readRemoteText(
  conn: ConnectionConfig,
  path: string,
  profile?: string,
): Promise<string> {
  const data = await remoteDashboardRequestJson<{ text?: string }>(
    conn,
    `/api/fs/read-text?path=${encodeURIComponent(path)}`,
    {},
    profile,
  );
  return typeof data?.text === "string" ? data.text : "";
}

/** Install a registry-folder skill onto the server. */
async function remoteInstallSkill(
  conn: ConnectionConfig,
  item: RegistryItem,
  profile?: string,
): Promise<RemoteInstallResult> {
  if (!item.path) return { success: false, error: "Skill entry has no path" };
  const home = await remoteHome(conn, profile);
  const category = item.category || "uncategorized";
  return uploadRegistryFolder(
    conn,
    item.path,
    joinPosix(home, "skills", category, item.id),
    profile,
  );
}

/** Install a workflow onto the server. */
async function remoteInstallWorkflow(
  conn: ConnectionConfig,
  item: RegistryItem,
  profile?: string,
): Promise<RemoteInstallResult> {
  if (!item.path)
    return { success: false, error: "Workflow entry has no path" };
  const home = await remoteHome(conn, profile);
  return uploadRegistryFolder(
    conn,
    item.path,
    joinPosix(home, "workflows", item.id),
    profile,
  );
}

/**
 * Install a registry agent as a new SERVER profile: clone via the profiles
 * API, then write the published persona as the new profile's SOUL.md.
 */
async function remoteInstallAgent(
  conn: ConnectionConfig,
  item: RegistryItem,
): Promise<RemoteInstallResult> {
  try {
    await remoteDashboardRequestJson(
      conn,
      "/api/profiles",
      {
        method: "POST",
        body: {
          name: item.id,
          clone_from: "default",
          clone_all: false,
        },
      },
      undefined,
    );
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to create profile",
    };
  }
  remoteInvalidateSettingsCaches();
  if (item.path) {
    const m = await fetchManifest(item.path);
    const entry = m?.entry || "AGENT.md";
    const res = await fetch(`${REGISTRY_RAW_BASE}/${item.path}/${entry}`);
    if (res.ok) {
      const md = await res.text();
      if (md.trim()) {
        try {
          const home = await remoteHome(conn, item.id);
          await remoteWriteText(conn, joinPosix(home, "SOUL.md"), md, item.id);
        } catch (err) {
          return {
            success: false,
            error:
              err instanceof Error
                ? err.message
                : "Failed to write agent persona (SOUL.md)",
          };
        }
      }
    }
  }
  return { success: true };
}

/** Remote "Set up" dispatcher: installs a marketplace item onto the SERVER. */
export async function remoteInstallRegistryItem(
  conn: ConnectionConfig,
  kind: RegistryKind,
  item: RegistryItem,
  profile?: string,
): Promise<RemoteInstallResult> {
  try {
    switch (kind) {
      case "skills":
        // Bundled skills (source, no path) install through the hub CLI API;
        // registry-folder skills are uploaded file-by-file.
        if (item.path) return await remoteInstallSkill(conn, item, profile);
        return remoteInstallBundledSkill(conn, item, profile);
      case "mcps":
        return await remoteInstallMcp(conn, item, profile);
      case "agents":
        return await remoteInstallAgent(conn, item);
      case "workflows":
        return await remoteInstallWorkflow(conn, item, profile);
      default:
        return { success: false, error: "Unknown item kind" };
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Install failed",
    };
  }
}

/** Bundled skill (item.source) → the server's skills-hub install endpoint. */
async function remoteInstallBundledSkill(
  conn: ConnectionConfig,
  item: RegistryItem,
  profile?: string,
): Promise<RemoteInstallResult> {
  const identifier = item.source || item.id;
  try {
    // The hub install spawns a CLI action server-side; poll until done is
    // handled by the endpoint's action semantics — the REST call returns
    // after the action is queued. The UI's post-install refresh re-lists
    // skills, so completion is observed there.
    await remoteDashboardRequestJson(
      conn,
      "/api/skills/hub/install",
      { method: "POST", body: { identifier, profile } },
      profile,
    );
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Hub install failed",
    };
  }
}

export type { EntryManifest };
