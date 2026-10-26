import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("collapses diff separators while preserving whitespace within each diff line", () => {
  const css = readFileSync("src/renderer/src/assets/main.css", "utf8");
  expect(css.match(/\.chat-diff-content\s*\{([^}]*)\}/)?.[1]).toMatch(
    /white-space:\s*normal/,
  );
  expect(css.match(/\.chat-diff-line\s*\{([^}]*)\}/)?.[1]).toMatch(
    /white-space:\s*pre/,
  );
});
