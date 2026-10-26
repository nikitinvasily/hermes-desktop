import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  join(import.meta.dirname, "../src/renderer/src/assets/main.css"),
  "utf8",
);
function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  return css.slice(start, css.indexOf("}", start) + 1);
}

describe("utility return navigation layering", () => {
  it("does not lift navigation above modal task details", () => {
    const navigation = rule(".utility-chat-navigation");
    const overlay = rule(".kanban-drawer-overlay");
    const zIndex = (text: string): number =>
      Number(text.match(/z-index:\s*(\d+)/)?.[1] ?? 0);
    expect(zIndex(navigation)).toBeLessThan(zIndex(overlay));
    const shield = rule(
      ".content.remote-degraded:has(> .utility-chat-navigation)::after",
    );
    expect(shield.match(/top:\s*(\d+px)/)?.[1]).toBe(
      navigation.match(/height:\s*(\d+px)/)?.[1],
    );
  });
});
