# Automatic session title generation

Untitled local sessions receive a short fallback title from their first user message when the session cache is populated. Explicit database titles and existing cached titles keep their current precedence.

[[src/main/session-cache.ts#generateTitle]] removes Markdown decoration and URLs, then uses the existing 50-unit short-message threshold and 45-unit truncation budget. These budgets count UTF-16 code units; word-boundary selection is unchanged.

## Unicode truncation

Fallback truncation must never split a valid surrogate pair into a malformed title. If the 45-unit boundary bisects a supplementary character, stop one unit earlier before adding the ellipsis.

[[tests/session-cache-sync.test.ts]] exercises real cache synchronization and the subsequent disk-cache read with repeated emoji and mixed CJK/emoji messages. This protects newly generated titles without rewriting user-chosen titles or existing cached entries.

## Existing title budgets

ASCII fallback, word selection, short messages and supplementary characters before or after the cutoff retain their existing behavior. The limit stays in UTF-16 code units, not Unicode code points.

Cache tests cover pairs ending exactly at the cutoff, messages at 50 and 51 units, and an emoji word over the 45-unit budget. Fallback truncation still appends three dots; word-boundary titles do not.
