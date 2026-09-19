// Remote-mode file access for the Worktree panel's file viewer.
//
// The dashboard serves three primitives (hermes_cli/web_routers/files.py):
//   GET /api/fs/read-text?path=     → {text, truncated, byteSize, binary, ...}
//   GET /api/fs/read-data-url?path= → {dataUrl}   (image preview, size-capped)
//   GET /api/fs/list?path=          → {entries: [{name, path, isDirectory}]}
//
// All calls go through remoteDashboardRequestJson: it resolves the auth mode
// (token vs OAuth cookie) per connection. Hand-rolled fetches with
// getRemoteAuthHeader() 401 against the gated production dashboard — see the
// remote-mode parity notes. Errors degrade to null/empty exactly like the
// local branches of the same IPC handlers, so the renderer sees one shape.
import { remoteDashboardRequestJson } from "./remote-api";
import type { ConnectionConfig } from "./config";

interface FsReadTextResponse {
  text?: string;
  truncated?: boolean;
  byteSize?: number;
  binary?: boolean;
}

interface FsReadDataUrlResponse {
  dataUrl?: string;
}

interface FsListResponse {
  entries?: { name: string; path: string; isDirectory: boolean }[];
}

/** Read a server file as text for the file viewer (remote branch of read-file). */
export async function remoteReadTextFile(
  conn: ConnectionConfig,
  filePath: string,
): Promise<{ content: string; truncated: boolean; binary: boolean } | null> {
  try {
    const data = await remoteDashboardRequestJson<FsReadTextResponse>(
      conn,
      `/api/fs/read-text?path=${encodeURIComponent(filePath)}`,
    );
    if (typeof data?.text !== "string") return null;
    return {
      content: data.text,
      truncated: data.truncated === true,
      binary: data.binary === true,
    };
  } catch {
    return null;
  }
}

/** Read a server image as a data URL (remote branch of read-image-file). */
export async function remoteReadImageFile(
  conn: ConnectionConfig,
  filePath: string,
): Promise<string | null> {
  try {
    const data = await remoteDashboardRequestJson<FsReadDataUrlResponse>(
      conn,
      `/api/fs/read-data-url?path=${encodeURIComponent(filePath)}`,
    );
    return typeof data?.dataUrl === "string" ? data.dataUrl : null;
  } catch {
    return null;
  }
}

/** List a server directory (remote branch of read-directory). */
export async function remoteReadDirectory(
  conn: ConnectionConfig,
  dirPath: string,
): Promise<{ name: string; isDirectory: boolean }[] | null> {
  try {
    const data = await remoteDashboardRequestJson<FsListResponse>(
      conn,
      `/api/fs/list?path=${encodeURIComponent(dirPath)}`,
    );
    if (!Array.isArray(data?.entries)) return null;
    return data.entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
    }));
  } catch {
    return null;
  }
}
