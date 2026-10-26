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
  it("keeps the arrow target while reducing the space before utility content", () => {
    expect(rule(".utility-chat-navigation")).toContain("height: 38px");
    expect(rule(".utility-chat-navigation")).toContain("padding: 6px 24px 0");
    expect(rule(".utility-back-to-chat")).toContain("height: 32px");
    expect(css).toMatch(
      /\.utility-chat-navigation\s*~\s*div\s*>\s*:is\([\s\S]*?\)\s*\{\s*padding-top: 8px;/,
    );
    expect(
      rule(".utility-chat-navigation ~ div > .tools-screen > .tools-tabs"),
    ).toContain("padding-top: 8px");
  });
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
