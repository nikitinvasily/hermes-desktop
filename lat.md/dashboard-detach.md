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
