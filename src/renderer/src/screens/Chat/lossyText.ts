// @lat: [[chat-commands#Slash command execution#Completion text reconciliation]]

/**
 * A CJK "word" is usually 1-2 characters, so a fixed 3-character run is
 * much weaker evidence of genuine continuity there than in English (where
 * it is often most of a word): the small effective alphabet per position
 * lets an unrelated run recur by coincidence. `DENSE_SCRIPT_MIN_RUN` asks
 * for a longer, exponentially rarer run once dense-script text is involved.
 */
// A hand-enumerated range table is a fragile way to answer "is this
// character CJK ideographic": it silently omits whichever block nobody
// thought to add (Extensions C-I and the Compatibility Ideographs
// Supplement, missed here originally). \p{Script=...} is the Unicode
// database itself, so it can't go stale the same way. Han alone covers
// every Unified/Extension/Compatibility ideograph block, BMP and
// supplementary plane; Hiragana/Katakana/Hangul are separate scripts and
// stay listed explicitly.
const DENSE_SCRIPT_RE =
  /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;
// Known limitation: a genuine chunk-dropped copy whose surviving contiguous
// run between two drops is shorter than this can be missed (false negative,
// the damaged stream is not reconciled). Lowering the run for dense-script
// text reopens the false positive this constant exists to prevent (#793):
// unrelated CJK text can share a 3-char run by coincidence, and a synthetic
// counterexample sits at a similar coverage (0.31) to a genuine short-run
// chunk-drop (0.54), so a coverage-gated fallback is not a safe fix without
// real streaming data to calibrate the threshold against.
const DENSE_SCRIPT_MIN_RUN = 6;

// Real damaged streams are not surgical substring excisions: they also carry
// a few characters that exist nowhere in the canonical text — a stray
// backtick from a markdown span that never assembled, a head fragment cut to
// 1-2 chars at the stream start. The matcher may skip such chars, but only
// a bounded number, so "unrelated text" still can't be skipped into a match.
const MAX_JUNK_RATIO = 0.05;
const MIN_JUNK_BUDGET = 3;

function isDenseScriptChar(char: string): boolean {
  return DENSE_SCRIPT_RE.test(char);
}

function isDenseScriptHeavy(s: string): boolean {
  const chars = [...s];
  if (chars.length === 0) return false;
  const denseCount = chars.filter(isDenseScriptChar).length;
  return denseCount / chars.length > 0.3;
}

/**
 * Detect whether `partial` looks like a chunk-dropped copy of `full`.
 *
 * A stream assembled with dropped delta chunks is a concatenation of
 * **contiguous substrings** of the canonical text, in order — e.g.
 * "! What are we working on?" for "Hey! What are we working on today?", or
 * "Sat planet from the Sun" for "Saturn is the sixth planet from the Sun".
 *
 * A plain character-subsequence test is too loose: unrelated English
 * sentences often embed as scattered 1–2 character fragments, which would
 * make a genuine pre-tool-call segment (or a distinct short reasoning
 * segment) look like a damaged copy and get erased. So the match is greedy
 * over runs: every matched segment must be at least `minRun` characters
 * (the last segment may be shorter — a trailing "?" survives chunking), with
 * arbitrary gaps between runs. On top of the shape test, callers get
 * coverage guards: the partial must be non-trivial (≥ `minLength`) and cover
 * a substantial share of the full text (≥ `minCoverage`), so a tiny
 * fragment can never cancel a long canonical text.
 *
 * Inputs are expected to be whitespace-normalized by the caller.
 */
export function isLossyChunkCopy(
  partial: string,
  full: string,
  {
    minRun,
    minLength = 12,
    minCoverage = 0.3,
  }: { minRun?: number; minLength?: number; minCoverage?: number } = {},
): boolean {
  if (!partial || !full) return false;
  // Admission and matching use the same Unicode code-point metric.
  const partialChars = [...partial];
  const fullChars = [...full];
  if (partialChars.length < minLength) return false;
  if (partialChars.length >= fullChars.length) return false;
  if (partialChars.length < minCoverage * fullChars.length) return false;

  const denseScript = isDenseScriptHeavy(partial) || isDenseScriptHeavy(full);
  const run = minRun ?? (denseScript ? DENSE_SCRIPT_MIN_RUN : 3);

  // Budget of characters in `partial` that may fail to anchor anywhere in
  // `full` (stray backticks, truncated head fragments) before the shape test
  // gives up. Bounded by ratio AND a small absolute floor so both a short
  // partial and a long one stay conservative. Dense-script text gets NO
  // budget: its raised run length exists precisely because a coincidental
  // run recurs by chance there (#793), and skipping unanchored chars would
  // compound that coincidence into a false match.
  let junkBudget = denseScript
    ? 0
    : Math.max(
        Math.floor(MAX_JUNK_RATIO * partialChars.length),
        Math.min(MIN_JUNK_BUDGET, partialChars.length - 1),
      );

  // `run` counts CHARACTERS, and a JS string index counts UTF-16 code
  // units: a supplementary-plane ideograph (Extension B and later) is a
  // surrogate pair, two code units per character. Indexing `partial`/`full`
  // directly would silently measure a "6-unit" probe as 3 real ideographs
  // for exactly the dense-script text this run length exists to protect.
  // Work over code-point arrays instead so `probeLen`/`len` below are
  // character counts, matching what `run` means.
  let i = 0; // position in partialChars
  let j = 0; // position in fullChars
  while (i < partialChars.length) {
    const remaining = partialChars.length - i;
    const probeLen = Math.min(run, remaining);
    const at = indexOfSeq(fullChars, partialChars, i, probeLen, j);
    if (at < 0) {
      // The probe didn't anchor: either this is a boundary stub (a 1-2 char
      // head cut mid-word, e.g. "У" from "Уведомление") or a junk char that
      // exists nowhere in the canonical text (a stray backtick from a
      // markdown span that never assembled). Skip exactly ONE character
      // against a bounded budget — skipping the whole probe would burn the
      // budget on a single failure and jump past valid anchors. Exhausting
      // the budget means the partial is not a copy of this full text.
      junkBudget -= 1;
      if (junkBudget < 0) return false;
      i += 1;
      continue;
    }
    // A short trailing probe (the final run) may be under `run`; any other
    // run must anchor with at least `run` matching characters.
    if (probeLen < run && remaining > probeLen) return false;
    // Extend the run as far as the two texts agree.
    let len = probeLen;
    while (
      i + len < partialChars.length &&
      at + len < fullChars.length &&
      partialChars[i + len] === fullChars[at + len]
    ) {
      len++;
    }
    i += len;
    j = at + len;
  }
  return true;
}

// Find the first index >= `from` in `haystack` where the `len`-character
// slice `needle[start..start+len)` occurs contiguously, character by
// character (never joining back to a string, which would reintroduce the
// UTF-16-code-unit measurement `isLossyChunkCopy` exists to avoid).
function indexOfSeq(
  haystack: string[],
  needle: string[],
  start: number,
  len: number,
  from: number,
): number {
  outer: for (let k = from; k <= haystack.length - len; k++) {
    for (let m = 0; m < len; m++) {
      if (haystack[k + m] !== needle[start + m]) continue outer;
    }
    return k;
  }
  return -1;
}
