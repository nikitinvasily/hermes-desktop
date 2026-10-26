# Chat Machine Envelopes

The agent core injects machine-authored bracketed envelopes into the transcript as user rows; the renderer detects them and shows compact notices instead of raw bubbles.

## Envelope detection

Detection is content-first over caps headers; the backend's `display_kind` tags (steer, internal_notification) cover the same rows but are not yet threaded into renderer messages.

[[src/renderer/src/screens/Chat/envelopeUtils.ts#parseEnvelope]] recognizes the envelope families the core produces (`[ASYNC DELEGATION …]`, `[OUT-OF-BAND USER MESSAGE …]`, `[System: …]`, `[SILENT]`, and a generic ALL-CAPS fallback for future envelopes). The detector regex requires a bracketed English CAPS header, so human text merely starting with `[` never matches (covered by the parser tests in [[src/renderer/src/screens/Chat/envelopeUtils.test.ts]], fixtures taken from live state.db rows).

## User text copying

User bubbles keep Copy available while the agent is generating. Copy writes the full original user text, including all Markdown paragraphs, without the known gateway or OUT-OF-BAND wrapper.

[[src/renderer/src/screens/Chat/envelopeUtils.ts#parseEnvelope]] removes only the leading known envelope/preamble and its terminal closing marker. Origin metadata stays in the caption, not the copied text. [[src/renderer/src/screens/Chat/MessageRow.tsx#MessageRow]] keeps streaming assistant bubbles and slash loaders excluded; pure machine notices remain notices. [[src/renderer/src/screens/Chat/MessageRow.test.tsx]] verifies plain, Telegram, wrapped steer and desktop OOB text in streaming and idle states.

## Envelope rendering

Suppressed envelopes render as the compact centered notice shape from the background-process notifications; the OUT-OF-BAND steer keeps its user text as a real bubble.

In [[src/renderer/src/screens/Chat/MessageRow.tsx#MessageRow]], a parsed envelope with `suppressBubble` renders as a centered notice (headline, key/value meta chips for goal/status/duration, collapsible details for RESULT/JOB OUTPUT), reusing the `.chat-message-process-note` styles. The `[IMPORTANT: Background process …]` family keeps its dedicated renderer and runs first. An OUT-OF-BAND steer is the exception: its extracted user paragraph becomes the bubble content and the origin JSON becomes a small "via platform chat_type" caption under it ([[src/renderer/src/screens/Chat/envelopeUtils.ts#parseEnvelope]] extracts both), because the steer IS real user input — only the wrapper chrome is machine text.
