/**
 * Project management types shared by the main process, preload, and the
 * renderer (issue #27). The agent core owns the data (projects.db via the
 * `projects.*` JSON-RPC); these are the desktop-side shapes.
 */

export interface ProjectFolderInfo {
  path: string;
  label?: string | null;
  isPrimary: boolean;
}

export interface ProjectInfo {
  id: string;
  slug: string;
  name: string;
  primaryPath: string | null;
  folders: ProjectFolderInfo[];
}

export type ProjectMutation =
  | {
      op: "create";
      name: string;
      folders: string[];
      primaryPath?: string;
    }
  | { op: "update"; id: string; name?: string }
  | { op: "delete"; id: string }
  | { op: "add_folder"; id: string; path: string; isPrimary?: boolean }
  | { op: "remove_folder"; id: string; path: string }
  | { op: "set_primary"; id: string; path: string };
