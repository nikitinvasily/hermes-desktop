# Discover marketplace

The Discover tab browses the community registry catalog (public GitHub) and installs items into the active profile.

In direct Remote mode the catalog stays machine-independent, while every "installed" marker and "Set up" action goes to the SERVER through the dashboard REST API ([[src/main/remote-registry.ts]]): skills via `/api/skills` + file uploads through `/api/fs/write-text` (directories via `/api/files/mkdir`), MCP servers spliced into the server's `config.yaml`, agents created via `POST /api/profiles` with the published persona as SOUL.md. See also [[mcp-servers]] for the MCP management tab sharing the same transport.

Because the installed set is per-connection, the screen also reloads it when the active connection switches ([[src/renderer/src/hooks/useConnectionChangeReload.ts#useConnectionChangeReload]]), so a local/remote flip never leaves the previous source's markers on screen.

## Local install shapes

Locally, [[src/main/registry.ts#installRegistryItem]] dispatches per kind: registry-folder skills download under `skills/<category>/<id>/`, MCP servers append a YAML block, agents clone a profile, workflows land in `workflows/<id>/`.

## Pinned registry integrity

Discover reads a pinned Git commit and root tree, not a mutable branch. The same verified snapshot supplies local and direct Remote installs.

The recursive tree response must be complete. Rebuilding each Git tree binds file paths, supported modes, parent directories and blob identities to the pinned root. Every fetched blob must match its Git object hash before catalog, detail or installer code uses it. A missing optional manifest is allowed only when the verified tree proves absence; network, malformed JSON and integrity errors are not treated as absence.

Folder downloads finish verification before the first destination write. Agent installs verify the manifest and persona before creating a profile; MCP configuration is rendered only from a verified manifest. A later file mismatch must not leave an earlier verified file installed. Once verification has completed, a subsequent destination I/O failure can still leave a partial install; this is not a transactional rollback guarantee.

Remote requests retain their connection and profile. The existing text-only upload API must reject non-lossless UTF-8 folder content before any remote mutation instead of silently changing verified bytes. This does not add an SSH transport or change the existing IPC dispatch.

## Integrity test boundaries

Tests distinguish trusted snapshot identity from untrusted download responses and assert that rejected downloads cause no destination mutations.

Fixtures cover valid downloads, corrupt catalog/manifests/personas/folder bytes, incomplete or malformed trees, unsupported modes and unsafe paths. Local tests retain binary bytes; direct Remote tests retain profile-scoped writes and reject binary content that its text transport cannot preserve. Packaged checks use disposable homes and fake endpoints, never user profiles or production servers.
