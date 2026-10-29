import { createHash } from "crypto";
import { posix } from "path";

export const REGISTRY_COMMIT = "9eac45a2beba230414b9bcf2041b5ff407d3c935";
export const REGISTRY_TREE = "a6cd718e31c378760832f9a5980d045fef96cdd4";
const REPO = "fathah/hermes-registry";
interface Entry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

export function gitObjectHash(type: "tree" | "blob", bytes: Buffer): string {
  return createHash("sha1")
    .update(`${type} ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

/** Rebuild every tree; the pinned root binds both paths and blob identities. */
export function verifyRegistryTree(
  value: unknown,
  expectedRoot: string,
): Map<string, Entry> {
  const json = value as { truncated?: unknown; tree?: unknown } | null;
  if (
    !json ||
    typeof json !== "object" ||
    json.truncated !== false ||
    !Array.isArray(json.tree)
  )
    throw new Error("Registry tree is incomplete");
  const entries = new Map<string, Entry>();
  const folders = new Map<string, Entry[]>();
  for (const candidate of json.tree as unknown[]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new Error("Registry tree contains unsupported or unsafe entries");
    const entry = candidate as Record<string, unknown>;
    if (
      typeof entry.path !== "string" ||
      !safePath(entry.path) ||
      entries.has(entry.path) ||
      typeof entry.sha !== "string" ||
      !/^[a-f0-9]{40}$/.test(entry.sha) ||
      !(
        (entry.type === "tree" && entry.mode === "040000") ||
        (entry.type === "blob" &&
          (entry.mode === "100644" || entry.mode === "100755"))
      )
    ) {
      throw new Error("Registry tree contains unsupported or unsafe entries");
    }
    const verified: Entry = {
      path: entry.path,
      sha: entry.sha,
      type: entry.type as string,
      mode: entry.mode as string,
    };
    entries.set(verified.path, verified);
    const parent =
      posix.dirname(verified.path) === "." ? "" : posix.dirname(verified.path);
    folders.set(parent, [...(folders.get(parent) || []), verified]);
  }
  for (const entry of entries.values()) {
    const parent = posix.dirname(entry.path);
    if (parent !== "." && entries.get(parent)?.type !== "tree")
      throw new Error("Registry tree has a missing parent");
    if (entry.type === "tree" && !folders.has(entry.path))
      folders.set(entry.path, []);
  }
  if (!folders.has("")) folders.set("", []);
  for (const [folder, children] of folders) {
    const ordered = children
      .slice()
      .sort((a, b) =>
        Buffer.compare(
          Buffer.from(posix.basename(a.path) + (a.type === "tree" ? "/" : "")),
          Buffer.from(posix.basename(b.path) + (b.type === "tree" ? "/" : "")),
        ),
      );
    const bytes = Buffer.concat(
      ordered.map((entry) =>
        Buffer.concat([
          Buffer.from(
            `${entry.mode.replace(/^0+/, "")} ${posix.basename(entry.path)}\0`,
          ),
          Buffer.from(entry.sha, "hex"),
        ]),
      ),
    );
    if (
      gitObjectHash("tree", bytes) !==
      (folder ? entries.get(folder)?.sha : expectedRoot)
    )
      throw new Error("Registry tree checksum mismatch");
  }
  return entries;
}

export class VerifiedRegistrySnapshot {
  private cached: { at: number; entries: Map<string, Entry> } | null = null;
  private pending: Promise<Map<string, Entry>> | null = null;

  constructor(
    private commit = REGISTRY_COMMIT,
    private root = REGISTRY_TREE,
    private request: typeof fetch = fetch,
  ) {
    if (
      typeof commit !== "string" ||
      !/^[a-f0-9]{40}$/.test(commit) ||
      typeof root !== "string" ||
      !/^[a-f0-9]{40}$/.test(root)
    )
      throw new Error("Invalid registry snapshot identifiers");
  }

  private async tree(): Promise<Map<string, Entry>> {
    if (this.cached) return this.cached.entries;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await this.request(
        `https://api.github.com/repos/${REPO}/git/trees/${this.commit}?recursive=1`,
        { headers },
      );
      if (!response.ok)
        throw new Error(`Registry tree fetch failed (${response.status})`);
      const entries = verifyRegistryTree(await response.json(), this.root);
      this.cached = { at: Date.now(), entries };
      return entries;
    })();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async readBlob(path: string, entry: Entry): Promise<Buffer> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const response = await this.request(
      `https://raw.githubusercontent.com/${REPO}/${this.commit}/${encoded}`,
    );
    if (!response.ok)
      throw new Error(
        `Registry file fetch failed (${response.status}): ${path}`,
      );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (gitObjectHash("blob", bytes) !== entry.sha)
      throw new Error(`Registry file checksum mismatch: ${path}`);
    return bytes;
  }

  async readOptionalText(path: string): Promise<string | null> {
    if (!safePath(path)) throw new Error("Unsafe registry path");
    const entry = (await this.tree()).get(path);
    if (!entry) return null;
    if (entry.type !== "blob") throw new Error("Registry path is not a file");
    const bytes = await this.readBlob(path, entry);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes))
      throw new Error(`Registry text contains non-UTF-8 bytes: ${path}`);
    return text;
  }

  async readText(path: string): Promise<string> {
    const text = await this.readOptionalText(path);
    if (text === null)
      throw new Error(`Registry file absent from reviewed snapshot: ${path}`);
    return text;
  }

  async readFolder(
    folder: string,
  ): Promise<{ relativePath: string; bytes: Buffer }[]> {
    if (!safePath(folder)) throw new Error("Unsafe registry folder");
    const entries = await this.tree();
    const prefix = `${folder}/`;
    const files = [...entries.values()].filter(
      (entry) => entry.type === "blob" && entry.path.startsWith(prefix),
    );
    const verified: { relativePath: string; bytes: Buffer }[] = [];
    for (const entry of files)
      verified.push({
        relativePath: entry.path.slice(prefix.length),
        bytes: await this.readBlob(entry.path, entry),
      });
    return verified;
  }
}

export const registrySnapshot = new VerifiedRegistrySnapshot();
