# Chat Input

The chat composer keeps message entry and its supporting controls inside one accessible, visually unified surface.

## Animated composer border

The composer uses a theme-aware decorative beam without changing its keyboard, attachment, voice, or submission behavior.

[[src/renderer/src/screens/Chat/ChatInput.tsx#ChatInput]] places `border-beam` beside `.chat-input-wrapper` in a shared shell, using the contained `pulse-inner` size, monochrome palette, and `0.7` strength. Theme colors follow the resolved Hermes theme appearance rather than the operating-system preference.

The beam is an absolutely positioned, non-interactive decoration whose generated CSS disables animation for `prefers-reduced-motion`. Its internal clipping cannot clip toolbar popovers because the interactive composer is a sibling; the shared shell carries focus styling and keeps overflow visible.

### Uses the requested beam preset

The ChatInput integration test verifies the requested preset, strength, and theme while ensuring the beam is decorative and not an overflow-clipping ancestor of the textarea or toolbar.

[[src/renderer/src/screens/Chat/ChatInput.test.tsx]] protects the component boundary and configuration without coupling tests to the dependency's generated animation CSS.

## Attachment capacity

Only successfully added files count toward the per-message attachment limit; rejected files leave room for later valid files in the same selection.

[[src/renderer/src/screens/Chat/attachmentUtils.ts#processFiles]] preserves input order and reports each rejection separately. Once successful attachments fill the remaining capacity, later files are rejected without reading or staging them. The same accounting applies to Local file paths/staging and non-local document bytes, without changing image compression or transport.

### Rejected files do not consume slots

Oversized files, failed reads and failed Local staging leave the slot available for the next valid file. Mixed Local and non-local batches preserve successful order within the remaining limit.

A full message does not read or stage more files.

## Queued message send-now

Queued messages have stable IDs; Send now waits for the interrupted turn to become idle before submitting the selected message, without reordering the rest.

[[src/renderer/src/screens/Chat/hooks/useChatQueue.ts#useChatQueue]] serializes Stop, Send now, and automatic draining. The selected item stays visible, with attachments intact, until submission is accepted; repeated clicks share the pending operation. [[src/renderer/src/screens/Chat/QueuedMessages.tsx#QueuedMessages]] disables mutations while the operation is pending and shows queue errors inline. Normal FIFO draining also probes real idle on Dashboard transport, rather than trusting loading=false after a terminal frame. Releasing the submission lock rechecks the guarded drain in the same chat scope, so a selected turn that completes before its submit ACK cannot strand the remaining queue.

A rejected stop or submission pauses automatic draining and preserves all items. Explicit Send now retries a rejected submission. A lost submit ACK is uncertain, not rejected: that item cannot be resent automatically or with its Send now button. Check the session/history, remove the uncertain item, and explicitly send any remaining item to resume. Neither a retry nor exactly-once delivery can be guaranteed without backend idempotency. Legacy transport has no authoritative idle barrier, so Send now refuses to race a still-running legacy turn. After its IPC completion reports idle, explicit Send now can retry without another interruption; ordinary legacy FIFO draining retains its completion-based behavior.

The queue captures connection/profile scope and cancels a pending selection on context change or Clear. Tests in [[src/renderer/src/screens/Chat/hooks/useChatQueue.test.tsx]] cover deferred idle and ACKs, repeated clicks, B/C/D order, attachment retention, rejected/uncertain sends, FIFO draining, and context/reset cancellation. See [[chat-commands#Stop controls]] for the transport barrier and [[dashboard-detach#Run-state seeding from session.resume (issue #109)]] for restoration.
