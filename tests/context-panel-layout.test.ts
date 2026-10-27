import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  join(import.meta.dirname, "../src/renderer/src/assets/main.css"),
  "utf-8",
);
function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("floating context panel header layout", () => {
  it("shares the first header's vertical anchor and control height", () => {
    const panel = rule(".chat-context-panel");
    const header = rule(".chat-context-panel .chat-context-panel-toggle");
    const button = rule(".chat-context-panel-collapse");
    expect(panel).toContain("padding: var(--context-panel-top-padding)");
    expect(header).toContain("margin: var(--context-panel-header-gap)");
    expect(header).toContain("min-height: var(--context-panel-header-height)");
    expect(header).toContain("padding-top: 0");
    expect(header).toContain("padding-bottom: 0");
    expect(button).toContain(
      "top: calc(var(--context-panel-top-padding) + var(--context-panel-header-gap))",
    );
    expect(button).toContain("height: var(--context-panel-header-height)");
    expect(button).toContain("align-items: center");
  });

  it("centers collapsed section headers inside the panel with symmetric outer spacing", () => {
    const panel = rule(".chat-context-panel");
    const header = rule(".chat-context-panel .chat-context-panel-toggle");
    expect(panel).toContain("padding: var(--context-panel-top-padding) 2px;");
    expect(header).toContain("margin: var(--context-panel-header-gap) 0;");
  });

  it("keeps the whole-panel collapsed control square", () => {
    const panel = rule(".chat-context-panel--collapsed");
    const button = rule(
      ".chat-context-panel--collapsed .chat-context-panel-collapse",
    );
    expect(panel).toContain("width: 32px");
    expect(panel).toContain("height: 32px");
    expect(panel).toContain("padding: 0");
    expect(button).toContain("inset: 0");
    expect(button).toContain("height: 100%");
  });
});
