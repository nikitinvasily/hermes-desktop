# Chat Experience Preferences

Chat presentation and notification preferences are renderer-owned, persisted locally, and applied through one app-level context.

[[src/renderer/src/components/ChatPreferencesProvider.tsx#ChatPreferencesProvider]] loads safe defaults, persists explicit choices in `localStorage`, and exposes them through [[src/renderer/src/components/ChatPreferencesProvider.tsx#useChatPreferences]]. The fallback context keeps isolated surfaces and mixed-version tests functional when a provider or newer preload method is absent.

## User message Markdown

User prompts use the same Markdown grammar as assistant text while keeping their original source available for copying.

[[src/renderer/src/screens/Chat/MessageRow.tsx#MessageRow]] renders user content through `AgentMarkdown`, including headings, lists, links, and tables. The user-bubble CSS preserves line breaks for ordinary prose, and the copy action still writes the untouched source string rather than rendered text. [[src/renderer/src/screens/Chat/MessageRow.test.tsx]] verifies rendered structure and raw-source copying together.

Visually the user bubble mirrors the chat input row's focused state (issue #92, user preference after the Royal palette landed): `--bg-secondary` surface, `--text-primary` text, and a permanent stroke in the input's focused accent tint (`color-mix(accent 45%)`) with no hover state or transition — the special-case user-bubble `::selection` override became unnecessary with the neutral surface and was removed.

## Completion sound

The completion chime is enabled by default and can be disabled globally from Settings → Notifications.

[[src/renderer/src/components/settings/NotificationsPane.tsx#NotificationsPane]] exposes the master switch. [[src/renderer/src/screens/Chat/chatNotifications.ts#shouldPlayCompletionSound]] permits audio only on a generating-to-idle transition and when the stored preference is enabled, preventing preference changes and ordinary idle renders from producing a sound.

## Native spell checking

Spell checking is enabled by default and supports either system-preferred dictionaries or an explicit multi-language selection.

[[src/main/ipc/register.ts#registerIpcHandlers]] exposes the current Electron session's available, selected, and system-matched dictionaries, validates requested language ids, and applies the result with Electron's session spell-checker API. [[src/renderer/src/components/ChatPreferencesProvider.tsx#ChatPreferencesProvider]] persists enabled/system/custom choices and applies an empty list when spell checking is disabled. [[src/renderer/src/components/settings/LanguagePane.tsx#LanguagePane]] selects system or custom dictionaries, while [[src/renderer/src/screens/Chat/ChatInput.tsx]] binds the enabled flag to its textarea; the Electron session selection also governs other editable renderer fields. [[src/renderer/src/components/ChatPreferencesProvider.test.tsx]] protects persistence, multi-language application, and disabling.

## System event rows

Machine-authored history pivots (model switch, auto-continue, personality switch) ride as `role="user"` rows tagged `display_kind`; they must be projected into display-only event lines at read time, never user bubbles (issue #118).

The projection lives in [[src/main/sessions.ts#expandRowsToHistory]] (local reads) with the remote path carrying the same column through `normalizeMessageRow`; [[src/renderer/src/screens/Chat/MessageRow.tsx#MessageRow]] renders the resulting `system_event` kind as a centered dim line with label parity to the TUI and upstream desktop ("model changed", "resumed interrupted turn", ...). `steer` rows are real user input and deliberately stay bubbles; unknown `display_kind` values fall through to the normal user path.

Background-process completions are the untagged sibling of the same problem: the core injects `[IMPORTANT: Background process …]` envelopes as `role="user"` rows with no `display_kind`, so they are detected at render time by shape (PROCESS_NOTIFICATION_RE in [[src/renderer/src/screens/Chat/MessageRow.tsx]], mirroring upstream) and rendered as a compact centered notice with the command/output collapsed behind a details element (issue #124).
