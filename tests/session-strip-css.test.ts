// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve("src/renderer/src/assets/main.css"), "utf8");
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{([^}]+)\\}`, "m"));
  expect(match, `Missing CSS rule ${selector}`).not.toBeNull();
  return match![1];
}

describe("session-strip-free shell CSS contract", () => {
  it("removes the tab row, chips and drawer clearance instead of leaving an empty band", () => {
    expect(css).not.toMatch(/\.active-session(?:s-bar|-chip|-new)/);
    expect(rule(".kanban-detail-drawer")).not.toMatch(/padding-top/);
    expect(rule(".content")).not.toMatch(/(?:padding|margin)-top/);
  });

  it("adds a small inset only inside chat panes, not the app-wide content", () => {
    const chat = rule(".chat-container");
    expect(chat).toMatch(/padding-top:\s*24px/);
    expect(chat).toMatch(/box-sizing:\s*border-box/);
    expect(rule(".content")).not.toMatch(/(?:padding|margin)-top/);
  });

  it("insets the floating context panel 12px down and left from the conversation edge", () => {
    const panel = rule(".chat-context-panel");
    expect(panel).toMatch(/top:\s*12px\s*;/);
    expect(panel).toMatch(/margin-right:\s*12px\s*;/);
    expect(panel).toMatch(/position:\s*absolute/);
    expect(panel).toContain("calc(24px + var(--chat-scrollbar-gutter, 0px))");
    expect(panel).toContain(
      "calc((100% - 1300px + var(--chat-scrollbar-gutter, 0px)) / 2)",
    );
    expect(panel).toContain(
      "max-width: min(300px, calc(100% - 60px - var(--chat-scrollbar-gutter, 0px)))",
    );
  });

  it("uses the existing raised surface for the sidebar and floating context panel", () => {
    expect(rule(".sidebar")).toMatch(/background:\s*var\(--bg-tertiary\)/);
    expect(rule(".app.shell-vibrant .sidebar")).toMatch(
      /background:\s*var\(--bg-tertiary\)/,
    );
    expect(rule(".chat-context-panel")).toMatch(
      /background:\s*var\(--bg-tertiary\)/,
    );
    expect(rule(".sidebar-recent-session.active")).toMatch(
      /background:\s*var\(--sidebar-hover-bg\)/,
    );
  });

  it("confines main-window dragging above the traffic lights without covering controls", () => {
    const drag = rule(".is-mac .sidebar-drag-region");
    expect(drag).toMatch(/-webkit-app-region:\s*drag/);
    expect(drag).toMatch(/position:\s*absolute/);
    expect(drag).toMatch(/top:\s*0/);
    expect(drag).toMatch(/left:\s*0/);
    expect(drag).toMatch(/right:\s*8px/);
    expect(drag).toMatch(/height:\s*12px/);
    expect(drag).not.toMatch(/z-index|position:\s*fixed/);
    expect(rule(".sidebar")).toMatch(/position:\s*relative/);
    expect(rule(".sidebar-brand")).toMatch(/margin-top:\s*12px/);
    expect(rule(".sidebar-collapsed .sidebar-brand")).toMatch(
      /margin-top:\s*18px/,
    );
  });
});
