import { normalizeModelEndpointUrl } from "./model-endpoint";

/**
 * Two attachment rows are the *same pickable model* when their provider+model
 * ids match and their endpoints agree after normalization — where an empty
 * baseUrl agrees with anything: for named providers the backend substitutes
 * the canonical URL anyway ([[src/renderer/src/screens/Chat/hooks/useModelConfig#effectiveOverrideBaseUrl]]),
 * so a library row saved with an empty baseUrl and a config-derived row
 * carrying the canonical URL are one entry, not two (issue #170).
 * Two distinct explicit URLs (custom endpoints) stay separate rows.
 */
export function isSameModelAttachment(
  a: { provider: string; model: string; baseUrl?: string },
  b: { provider: string; model: string; baseUrl?: string },
): boolean {
  if (
    a.provider.trim().toLowerCase() !== b.provider.trim().toLowerCase() ||
    a.model.trim().toLowerCase() !== b.model.trim().toLowerCase()
  ) {
    return false;
  }
  const urlA = normalizeModelEndpointUrl(a.baseUrl || "");
  const urlB = normalizeModelEndpointUrl(b.baseUrl || "");
  return urlA === "" || urlB === "" || urlA === urlB;
}

/**
 * Collapse duplicate attachment rows with {@link isSameModelAttachment}.
 * The first occurrence wins position; a merged row inherits the non-empty
 * baseUrl and explicit contextLength from any row it absorbs, so dropping the
 * duplicate never loses endpoint routing or context-window metadata.
 */
export function dedupeAttachmentRows<
  T extends { provider: string; model: string; baseUrl?: string },
>(rows: T[]): T[] {
  const result: T[] = [];
  for (const row of rows) {
    const existing = result.find((kept) => isSameModelAttachment(kept, row));
    if (!existing) {
      result.push(row);
      continue;
    }
    if (!existing.baseUrl && row.baseUrl) {
      existing.baseUrl = row.baseUrl;
    }
  }
  return result;
}
