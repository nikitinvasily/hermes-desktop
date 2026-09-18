# Scheduled jobs

The Schedules screen presents Hermes cron jobs consistently across local files, the remote API, and named SSH profiles.

Jobs explicitly marked `completed` keep that terminal state even though Hermes also disables them. Other disabled jobs are normalized as paused by [[src/main/cronjobs.ts#listCronJobs]]. Named-profile SSH lists use [[src/main/cronjobs.ts#parseCronListOutput]] and mark completed jobs disabled too, so active-only lists exclude terminal jobs across transports.

## Remote endpoint flavors

The remote HTTP cron surface has two disjoint endpoint sets: the gateway api_server (`/api/jobs`, `{jobs:[...]}` wrapper, `POST .../run`) and the unified dashboard (`/api/cron/jobs`, bare array, `POST .../trigger`).

Direct remote (HTTP) connections always talk to the unified dashboard through [[src/main/cronjobs.ts#remoteCronJson]], which rides the shared oauth-aware request boundary (`remoteDashboardRequestJson`, resolving auth mode and cookie sessions) so cookie-authenticated dashboards accept cron requests; before that, a bare fetch with the token-only header silently 401'd and the screen rendered empty (issue #84).

The SSH tunnel points at whichever the active chat transport selected, so [[src/main/cronjobs.ts#remoteCronFlavor]] probes `/api/cron/jobs` before each operation and routes accordingly — a probe cache would go stale because the stable local tunnel port hides a dashboard↔gateway target flip behind it.

## Test specifications

These tests protect state normalization at the boundary between Hermes cron data and the desktop schedule model.

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
