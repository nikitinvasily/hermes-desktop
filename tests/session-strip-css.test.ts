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
