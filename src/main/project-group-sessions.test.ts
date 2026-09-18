import { describe, expect, it } from "vitest";
import type { CachedSession } from "./session-cache";
import { regroupTreeSessionsByBindings } from "./project-group-sessions";

function row(
  id: string,
  contextFolder: string | null,
  startedAt = 1000,
): CachedSession {
  return {
    id,
    title: `Session ${id}`,
    startedAt,
    source: "chat",
    messageCount: 0,
    model: "",
    contextFolder,
  };
}

describe("regroupTreeSessionsByBindings (issue #66)", () => {
  it("moves a bound row out of its tree folder into the bound folder", () => {
    const groups = new Map<string, CachedSession[]>([
      ["/old", [row("s1", "/old"), row("s2", "/old")]],
      ["/new", [row("s3", "/new")]],
    ]);
    const bindings = new Map([["s1", "/new"]]);

    const out = regroupTreeSessionsByBindings(groups, bindings);

    // The moved chat appears ONLY in the destination folder.
    expect(out["/old"].map((s) => s.id)).toEqual(["s2"]);
    expect(out["/new"].map((s) => s.id)).toContain("s1");
    expect(out["/new"].map((s) => s.id)).toContain("s3");
    expect(
      Object.values(out)
        .flat()
        .filter((s) => s.id === "s1"),
    ).toHaveLength(1);
  });

  it("drops rows with a sentinel (deliberate unlink) binding from every group", () => {
    const groups = new Map<string, CachedSession[]>([
      ["/old", [row("s1", "/old")]],
    ]);
    const bindings = new Map([["s1", ""]]);

    const out = regroupTreeSessionsByBindings(groups, bindings);

    expect(out["/old"]).toBeUndefined();
  });

  it("keeps rows without a binding in their tree folder", () => {
    const groups = new Map<string, CachedSession[]>([
      ["/proj", [row("s1", "/proj"), row("s2", "/proj")]],
    ]);
    const bindings = new Map([["s2", "/other"]]);

    const out = regroupTreeSessionsByBindings(groups, bindings);

    expect(out["/proj"].map((s) => s.id)).toEqual(["s1"]);
    expect(out["/other"].map((s) => s.id)).toEqual(["s2"]);
  });

  it("dedupes by id so a session never appears in two groups", () => {
    // A pathological tree claiming the same session under two folders.
    const groups = new Map<string, CachedSession[]>([
      ["/a", [row("s1", "/a")]],
      ["/b", [row("s1", "/b", 2000)]],
    ]);

    const out = regroupTreeSessionsByBindings(groups, new Map());

    const appearances = Object.values(out)
      .flat()
      .filter((s) => s.id === "s1");
    expect(appearances).toHaveLength(1);
  });

  it("sorts each list by startedAt descending", () => {
    const groups = new Map<string, CachedSession[]>([
      [
        "/proj",
        [
          row("old", "/proj", 100),
          row("new", "/proj", 900),
          row("mid", "/proj", 500),
        ],
      ],
    ]);

    const out = regroupTreeSessionsByBindings(groups, new Map());

    expect(out["/proj"].map((s) => s.id)).toEqual(["new", "mid", "old"]);
  });
});
