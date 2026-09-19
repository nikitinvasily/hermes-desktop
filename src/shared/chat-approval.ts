export const APPROVAL_CHOICES = ["once", "session", "always", "deny"] as const;

export type ApprovalChoice = (typeof APPROVAL_CHOICES)[number];

export interface ChatApprovalRequest {
  requestId: string;
  command: string;
  description: string;
  choices: ApprovalChoice[];
}

const VALID_CHOICES = new Set<string>(APPROVAL_CHOICES);

/** Only a gateway-issued ID can safely address a pending approval. */
export function gatewayApprovalRequestId(payload: unknown): string | null {
  const value = record(payload)?.request_id;
  return typeof value === "string" && value.trim() && value.length <= 256
    ? value
    : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    })
    .join("")
    .trim()
    .slice(0, maxLength);
}

function firstText(
  sources: Array<Record<string, unknown> | null>,
  fields: string[],
  maxLength: number,
): string {
  for (const source of sources) {
    if (!source) continue;
    for (const field of fields) {
      const value = cleanText(source[field], maxLength);
      if (value) return value;
    }
  }
  return "";
}

const SECURITY_SCAN_NOISE_RE = new RegExp(
  [
    // Whole wrapper sentences whose parenthesized payload is scanner output:
    // "Command required approval (Security scan — …)" / "Command was flagged (Security scan — …)"
    String.raw`Command (?:required approval|was flagged)\s*\((Security scan[^)]*)\)`,
    // Trailing severity segments appended after the real description:
    // "; [HIGH] Nested executable body …"
    String.raw`;\s*\[(?:HIGH|MEDIUM|LOW|CRITICAL|INFO)\][^;]*`,
    // A bare leading "Security scan — …" payload without the wrapper verb
    // (observed live: descriptions starting directly with "Security scan") —
    // when the description BEGINS with scanner output, everything after it is
    // scanner prose too, including the trailing "; …" segments
    String.raw`^Security scan\s*[—-][\s\S]*`,
    // A bare leading severity segment (when the wrapper was already
    // stripped): consumes the scanner prose up to a ";" boundary or the end
    String.raw`^\s*\[(?:HIGH|MEDIUM|LOW|CRITICAL|INFO)\][^;]*`,
  ].join("|"),
  "gi",
);

/**
 * Strip server-side security-scanner boilerplate (Tirith "Security scan — …"
 * wrappers and trailing severity segments) from an approval description.
 * Genuine descriptions from other sources pass through untouched; an empty
 * result means the row should be hidden entirely.
 */
export function stripSecurityScanNoise(description: string): string {
  if (!description) return "";
  let text = description;
  let previous: string;
  do {
    previous = text;
    text = text.replace(SECURITY_SCAN_NOISE_RE, " ");
  } while (text !== previous);
  return text.replace(/\s{2,}/g, " ").trim();
}

export function normalizeApprovalRequest(
  payload: unknown,
  requestId: string,
): ChatApprovalRequest {
  const root = record(payload);
  const nested = [
    record(root?.approval),
    record(root?.request),
    record(root?.tool_call),
    record(root?.tool),
  ];
  const sources = [root, ...nested];
  const rawChoices = root?.choices;
  const hasExplicitChoices = Array.isArray(rawChoices);
  const choices: ApprovalChoice[] = [];

  if (hasExplicitChoices) {
    for (const rawChoice of rawChoices) {
      if (typeof rawChoice !== "string") continue;
      const choice = rawChoice.trim().toLowerCase();
      if (!VALID_CHOICES.has(choice)) continue;
      if (choice === "always" && root?.allow_permanent === false) continue;
      if (!choices.includes(choice as ApprovalChoice)) {
        choices.push(choice as ApprovalChoice);
      }
    }
  } else if (root?.smart_denied === true) {
    choices.push("once");
  } else {
    choices.push("once");
    if (typeof root?.allow_permanent === "boolean") choices.push("session");
    if (root?.allow_permanent === true) choices.push("always");
  }

  if (!choices.includes("deny")) choices.push("deny");

  return {
    requestId,
    command:
      firstText(
        sources,
        ["command", "cmd", "command_line", "input", "args", "action"],
        8192,
      ) || "Command details unavailable",
    description:
      firstText(
        sources,
        [
          "description",
          "reason",
          "message",
          "prompt",
          "summary",
          "pattern_description",
          "warning",
        ],
        2048,
      ) || "Hermes requires approval before continuing.",
    choices,
  };
}
