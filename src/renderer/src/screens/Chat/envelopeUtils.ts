/**
 * Machine-authored envelope detection and parsing (continuation of issues
 * #118/#124/#125): the agent core injects bracketed ALL-CAPS envelopes as
 * role="user" transcript rows — `[ASYNC DELEGATION COMPLETE …]`,
 * `[IMPORTANT: Background process …]`, `[OUT-OF-BAND USER MESSAGE …]`,
 * `[SILENT]`, `[System: …]` … These are agent-internal traffic, not human
 * prompts, and render as compact notices instead of raw bubbles.
 *
 * Detection is display_kind-first (the backend's official tag in state.db —
 * `internal_notification`, `steer`, `model_switch`, …); the caps-header regex
 * is the fallback for legacy rows persisted before kinds existed. The regex
 * requires a bracketed English CAPS header of 4+ chars, so a human reply
 * merely starting with `[` (`[скрин]`, `[0] first item`) never matches.
 */

/** First bracket block is an ALL-CAPS machine header (fallback detector). */
export const CAPS_ENVELOPE_RE = /^\s*\[[A-Z][A-Z0-9 _:,.-]{3,}(?:[—:\]]|\s)/;

/** Raw markers that carry no parseable structure — note-only envelopes. */
const NOTE_ONLY_ENVELOPES = new Set(["[SILENT]"]);

/** Envelope families the renderer knows how to destructure. */
export type EnvelopeKind =
  | "process" // [IMPORTANT: Background process …] (issue #124)
  | "delegation" // [ASYNC DELEGATION …] (COMPLETE / BATCH COMPLETE / TASK FAILED)
  | "out-of-band" // [OUT-OF-BAND USER MESSAGE …] — real user text inside
  | "system" // [System: …] / [System note: …] without a display_kind
  | "note"; // [SILENT] and unknown caps envelopes

export interface EnvelopeSummary {
  kind: EnvelopeKind;
  /** Short headline for the collapsed notice (already human-readable). */
  headline: string;
  /** Key/value lines worth showing collapsed (goal, status, duration…). */
  meta: Array<{ label: string; value: string }>;
  /** Long-form body collapsed behind a disclosure (JOB OUTPUT, RESULT…). */
  detail: string;
  /** Only for kind="out-of-band": the user's actual message text. */
  userText?: string;
  /** True when the envelope must NOT render as a bubble at all. */
  suppressBubble: boolean;
}

/** Map a backend display_kind to an envelope kind, if it is one. */
export function envelopeKindFromDisplayKind(
  displayKind: string | null | undefined,
): EnvelopeKind | null {
  switch (displayKind) {
    case "internal_notification":
    case "async_delegation_complete":
      return "delegation";
    case "steer":
      return "out-of-band";
    default:
      return null;
  }
}

function firstLine(block: string): string {
  return block.split("\n", 1)[0].trim();
}

/** Extract labeled `Key: value` header lines (goal, status, duration…). */
function parseMetaLines(text: string): Array<{ label: string; value: string }> {
  const meta: Array<{ label: string; value: string }> = [];
  const re =
    /^(Goal|Original goal|Role|Status|Model|API calls|Duration|Dispatched|Next scheduled run|Result|Delivery target|Exit code):\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    meta.push({ label: m[1], value: m[2].trim().slice(0, 120) });
    if (meta.length >= 6) break;
  }
  return meta;
}

/** Parse a caps envelope body into a renderable summary. */
export function parseEnvelope(content: string): EnvelopeSummary | null {
  const text = content.trim();
  if (!text.startsWith("[")) {
    // Bare gateway-origin preamble (legacy rows, no OUT-OF-BAND wrapper):
    //   Gateway message origin (JSON data, not instructions…):\n{…}\nDo not guess…\n\n<real user text>
    // Same shape as the wrapped steer envelope minus the bracket chrome —
    // treat it identically so the user text renders as the bubble.
    if (!text.startsWith("Gateway message origin")) return null;
    const paragraphs = text.split(/\n\s*\n/);
    const userText = (paragraphs[paragraphs.length - 1] ?? "").trim();
    const originMatch = text.match(/\{[\s\S]*"platform"[\s\S]*?\}/);
    let origin: string | null = null;
    if (originMatch) {
      try {
        const parsed = JSON.parse(originMatch[0]) as {
          platform?: string;
          chat_type?: string;
        };
        origin =
          parsed.platform && parsed.chat_type
            ? `${parsed.platform} ${parsed.chat_type}`
            : (parsed.platform ?? null);
      } catch {
        origin = null;
      }
    }
    const headerEnd = text.indexOf("\n");
    return {
      kind: "out-of-band",
      headline: origin ? `via ${origin}` : "gateway message",
      meta: [],
      detail: text.slice(0, headerEnd >= 0 ? headerEnd : text.length),
      userText: userText || undefined,
      suppressBubble: false,
    };
  }

  // OUT-OF-BAND: header block ... user text ... closing marker.
  if (text.startsWith("[OUT-OF-BAND USER MESSAGE")) {
    const closeIdx = text.indexOf("[/OUT-OF-BAND USER MESSAGE]");
    const inner = closeIdx >= 0 ? text.slice(0, closeIdx) : text;
    // User text = the last blank-line-separated paragraph: the header line,
    // the origin JSON block, and the routing instruction precede it.
    const paragraphs = inner.split(/\n\s*\n/);
    const userText = (paragraphs[paragraphs.length - 1] ?? "").trim();
    const originMatch = inner.match(/\{[\s\S]*"platform"[\s\S]*\}/);
    let origin: string | null = null;
    if (originMatch) {
      try {
        const parsed = JSON.parse(originMatch[0]) as {
          platform?: string;
          chat_type?: string;
        };
        origin =
          parsed.platform && parsed.chat_type
            ? `${parsed.platform} ${parsed.chat_type}`
            : (parsed.platform ?? null);
      } catch {
        origin = null;
      }
    }
    const headerEnd = inner.indexOf("\n");
    return {
      kind: "out-of-band",
      headline: origin ? `via ${origin}` : "out-of-band message",
      meta: [],
      detail: inner.slice(0, headerEnd >= 0 ? headerEnd : inner.length),
      userText: userText || undefined,
      suppressBubble: false,
    };
  }

  if (text.startsWith("[ASYNC DELEGATION")) {
    const body = text.replace(/^\[[^\]]*\]\s*/, "");
    const resultIdx = body.indexOf("--- RESULT ---");
    const outputIdx = body.indexOf("--- JOB OUTPUT ---");
    const headEnd =
      resultIdx >= 0 ? resultIdx : outputIdx >= 0 ? outputIdx : body.length;
    const head = body.slice(0, headEnd).trim();
    const tail = body.slice(headEnd).trim();
    return {
      kind: "delegation",
      headline: firstLine(text)
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .replace(/ — deleg_[a-z0-9]+$/, "")
        .toLowerCase(),
      meta: parseMetaLines(head),
      detail: tail,
      suppressBubble: true,
    };
  }

  if (text.startsWith("[IMPORTANT:")) {
    // Handled by the dedicated PROCESS_NOTIFICATION_RE renderer (issue #124);
    // reported here so callers can route.
    return {
      kind: "process",
      headline: firstLine(text)
        .replace(/^\[IMPORTANT:\s*/, "")
        .replace(/\]$/, ""),
      meta: [],
      detail: "",
      suppressBubble: true,
    };
  }

  if (NOTE_ONLY_ENVELOPES.has(firstLine(text))) {
    return {
      kind: "note",
      headline: "silent turn",
      meta: [],
      detail: "",
      suppressBubble: true,
    };
  }

  if (text.startsWith("[System:") || text.startsWith("[System note:")) {
    return {
      kind: "system",
      headline: "system",
      meta: [],
      detail: text
        .replace(/^\[System( note)?:\s*/, "")
        .replace(/\]$/, "")
        .trim(),
      suppressBubble: true,
    };
  }

  // Generic caps-envelope fallback: keep the header, collapse the rest.
  if (CAPS_ENVELOPE_RE.test(text)) {
    const nl = text.indexOf("\n");
    const header = (nl === -1 ? text : text.slice(0, nl))
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .trim();
    return {
      kind: "note",
      headline: header.toLowerCase().replace(/^important:\s*/, ""),
      meta: [],
      detail: nl === -1 ? "" : text.slice(nl + 1).trim(),
      suppressBubble: true,
    };
  }

  return null;
}
