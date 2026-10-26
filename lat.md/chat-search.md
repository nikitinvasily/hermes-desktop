# In-session message search

Cmd+F (Ctrl+F on other platforms) searches rendered user and assistant bubble text in the active chat, including loaded historical messages outside the mounted transcript window.

[[src/renderer/src/screens/Chat/useMessageSearch.tsx#useMessageSearch]] owns the header input, literal case-insensitive occurrence count, previous/next controls, Enter/Shift+Enter navigation and Escape. Switching chats, connections, profiles, clearing the conversation or closing search clears its query and highlights. Background mounted chats do not register the shortcut.

## Rendered text and highlighting

Search indexes the same GFM Markdown structure used to render bubbles, so link destinations, Markdown syntax and image metadata are not phantom results.

[[src/renderer/src/screens/Chat/searchMarkdown.ts#searchMessages]] caches parsed text blocks by immutable message object in a chat-local WeakMap. Inline Markdown spans concatenate within each paragraph, heading, table cell or list block; fenced code is searchable, including diffs. Matches do not cross separate rendered blocks or media segments. Changed streaming messages are reindexed; an existing selected occurrence keeps its identity.

[[src/renderer/src/screens/Chat/searchHighlights.ts#paintSearchHighlights]] maps indexed UTF-16 offsets onto live DOM Range objects and paints CSS Custom Highlights. React-owned DOM is never rewritten. Syntax-highlighter loads and streaming node replacements rebind ranges through a scoped MutationObserver. Only the active owner removes its registry entries. Long code in the selected bubble is temporarily revealed, without changing its saved expansion state. Selected ranges are also revealed inside nested horizontal code scrollers, including after asynchronous node replacement. Inline images/download chips are zero-width search boundaries: adjacent text cannot form phantom matches and following text retains its DOM offsets. Diff separator newlines retain text parity without adding visual blank lines.

Scope is deliberately bubble text only: reasoning rows, tool-call arguments/results, approval/clarification cards, system timeline events, machine-authored notices/compaction, attachment names, image/vision descriptions, media paths, error metadata and slash-loader status text are not indexed. Out-of-band user steers search their displayed user text, not envelope metadata.

## Bounded historical reveal

Selecting an old result mounts a bounded window around its message instead of mounting every row between that result and the latest output.

[[src/renderer/src/screens/Chat/MessageList.tsx#MessageList]] renders at most [[src/renderer/src/screens/Chat/MessageList.tsx#TRANSCRIPT_WINDOW]] ordinary rows around the target, plus any unresolved interaction cards outside that range. Search disables history auto-expansion and reading-boundary updates for the entire open-search lifetime, including empty/no-hit queries. Empty/no-hit queries keep the last focused window; closing search restores the normal transcript window and untouched expansion budget.

[[src/renderer/src/screens/Chat/hooks/useChatScroll.ts#useChatScroll]] pauses automatic bottom scrolling while search is open, including new user rows and streaming deltas. Navigation scrolls the selected range, not every streamed update. Closing restores the previous scroll position and keyboard focus. The transcript remains block flow with content-visibility containment; only the selected row opts into visible layout so its range can be measured.

## Verification

Targeted tests cover real Markdown rendering, old-history reveal, literal punctuation, streaming updates, keyboard navigation, active-chat ownership and cleanup.

[[src/renderer/src/screens/Chat/messageSearch.test.tsx]] checks rendered-text/index parity for Markdown, code, GFM lists/tables and diffs, exclusions and temporary long-code reveal. [[src/renderer/src/screens/Chat/useMessageSearch.test.tsx]] exercises keyboard/buttons, CSS range text and the real MessageList with 360 rows. [[src/renderer/src/screens/Chat/MessageList.test.tsx]] checks a 1,000-row bounded reveal, restoration and pending-card visibility. [[src/renderer/src/screens/Chat/hooks/useChatScroll.test.tsx]] guards streaming/user-message auto-scroll suspension. [[tests/chat-search-layout.test.ts]] guards diff whitespace rules; range tests cover real DownloadChip boundaries and async horizontal reveal. MessageList regressions cover target → no-hit → close and preservation of a previously expanded history budget.
