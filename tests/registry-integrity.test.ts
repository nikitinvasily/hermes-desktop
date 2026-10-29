// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  gitObjectHash,
  VerifiedRegistrySnapshot,
  verifyRegistryTree,
} from "../src/main/registry-integrity";

function fixture(a = Buffer.from("verified persona\n")): {
  a: Buffer;
  b: Buffer;
  root: string;
  tree: {
    truncated: boolean;
    tree: { path: string; type: string; mode: string; sha: string }[];
  };
} {
  const b = Buffer.from('{"command":"safe-fixture"}\n');
  const entries = [
    {
      path: "entry/a.md",
      type: "blob",
      mode: "100644",
      sha: gitObjectHash("blob", a),
    },
    {
      path: "entry/b.json",
      type: "blob",
      mode: "100644",
      sha: gitObjectHash("blob", b),
    },
  ];
  const folder = gitObjectHash(
    "tree",
    Buffer.concat(
      entries.map((e) =>
        Buffer.concat([
          Buffer.from(`100644 ${e.path.slice(6)}\0`),
          Buffer.from(e.sha, "hex"),
        ]),
      ),
    ),
  );
  const root = gitObjectHash(
    "tree",
    Buffer.concat([Buffer.from("40000 entry\0"), Buffer.from(folder, "hex")]),
  );
  return {
    a,
    b,
    root,
    tree: {
      truncated: false,
      tree: [
        { path: "entry", type: "tree", mode: "040000", sha: folder },
        ...entries,
      ],
    },
  };
}

describe("reviewed registry snapshot", () => {
  it("rejects verified non-UTF-8 text without changing binary folder reads", async () => {
    const f = fixture(Buffer.from([0x61, 0xff, 0x62]));
    const request = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).includes("api.github.com"))
        return Response.json(f.tree);
      return new Response(
        new Uint8Array(String(input).endsWith("a.md") ? f.a : f.b),
      );
    });
    const client = new VerifiedRegistrySnapshot(
      "a".repeat(40),
      f.root,
      request,
    );
    await expect(client.readText("entry/a.md")).rejects.toThrow("non-UTF-8");
    await expect(client.readOptionalText("entry/a.md")).rejects.toThrow(
      "non-UTF-8",
    );
    expect((await client.readFolder("entry"))[0].bytes).toEqual(f.a);
  });

  it("binds names, modes and blob hashes to the reviewed root", () => {
    const f = fixture();
    expect(verifyRegistryTree(f.tree, f.root).size).toBe(3);
    for (const change of [
      { ...f.tree, truncated: true },
      { ...f.tree, tree: f.tree.tree.slice(0, 2) },
      {
        ...f.tree,
        tree: f.tree.tree.map((e) => ({
          ...e,
          path: e.path.replace("a.md", "other.md"),
        })),
      },
      {
        ...f.tree,
        tree: [...f.tree.tree, { ...f.tree.tree[1], path: "entry/../escape" }],
      },
      {
        ...f.tree,
        tree: f.tree.tree.map((e) =>
          e.path === "entry/a.md" ? { ...e, mode: "120000" } : e,
        ),
      },
    ])
      expect(() => verifyRegistryTree(change, f.root)).toThrow();
  });

  it("fetches immutable bytes and refuses a corrupt final file before returning any folder", async () => {
    const f = fixture();
    let corrupt = false;
    const request = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("api.github.com")) return Response.json(f.tree);
      return new Response(
        new Uint8Array(
          url.endsWith("a.md") ? f.a : corrupt ? Buffer.from("tampered") : f.b,
        ),
      );
    });
    const client = new VerifiedRegistrySnapshot(
      "a".repeat(40),
      f.root,
      request,
    );
    expect(
      (await client.readFolder("entry")).map((x) => x.bytes.toString()),
    ).toEqual([f.a.toString(), f.b.toString()]);
    corrupt = true;
    await expect(client.readFolder("entry")).rejects.toThrow(
      "checksum mismatch",
    );
    expect(
      request.mock.calls.every(([url]) => String(url).includes("a".repeat(40))),
    ).toBe(true);
    expect(await client.readOptionalText("entry/missing.md")).toBeNull();
    await expect(client.readText("entry/../escape")).rejects.toThrow("Unsafe");
  });
  it("retains its verified immutable tree after an hour and API failure", async () => {
    const f = fixture();
    let unavailable = false;
    const request = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("api.github.com"))
        return unavailable
          ? new Response("rate limited", { status: 429 })
          : Response.json(f.tree);
      return new Response(new Uint8Array(url.endsWith("a.md") ? f.a : f.b));
    });
    const client = new VerifiedRegistrySnapshot(
      "a".repeat(40),
      f.root,
      request,
    );
    expect(await client.readText("entry/a.md")).toBe(f.a.toString());
    unavailable = true;
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 2 * 60 * 60 * 1000);
    try {
      expect(await client.readText("entry/a.md")).toBe(f.a.toString());
      expect(
        request.mock.calls.filter(([url]) =>
          String(url).includes("api.github.com"),
        ),
      ).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });
});

it("validates unknown entry hashes without coercing non-string values", () => {
  const f = fixture();
  f.tree.tree[1] = {
    ...f.tree.tree[1],
    sha: [f.tree.tree[1].sha] as unknown as string,
  };
  expect(() => verifyRegistryTree(f.tree, f.root)).toThrow(
    "unsupported or unsafe",
  );
});

it("rejects invalid snapshot identifiers before making any request", () => {
  const request = vi.fn();
  expect(
    () => new VerifiedRegistrySnapshot("main", "a".repeat(40), request),
  ).toThrow("Invalid registry snapshot");
  expect(
    () => new VerifiedRegistrySnapshot("a".repeat(40), "not-a-tree", request),
  ).toThrow("Invalid registry snapshot");
  expect(request).not.toHaveBeenCalled();
});

it.each([
  null,
  true,
  "tree",
  {},
  { truncated: false, tree: [null] },
  { truncated: false, tree: [{ path: 42 }] },
])("fails closed on malformed tree data %j", (value) => {
  expect(() => verifyRegistryTree(value, "a".repeat(40))).toThrow();
});

it("agrees with Git's tree serialization for folders, executable files and byte ordering", () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-git-tree-"));
  try {
    execFileSync("git", ["init", "--bare", "--quiet", dir]);
    const blob = execFileSync("git", ["hash-object", "--stdin"], {
      input: Buffer.from([0, 255, 128]),
    })
      .toString()
      .trim();
    expect(gitObjectHash("blob", Buffer.from([0, 255, 128]))).toBe(blob);
    const emptyTree = execFileSync("git", ["--git-dir", dir, "mktree"], {
      input: "",
    })
      .toString()
      .trim();
    const root = execFileSync(
      "git",
      ["--git-dir", dir, "mktree", "--missing"],
      {
        input: `100755 blob ${blob}\ta.c\n040000 tree ${emptyTree}\ta\n100644 blob ${blob}\tz\n`,
      },
    )
      .toString()
      .trim();
    expect(
      verifyRegistryTree(
        {
          truncated: false,
          tree: [
            { path: "z", mode: "100644", type: "blob", sha: blob },
            { path: "a", mode: "040000", type: "tree", sha: emptyTree },
            { path: "a.c", mode: "100755", type: "blob", sha: blob },
          ],
        },
        root,
      ).size,
    ).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("coalesces concurrent tree reads and retries after unverified metadata fails", async () => {
  const f = fixture();
  let unavailable = true;
  const request = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes("api.github.com"))
      return unavailable
        ? new Response("Unavailable", { status: 503 })
        : Response.json(f.tree);
    return new Response(new Uint8Array(f.a));
  });
  const client = new VerifiedRegistrySnapshot("a".repeat(40), f.root, request);
  await expect(client.readText("entry/a.md")).rejects.toThrow("503");
  unavailable = false;
  expect(
    await Promise.all([
      client.readText("entry/a.md"),
      client.readText("entry/a.md"),
    ]),
  ).toEqual([f.a.toString(), f.a.toString()]);
  expect(
    request.mock.calls.filter(([url]) =>
      String(url).includes("api.github.com"),
    ),
  ).toHaveLength(2);
});
