# Scheduled jobs

The Schedules screen presents Hermes cron jobs consistently across local files, the remote API, and named SSH profiles.

Cron jobs are per-connection data, so the screen reloads its list when the active connection actually changes ([[src/renderer/src/hooks/useConnectionChangeReload.ts#useConnectionChangeReload]] seeds its baseline with the active connection and refetches on a connectionId/mode/URL signature change — re-activating the same connection does not reload). The same shared hook drives Discover and the Kanban board.

Jobs explicitly marked `completed` keep that terminal state even though Hermes also disables them. Other disabled jobs are normalized as paused by [[src/main/cronjobs.ts#listCronJobs]]. Named-profile SSH lists use [[src/main/cronjobs.ts#parseCronListOutput]] and mark completed jobs disabled too, so active-only lists exclude terminal jobs across transports.

## Remote endpoint flavors

The remote HTTP cron surface has two disjoint endpoint sets: the gateway api_server (`/api/jobs`, `{jobs:[...]}` wrapper, `POST .../run`) and the unified dashboard (`/api/cron/jobs`, bare array, `POST .../trigger`).

Direct remote (HTTP) connections always talk to the unified dashboard through [[src/main/cronjobs.ts#remoteCronJson]], which rides the shared oauth-aware request boundary (`remoteDashboardRequestJson`, resolving auth mode and cookie sessions) so cookie-authenticated dashboards accept cron requests; before that, a bare fetch with the token-only header silently 401'd and the screen rendered empty (issue #84).

The SSH tunnel points at whichever the active chat transport selected, so [[src/main/cronjobs.ts#remoteCronFlavor]] probes `/api/cron/jobs` before each operation and routes accordingly — a probe cache would go stale because the stable local tunnel port hides a dashboard↔gateway target flip behind it.

## Run history

An expanded job shows its newest runs and bounded plain-text output, owned by the selected connection and profile.

[[src/main/cronjobs.ts#listCronRuns]] and [[src/main/cronjobs.ts#getCronRunOutput]] validate a main-issued history target before reading and after deferred replies. This fork binds the target to its connection, profile and authentication revision with an opaque HMAC token; private settings and OAuth cookie changes revoke it. Direct Remote uses the fork's dashboard transport and an explicit default or named profile. Authentication failures never fall back to another transport or local files.

Remote output requires membership in the requested job's newest 100-run window before reading session messages. Hidden display messages are omitted; a full 500-message page is marked partial. Script-preview rows expose only their preview, also marked partial. Local history reads the newest regular files beneath the selected profile's cron output directory, refuses escaping symlinks and traversal, and caps output at 200,000 characters. Directory and opened-file identities are rechecked before releasing output, including swap-and-restore races. These portable pathname checks are not an atomic sandbox against a hostile local process racing every lookup. SSH history is explicitly unsupported; existing SSH cron actions are unchanged.

[[src/renderer/src/screens/Schedules/CronRunHistory.tsx#CronRunHistory]] rejects obsolete replies after job, run, profile, connection or configuration changes and panel close. Refresh reloads both the expanded list and its open output. The Schedules parent keeps the fork's connection-change behavior and isolates state by the selected target.

## Test specifications

These tests protect schedule normalization, scoped history reads and the lifetime of the expanded history view.

### Completed jobs remain completed

A disabled API job whose source state is `completed` is normalized as completed rather than paused, preserving the terminal-state badge and actions in the renderer.

### Completed SSH jobs stay disabled

Named-profile SSH output retains completed states with `enabled: false`, and active-only requests exclude those terminal jobs.

### Local terminal-state normalization

Reading a real local jobs file preserves completed states, keeps paused and legacy-disabled jobs disabled, and filters active-only results without modifying the stored job data.

### Dashboard transport lists jobs through /api/cron/jobs

When the tunnel targets the unified dashboard, listing goes to `/api/cron/jobs` (bare array response) and firing a job posts to `.../trigger`; the legacy `/api/jobs` routes are never requested against a dashboard.

### Legacy routes preserved for the gateway api_server

When the dashboard probe misses (404 — the tunnel targets the gateway api_server), all operations keep using the legacy `/api/jobs` endpoint set unchanged.

### History profile and authentication

Default and named history reads use explicit dashboard profile queries and the selected authenticated transport. OAuth or token failures remain errors, without changing the existing public discovery policy.

### History target authority

Stale queued targets, changed credentials, deferred authentication probes, old-server replies and OAuth account changes cannot read or display history under a newer target.

### History output ownership and limits

Output requires membership in the requested job's history, rejects invalid response shapes, respects projected display messages and marks a full bounded message page as partial.

### Local history bounds

Only the newest bounded page of regular local output files is previewed. Full output reads are capped; traversal, escaping directory symlinks and file symlinks are refused. Invalid limits cannot request the entire archive.

### Open output refresh

Refreshing jobs reloads an already-open run's output, so a completed run cannot keep showing text from its earlier active state.

### History view lifetime

Late list and output replies cannot overwrite a changed connection, profile, configuration or opened run. Closing the panel retires its requests; a refreshed missing run closes its output and real errors remain visible.

### Schedules parent target changes

The actual Layout preserves the Schedules pane on display-label notifications and replaces it on a connection or private settings change, so old job labels and drafts cannot be reused for a new target.
