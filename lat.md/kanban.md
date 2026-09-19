# Kanban board tab

The Kanban tab ([[src/renderer/src/screens/Kanban/Kanban.tsx]]) is a JIRA-style board for the hermes-agent multi-agent task queue, presented as "JIRA for AI agents": named agent profiles pick up cards, run them, and hand off through the durable `~/.hermes/kanban.db`.

It is a **thin client** with three transports: local exec through [[src/main/kanban.ts]], SSH-tunnelled `sshRunKanban`, and — for plain remote HTTP connections — the dashboard kanban plugin REST adapter ([[src/main/kanban-remote.ts]]). The renderer holds no domain logic; it renders board state and routes actions to the active transport.

## Statuses and columns

The board renders the agent's canonical statuses, kept in sync with the agent's `kanban_db.VALID_STATUSES` and the dashboard plugin's `BOARD_COLUMNS`. Mis-syncing here silently mis-buckets cards into To-do.

The `COLUMNS` constant lists eight always-visible lanes in canonical order — `triage, todo, scheduled, ready, running, blocked, review, done` — each with a fixed status `tone` that drives a colored header dot and lane accent. A ninth `archived` lane is appended only when the "show archived" toggle is on; `STATUS_TONE` maps any status to its tone for surfaces outside the column loop (the detail drawer). A task whose status is none of the rendered columns falls back to the To-do lane.

## Actions

Cards expose status-appropriate actions, each calling a `hermes kanban` verb via the preload bridge. Header actions are dispatch, new task, new board, and the board switcher.

Card actions are specify (triage), mark-done (ready), reclaim (running), unblock (blocked), block (todo/ready), and archive (any).

Drag-drop moves route through `dragAction(from, to)`, which maps a target column to the single `hermes kanban` verb that effects it: `done`→complete, `blocked`→block, `ready`→unblock|reclaim|promote (by source), `scheduled`→schedule, `archived`→archive ([[src/main/kanban.ts#promoteTask]], [[src/main/kanban.ts#scheduleTask]]). The web dashboard can move a card to *any* column because it writes the status field directly in `kanban.db`; the desktop only has CLI verbs, so `todo`, `triage`, and `review` have no verb to set them and are not drop targets. `dragAction` returning a verb is also the drag-validity gate (`isValidDragTransition`).

In-place editing of a live card's title/body/priority is unavailable — the CLI `edit` verb only backfills a result on already-`done` tasks.

## Refresh model

The board stays current without a live event stream, using three refresh triggers instead.

A 6-second poll (`POLL_INTERVAL_MS`) runs while the tab is visible, a `focus` / `visibilitychange` listener refetches whenever the user returns to the app, and every mutation handler calls `loadAll(true)` so a UI action reflects immediately rather than waiting for the next tick.

## Detail drawer

Clicking a card opens a right-docked issue drawer (`kanban-detail-drawer`) fed by `kanbanGetTask` ([[src/main/kanban.ts#getTask]]).

It shows status, assignee, body, latest run summary, result, the read-only comment thread, and the recent event timeline. It is presentation-only; mutations stay on the card actions.

## Remote plugin transport

Direct-remote (HTTP) connections bypass the CLI entirely: every kanban IPC call dispatches into [[src/main/kanban-remote.ts]], a thin adapter over the backend dashboard's kanban plugin (`/api/plugins/kanban/*`, mounted by the agent's `plugins/kanban/dashboard/plugin_api.py`).

All requests go through `remoteDashboardRequestJson` so OAuth connections ride the Electron cookie partition and token connections use `X-Hermes-Session-Token` — the same boundary as every other remote-parity screen. The plugin's JSON shapes differ from the CLI `--json` shapes, so reads map through format adapters (board rows, the `/board` column view flattened to a task list, task detail with links/parents/children); writes map one-to-one: status verbs become `PATCH /tasks/:id` with `{status}` (`done/block/scheduled/ready/…` — the plugin's `_STATUS_HANDLERS` apply the same domain verbs the CLI uses), comments post to `/tasks/:id/comments`, specify/reclaim have dedicated routes, dispatch is `POST /dispatch`. A 404 from a server older than the plugin comes back as `unsupportedMode`, and the renderer's notice becomes an "update the agent" fallback instead of a hard mode block.

## Claw3D HQ virtual board

A read-only "HQ (Claw3D)" board appears in the switcher when SSH tunnel mode can read the remote task-store JSON ([[src/main/kanban.ts#listClaw3dHqTasks]]).

It is a renderer-only mirror — selecting it routes reads to the remote store, hides all mutation affordances, and never calls the backend board-switch RPC.

## Remote plugin transport tests

Unit tests for the remote adapter live in `tests/kanban-remote.test.ts`. They stub `remoteDashboardRequestJson` and assert routing and payload mapping.

### Routes every verb to the plugin API
Each kanban IPC function in remote mode calls the matching plugin endpoint (boards CRUD + switch, /board flattened task list, task detail, create, PATCH status verbs, comments, specify, reclaim, dispatch) with the expected method and body.

### Maps a missing plugin to unsupportedMode
A 404 `RemoteDashboardApiError` returns `unsupportedMode: true` so the renderer shows its fallback notice; non-404 failures stay plain errors.
