# Gateway restart gate

Defers backend (gateway) restarts triggered by config changes while agent work is in flight, so a model switch never kills running sessions or subagents.

## Why

Config-change restarts used to kill in-flight subagent runs silently; the UI spun forever.

`set-model-config` (and credential writes, and messaging-platform updates) historically called `restartGateway` immediately when the relevant config changed. The restart kills the whole gateway process — every live session and every in-flight subagent run dies silently: `state.db` rows keep an empty `ended_at`, the parent never receives a completion, and the UI spins forever (incident 2026-09-19: two of three running subagents died the moment the user switched models).

## Live-work probe

One async probe answers "is agent work in flight right now?" for the profile's gateway.

[[src/main/hermes.ts#probeGatewayLiveWork]] asks the profile's TUI gateway two RPCs with short timeouts: `session.active_list` (a session in `working`/`waiting`/`starting` status means work in flight) and `delegation.status` (process-global, transport-unscoped — the right shape for background subagents whose parent turn already ended). Both probes failing returns `unknown`, and callers fail OPEN (restart as before) so a flaky probe never blocks a restart forever.

## Deferred restart policy

[[src/main/gateway-restart-gate.ts#restartGatewayWhenIdle]]: idle/unknown restarts now, busy defers and polls until the work drains.

A second config change while waiting refreshes only the recorded reason — the newest config is already on disk, one restart applies it. The three call sites (model switch, credential `setEnvValue`, messaging platform update) all live in [[src/main/ipc/register.ts]] and show a macOS notification when a restart is deferred.

## Dead-subagent classification

A never-ended child older than the current gateway generation cannot be alive; it is shown as died.

Liveness lives only in the gateway's in-memory registry, never in `state.db`. [[src/main/sessions.ts#listSubagentSessions]] therefore compares each never-ended child's `started_at` with the current gateway generation's start time ([[src/main/hermes.ts#tuiGatewayStartedAt]], stamped when the TUI gateway client connects). Such rows return `died: true`, which the chat context panel renders as a settled dot with a tooltip instead of an eternal spinner. An unknown generation marks nothing — fail safe for genuinely running children.
