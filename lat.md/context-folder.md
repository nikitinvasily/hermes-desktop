# Linked working folder

A conversation can be bound to a working folder (issue #27) — a desktop-only binding that scopes the agent's work. It is sent to the agent per message as a system message, and persisted per session so re-opening a conversation restores its folder.

## Desktop-only persistence

The folder isn't part of hermes-agent's session schema, so it lives in a desktop-owned table in the active profile's `state.db`, keyed by `session_id`.

[[src/main/session-context-folder-store.ts]] holds `desktop_session_context_folders` (mirroring [[src/main/session-continuation-store.ts]]): [[src/main/session-context-folder-store.ts#setSessionContextFolder]] upserts or, for a null folder, deletes the row; [[src/main/session-context-folder-store.ts#getSessionContextFolder]] reads it. The row is dropped with the rest of a session's data in [[src/main/sessions.ts#deleteSessionRows]] so a deleted session leaves no orphan binding.

## Restore and save in the chat

The chat loads the stored folder when resuming a session and saves it whenever it changes, once the conversation has a gateway session id.

In [[src/renderer/src/screens/Chat/Chat.tsx#Chat]] a load effect fetches the folder for `initialSessionId` on mount; a save effect writes `contextFolder` via `setSessionContextFolder` on every change. The save is gated on a "loaded" ref so the initial null can't overwrite a resumed session's stored folder before the load resolves. A brand-new chat saves once its session id resolves after the first message, binding the pre-selected folder to the new session.

## Projects dropdown

The context folder picker offers projects (issue #29): picking a project binds its primary folder as the session cwd, so users choose a project rather than a raw path.

[[src/renderer/src/screens/Chat/ContextFolderChip.tsx#ContextFolderChip]] lists projects from the `list-projects` IPC channel ([[src/main/projects.ts#localListProjects]] locally, the dashboard tree remotely) with name plus primary-folder hint; the current session marks the project owning its cwd as active. Projects without a primary folder render disabled; an empty or failed list hides the section. Only existing projects are offered — there is no raw folder-browsing entry anymore in the chip.

## Resizable tree panel

The context-folder tree panel uses a compact header and can be resized from its left edge, mirroring the in-app browser panel.

[[src/renderer/src/screens/Chat/WorktreePanel.tsx#WorktreePanel]] stores its width in `localStorage` under `hermes:worktreePanelWidth`, clamps it between a usable minimum and the available chat width, and updates it through a pointer-drag handle styled by `.worktree-resize-handle`.

## Remote directory listing

Remote and SSH folder pickers (e.g. the project dialogs' SSH browser) list directories through an IPC channel rather than local filesystem calls.

`read-directory` is routed by [[src/main/ipc/register.ts#registerIpcHandlers]] to [[src/main/ssh-remote.ts#sshReadDirectory]] for SSH connections and returns no listing for pure Remote Gateway mode until the backend exposes a directory-list endpoint, so pickers still allow typed remote paths.

## Muted tree icons

The tree keeps category-specific file icon shapes but normalizes their colors so the explorer reads quietly in the chat sidebar.

Lucide SVGs render inside `.worktree-file-icon-wrapper` with the same low-opacity white tone as folder icons.

### Browser-safe file icons

Worktree file icons must remain renderer-only, avoid runtime filesystem access and raw SVG injection, and preserve useful category distinctions.

[[src/renderer/src/screens/Chat/WorktreePanel.tsx#worktreeFileIconKind]] maps common source, text, image, archive, and spreadsheet names to bundled Lucide components. Unknown files receive a generic icon. [[src/renderer/src/screens/Chat/WorktreePanel.test.tsx]] protects representative mappings.
