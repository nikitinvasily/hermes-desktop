---
lat:
  require-code-mention: true
---

# Dashboard detach

What happens to a chat's in-flight turn when its dashboard event stream goes away (connection switch, profile switch, socket drop).

## Teardown retires a running turn

Tests for issue #76: a deliberate transport teardown retires a still-running turn instead of leaving the spinner dangling.

A connectionRevision bump, connection or profile change clears activeTurnRef, stops the spinner and appends a local-only marker saying the agent keeps running server-side. Implemented by the retireDetachedTurn path in [[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts#useDashboardChatTransport]].

## Transport revision only bumps on real changes

[[src/renderer/src/screens/Chat/connectionTransport.ts#connectionTransportSignature]] keys the transport-relevant fields (mode, remote URL, SSH target, chat transports), and [[src/renderer/src/screens/Chat/connectionTransport.ts#connectionTransportRevision]] bumps only on a signature change — re-activating a connection no longer tears down its own healthy WebSocket mid-turn.

## Resync on reactivation

The resyncAfterDetach path in [[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts#useDashboardChatTransport]] reconnects, session.resumes (a still-running agent re-attaches its event stream), and reconciles the transcript with state.db so the missed tail and the final answer appear when the chat becomes visible again.

## Run-state seeding from session.resume (issue #109)

The gateway's session.resume response carries a `running` flag that is the authoritative truth about a live turn; the renderer restores its spinner/Stop state from it.

When ensureRuntimeSession resumes a stored session that still runs server-side (re-opened chat, app restart, post-drop resync), it seeds a synthetic activeTurn and sets isLoading — so the Stop button and the spinner come back instead of the chat looking idle while the agent works. After an accidental WebSocket drop retires the turn, the runtime-session binding is cleared and a 1.5s probe re-resumes: if the backend reports the turn still running, the run state is restored; if it finished, the detached marker stands. Related affordance: [[chat-input#Queued message send-now]] lets the user interrupt the current run and flush a queued message immediately.
