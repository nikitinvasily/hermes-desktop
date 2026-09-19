# Discover marketplace

The Discover tab browses the community registry catalog (public GitHub) and installs items into the active profile.

In direct Remote mode the catalog stays machine-independent, while every "installed" marker and "Set up" action goes to the SERVER through the dashboard REST API ([[src/main/remote-registry.ts]]): skills via `/api/skills` + file uploads through `/api/fs/write-text` (directories via `/api/files/mkdir`), MCP servers spliced into the server's `config.yaml`, agents created via `POST /api/profiles` with the published persona as SOUL.md. See also [[mcp-servers]] for the MCP management tab sharing the same transport.

## Local install shapes

Locally, [[src/main/registry.ts#installRegistryItem]] dispatches per kind: registry-folder skills download under `skills/<category>/<id>/`, MCP servers append a YAML block, agents clone a profile, workflows land in `workflows/<id>/`.
