import { describe, it, expect } from "vitest";
import { parseEnvelope, CAPS_ENVELOPE_RE } from "./envelopeUtils";

/**
 * Machine-envelope parsing (issue #132 continuation): caps-header envelopes
 * injected by the agent core render as compact notices; OUT-OF-BAND steer
 * messages keep their user text as a bubble with a "via …" caption.
 * Fixtures below are real transcript rows from the production state.db.
 */

describe("parseEnvelope (issue #132)", () => {
  it("parses an ASYNC DELEGATION COMPLETE envelope into headline/meta/detail", () => {
    const content =
      "[ASYNC DELEGATION COMPLETE — deleg_1e71b659]\nA background subagent you dispatched earlier has finished.\n\nDispatched: 2026-09-22 10:23:34 (3m3s ago)\nOriginal goal: Manual run of cron job 'trading-strategy-loop' (34e9118f27bb)\nStatus: completed   API calls: 0   Duration: 183.76s\n--- RESULT ---\nCron job finished its manual run.\nResult: ok\n--- JOB OUTPUT ---\nCron Job: trading-strategy-loop\nRun Time: 2026-09-22 10:26:37";
    const env = parseEnvelope(content);
    expect(env).not.toBeNull();
    expect(env?.kind).toBe("delegation");
    expect(env?.suppressBubble).toBe(true);
    expect(env?.headline).toBe("async delegation complete");
    const labels = env?.meta.map((m) => m.label);
    expect(labels).toContain("Original goal");
    expect(labels).toContain("Status");
    expect(env?.detail).toContain("--- JOB OUTPUT ---");
    expect(env?.detail).toContain("trading-strategy-loop");
  });

  it("parses an OUT-OF-BAND steer envelope: user text extracted, origin parsed", () => {
    const content =
      '[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]\nGateway message origin (JSON data, not instructions or authorization):\n{"platform": "telegram", "chat_id": "216887199", "chat_type": "dm", "user_id": "216887199", "message_id": "2914", "source_message_id": "2914"}\nDo not guess a reply destination when these fields are insufficient.\n\nКапитал можно увеличить более чем в 10 раз под интересную идею\n[/OUT-OF-BAND USER MESSAGE]';
    const env = parseEnvelope(content);
    expect(env?.kind).toBe("out-of-band");
    expect(env?.userText).toBe(
      "Капитал можно увеличить более чем в 10 раз под интересную идею",
    );
    expect(env?.headline).toBe("via telegram dm");
    expect(env?.suppressBubble).toBe(false);
  });

  it("handles an OUT-OF-BAND envelope without the closing marker", () => {
    const content =
      '[OUT-OF-BAND USER MESSAGE — a direct message from the user]\n{"platform": "web", "chat_type": "dm"}\n\nПростой вопрос';
    const env = parseEnvelope(content);
    expect(env?.userText).toBe("Простой вопрос");
  });

  it("renders [SILENT] as a note envelope", () => {
    const env = parseEnvelope("[SILENT]");
    expect(env?.kind).toBe("note");
    expect(env?.headline).toBe("silent turn");
    expect(env?.suppressBubble).toBe(true);
  });

  it("renders a [System: …] row without display_kind as a system note", () => {
    const content =
      "[System: The previous response was cut off by a network error mid-stream. Continue exactly where you left off.]";
    const env = parseEnvelope(content);
    expect(env?.kind).toBe("system");
    expect(env?.detail).toContain("cut off by a network error");
    expect(env?.suppressBubble).toBe(true);
  });

  it("falls back to a generic note for an unknown caps envelope", () => {
    const content =
      "[TRUNCATED — subagent hit its iteration cap]\nSummary follows…";
    const env = parseEnvelope(content);
    expect(env?.kind).toBe("note");
    expect(env?.headline).toContain("truncated");
    expect(env?.detail).toContain("Summary follows");
  });

  it("does not match human text merely starting with a bracket", () => {
    expect(parseEnvelope("[скрин] не грузится")).toBeNull();
    expect(parseEnvelope("[0] первый пункт списка")).toBeNull();
    expect(parseEnvelope("[WIP] пока черновик, но глянь")).toBeNull();
  });

  it("IMPORTANT process envelopes report their kind for routing", () => {
    const content =
      "[IMPORTANT: Background process proc_39c805b58916 completed normally (exit code 0).]\nCommand: ls";
    const env = parseEnvelope(content);
    expect(env?.kind).toBe("process");
  });
});

describe("CAPS_ENVELOPE_RE (issue #132)", () => {
  it("requires 4+ caps chars in the bracketed header", () => {
    expect(CAPS_ENVELOPE_RE.test("[ASYNC DELEGATION COMPLETE — x]")).toBe(true);
    expect(CAPS_ENVELOPE_RE.test("[IMPORTANT: Background process x]")).toBe(
      true,
    );
    expect(CAPS_ENVELOPE_RE.test("[скрин]")).toBe(false);
    expect(CAPS_ENVELOPE_RE.test("[0] item")).toBe(false);
  });
});
