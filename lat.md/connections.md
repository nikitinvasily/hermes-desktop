---
lat:
  require-code-mention: true
---

# Connections

Desktop connections use main-process-owned, versioned records so durable identities can be introduced without exposing credentials or breaking existing runtime callers.

## Versioned registry

`desktop.json` stores `connectionRegistry` version 1 with an active connection ID and named records. [[src/main/config.ts#getConnectionConfig]] remains the compatibility adapter for code that needs the active configuration.

[[src/main/config.ts#writeDesktopConfig]] uses a same-directory temporary file and atomic rename so registry and preference updates cannot leave partially written JSON.

Malformed or newer registry documents fail closed and remain untouched. The desktop never rewrites an unreadable or unsupported registry as a fresh Local record, preventing silent credential and preference loss.

The renderer receives the active `connectionId`, name, and SSH target metadata through [[src/main/config.ts#getPublicConnectionConfig]]. [[src/main/config.ts#getPublicConnectionRegistry]] applies the same redaction to every saved record. API keys, private-key contents, OAuth cookies, and tunnel tokens remain outside those bounded public shapes; see [[remote-dashboard-oauth#Credential boundary]].

## Named connection management

Settings can create, rename, select, edit, test, and remove saved Local, Remote/cloud, and SSH connections while the main process retains credentials and validates record mutations.

[[src/renderer/src/components/settings/ConnectionPane.tsx]] places the saved-connection selector above the existing mode editor, so editing and testing continue through one established form. The final record cannot be removed.

The status bar offers a second entry point: when the registry holds more than one record, its mode chip becomes a connection switcher popover ([[src/renderer/src/screens/Layout/StatusBar.tsx]]). Selecting a record routes through the same `selectConnection` IPC, so the main process still owns validation and tunnel teardown. A warning row appears when switching away from the active SSH record, since that stops the one shared tunnel described by [[main-process#SSH dashboard transport]]. Connection switches also run the layout run-transition ([[src/renderer/src/screens/Layout/chatRuns.ts#selectProfileRunTransition]]): open tabs stay mounted bound to their original connection, and the active tab always moves to a run bound to the newly selected connection — without this the visible chat kept showing the previous connection's sessions after switching back.

Selecting or removing the active record stops the one global SSH tunnel before later work reconnects it to the new target, preserving [[main-process#SSH dashboard transport]]. Removing a record aborts only legacy runs keyed to that connection.

## Per-connection status

Settings can manually refresh bounded health, latency, authentication, Agent version, and capability snapshots for every saved record without exposing credentials.

[[src/main/connection-status.ts#getConnectionStatuses]] probes records independently. Remote probes use each main-process-owned API key or OAuth cookie, while SSH probes run direct status and version commands without retargeting the shared tunnel.

The renderer shows the selected record's snapshot and does not poll automatically, avoiding repeated background SSH processes. Inactive records reuse only bounded capability evidence already observed for their stable connection ID; unobserved features remain unknown.

## Legacy migration

The first registry read converts former top-level Local, Remote, or SSH fields into one active record, removes stale singleton fields, and atomically replaces `desktop.json` with the complete migrated document.

### Preserves existing configurations

Migration retains connection mode, Remote authentication and transport preferences, API keys, SSH routing fields, and unrelated desktop preferences.

## Stable active identity

Each migrated or fresh connection gets one random `connectionId`; changing its mode or configuration updates the same record, and its generated display name follows mode changes.

## Session locations

Desktop chat identity is the tuple `{ connectionId, profile, sessionId }`, preventing equal Agent session IDs on different machines or profiles from being treated as one live run.

[[src/renderer/src/screens/Layout/chatRuns.ts#ChatRun]] carries an immutable connection and profile before its Agent session ID resolves. [[src/renderer/src/screens/Layout/chatRuns.ts#findRunByLocation]] reattaches only on an exact tuple match.

Legacy `send-message` IPC scopes its abort handle by connection plus renderer run ID and resolves Local or direct-Remote transport from that connection's immutable main-process config snapshot. Dashboard chats use the same stable identity. Inactive SSH chats cannot retarget the singleton tunnel. Both transports persist the tuple when [[src/renderer/src/screens/Chat/Chat.tsx#Chat]] learns a session ID.

Resumed-chat reads, live transcript reconciliation, and chat deletion carry the same immutable connection and profile through preload IPC. Direct Remote requests therefore retain their endpoint and authentication, Local reads open the requested profile database, and inactive SSH reads fail without retargeting the shared tunnel.

Sidebar and full-list session browsing carry the selected connection and profile through [[src/preload/index.ts]] to [[src/main/ipc/register.ts#registerIpcHandlers]] for list, cache sync, pagination, search, rename, single delete, and bulk delete. Each handler resolves the saved connection record named by that stable ID instead of consulting a later UI selection.

Direct Remote requests build a profile-scoped session configuration. SSH dashboard and CLI fallbacks retain the requested profile, and [[src/main/ssh-remote.ts#sshListCachedSessions]] forwards the requested cache offset instead of restarting pagination at zero.

Local [[src/main/session-cache.ts#syncSessionCache]], [[src/main/session-cache.ts#listCachedSessions]], [[src/main/sessions.ts#listSessions]], [[src/main/sessions.ts#searchSessions]], title mutation, deletion cleanup, and batched context-folder reads resolve `state.db` and `sessions.json` from the explicit profile. Omitted IDs retain the active connection/profile fallback for legacy callers.

### Remote settings parity

Direct Remote connections route the Settings-family IPC through the dashboard REST API instead of reading the local `~/.hermes` (issue #51).

All of it lives in [[src/main/remote-settings.ts]]; the IPC branches in [[src/main/ipc/register.ts#registerIpcHandlers]] pick them for `conn.mode === "remote"`. Coverage: memory (MEMORY.md/USER.md via `/api/fs/read-text` + `/api/fs/write-text`), soul (`/api/profiles/{n}/soul` with an fs fallback), toolsets (`GET/PUT /api/tools/toolsets*`), logs (`/api/logs`), gateway status/lifecycle (`/api/status`, `/api/gateway/start|stop`), config (`/api/fs` surgical YAML splice mirroring the SSH path), env (`.env` parse read + `PUT /api/env` write), profiles (`GET/POST /api/profiles` — list AND create — with the LOCAL active-profile override; `set-active-profile` keeps the local selection and starts the profile gateway on the server), doctor/dump (`POST /api/ops/*` spawned actions), and memory providers (`GET /api/memory`). The Memory, Profiles, Gateway and Providers screens render in remote-only mode with this coverage. Gateway reads the API-server-key presence from the server `.env` (secret never shipped), generates+restarts remotely, and the messaging-platform/status controls target the server gateway. Providers shows the server's active model, env, custom endpoints (`GET /api/providers/custom-endpoints`) and credential pool (`GET/POST/DELETE /api/credentials/pool` — a redacted view; the set-credential-pool remote branch supports the removal flow by dropping entries missing from the new list, it cannot round-trip secrets); the Hermes One account card is hidden in remote mode (it manages the local machine; ensure-key is local-only in the main process). Kanban and Discover stay behind the RemoteNotice: the dashboard exposes no kanban router at all, and Discover's registry install path writes the local filesystem. The server's `HERMES_HOME` is resolved once via [[src/main/remote-metadata.ts#remoteGetHermesHome]] and cached (TTL 5 minutes), invalidated by [[src/main/remote-settings.ts#remoteInvalidateSettingsCaches]] on every connection switch.

### Connection-explicit dashboard transport

Dashboard startup and WebSocket refresh resolve the chat's stable connection ID instead of consulting whichever record is currently selected.

[[src/main/dashboard.ts#startDashboard]] and [[src/main/dashboard.ts#freshDashboardWebSocketUrl]] allow direct-Remote clients to remain independent. An inactive SSH record returns a bounded unavailable status rather than stealing the one shared tunnel described by [[main-process#SSH dashboard transport]].

Editing a record invalidates the matching renderer transport even when its mode and identity are unchanged, preventing an open WebSocket from continuing to use the previous endpoint or authentication state.

### Connection-explicit legacy transport

Legacy API sends retain one resolved connection configuration for URL, authentication, capability probing, fallbacks, event streaming, and cancellation.

[[src/main/hermes.ts#sendMessage]] accepts the main-process-owned snapshot selected by `send-message` IPC. Concurrent direct-Remote runs therefore cannot inherit a later UI selection or each other's credentials; inactive SSH remains blocked before tunnel preparation.

### Desktop metadata

[[src/main/session-location-store.ts#recordSessionLocation]] stores validated tuples in the global desktop directory, independent of the currently selected profile database, and uses atomic writes without credentials.

Unreadable or newer session-location documents remain untouched and reject writes, preventing best-effort metadata recording from replacing recoverable history with an empty store.

### Composite identity persistence

Persisted metadata retains separate records when two connections or profiles produce the same Agent session ID, survives module reloads, deduplicates exact tuples, and rejects incomplete identities.

### Run identity isolation

Live-run lookup requires connection, profile, and session ID to match, so a colliding session ID cannot activate a run belonging to another machine or profile.

## Test specifications

Focused checks cover independent status classification and the credential boundary for the new registry snapshot.

### Isolated status probes

Local, Remote, and SSH records report separate health and authentication outcomes, retain connection-specific capability evidence, and never return stored API keys.

### Connection-explicit dashboard routing

Direct-Remote dashboard status and WebSocket lookup use the chat's saved connection ID instead of the currently selected record, while inactive SSH records cannot retarget the singleton tunnel.

### Concurrent legacy Remote routes

Simultaneous legacy sends to distinct direct-Remote records retain separate endpoint URLs and bearer credentials throughout capability probing and chat submission.

### Connection-explicit transcript routing

Transcript reconciliation forwards the chat's saved connection and profile rather than reading from whichever connection or profile is currently selected.

### Connection-explicit session browsing

Sidebar and Sessions-screen list, sync, search, rename, single-delete, and bulk-delete requests retain the selected connection and profile, including Local cache/database routing and SSH pagination.

#### Routes renderer operations

The Sessions-screen integration test verifies that sync, search, and rename calls carry the selected connection ID and profile through the preload boundary.

#### Scopes Remote list requests

Remote profile-list requests send the selected profile to the Agent dashboard instead of silently requesting the cross-profile `all` aggregate.

#### Keeps Local profile caches isolated

Local cache synchronization reads the selected profile database, writes that profile's desktop cache, and cannot leak the default profile's sessions into the result.

#### Derives workspace folder from cwd when no binding exists

Sessions created outside the desktop have no context-folder row, so sync derives the grouping folder from the session's workspace columns.

Details: `git_repo_root` when present, else `cwd` — mirroring hermes-agent's `_workspace_group_key` so a checkout never splits across subdirectories.

#### Explicit binding beats derived folder

A user-chosen Move-to-project binding overrides whatever the session's cwd would derive, so manual organization always wins.

#### Explicit unlink sentinel beats derived folder

Move to project → Remove stores an empty-string sentinel row; a later sync must not resurrect the cwd-derived grouping the user removed, while sessions with no row at all keep deriving from their workspace columns.

#### Remote rows carry workspace columns

The dashboard `/api/profiles/sessions` rows include `cwd` and `git_repo_root`; the Remote cached-session mapping derives the grouping folder from them so Remote sessions group like Local ones.

Detail: repo root is preferred over a deeper cwd (a checkout must not split), mirroring the Local derivation.

#### Agent-home cwd stays in flat Chats

A session whose derived folder is a never-a-workspace dir (the agent user's home, its parent, `/`, `/home`, `/Users`, or HERMES_HOME itself) must not clump into a pseudo-project group.

Detail: the derived folder is nulled instead, so the session falls back to the flat Chats list — mirroring the agent core's `_is_session_cwd_junk` policy for its own tree. Equality only: descendants of HERMES_HOME (`~/.hermes/workspace/...`) remain groupable, and folders owned by a real project always win.

#### Remote agent-home cwd falls to Chats

Over Remote/SSH-dashboard connections the agent home is not known a priori; it is resolved from the dashboard's `/api/profiles` (each profile's `path` pins HERMES_HOME), with a `/.hermes`-path-shape fallback inferred from the session rows themselves.

Detail: the resolution is cached per base URL for five minutes; any failure leaves the filter inert rather than dropping sessions.

#### Remote project names map folder paths to labels

Project groups show the user-defined project name, not the folder slug.

Detail: Local reads `projects.db` directly; Remote/SSH read the dashboard `/api/profiles/projects/tree`, mapping the project's own path and its repo folder paths to the project `label`. A failed probe leaves the slug fallback intact.

#### Manual Move-to-project survives a Remote sync

Remote/SSH session lists merge the desktop's local binding store after fetching.

Detail: an explicit binding overrides the derived folder, an empty sentinel unlinks, absent rows keep the derived folder — so Move to project over SSH no longer silently reverts.

#### Move-to-project re-homes the session workspace on the agent

Move to project also calls the gateway RPC `session.workspace.move` over the dashboard WebSocket, so the chat's working directory follows the move, not just the sidebar grouping.

Detail: the RPC rewrites the session's `cwd`/`git_branch`/`git_repo_root` in the agent's own state.db (local agent included). An open chat tab listens for the folder-changed event and adopts the new folder for subsequent sends.

### Non-destructive registry recovery

Malformed, duplicate-identity, and newer-version registries are rejected without changing `desktop.json`, so recovery cannot erase credentials or unrelated preferences.

### Non-destructive session metadata recovery

Malformed and newer-version session-location stores reject new records without changing the existing file, preserving metadata for repair or a compatible desktop.
