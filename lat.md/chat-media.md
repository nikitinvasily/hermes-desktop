# Chat Media Rendering

Agent- and platform-delivered media (images, audio, files) are extracted from message text and rendered inline, on local and remote connections alike.

## MEDIA token pipeline

The transcript parser recognizes explicit `MEDIA:<path-or-url>` tokens, markdown images with local/remote destinations, and several inferred bare-path shapes, turning them into ordered text/media segments.

[[src/renderer/src/screens/Chat/mediaUtils.ts#parseMediaTokens]] is the single entry point. Text segments render through AgentMarkdown; media segments render through [[src/renderer/src/components/MediaImage.tsx#MediaSegmentView]], which trusts explicit tokens eagerly and verifies inferred bare-path candidates via `mediaFileExists` before replacing them. Local paths resolve to data URLs through `readMediaFile`, whose main-process side falls back to the remote dashboard (`fs/read-data-url`) — so server-side files render identically in remote sessions.

## Platform delivery markers

Directives the agent emits for messaging platforms (`[[audio_as_voice]]`, `[[as_document]]`) are stripped before display; the voice directive marks the message's audio tokens as voice messages.

`[[audio_as_voice]]` is message-global but only ever applies to audio files, so [[src/renderer/src/screens/Chat/mediaUtils.ts#parseMediaTokens]] flags every audio hit of the same message while leaving image hits untouched. The marker lines themselves never survive into a text segment. Covered by the platform-markers tests in [[src/renderer/src/screens/Chat/mediaUtils.test.ts]].

## Incoming platform photos and voice notes

User messages from messaging platforms (Telegram etc.) carry bracketed hints naming the cached media file; these become rendered media instead of staying as prose.

Incoming photos end with a vision hint (`[… use vision_analyze with image_url: <path> ~]`) — the `~]` suffix defeats the generic inline bare-path matcher, so a dedicated rule extracts the path as a trusted media-token (the gateway just wrote the file). Voice notes arrive as `[The user sent a voice message: <path> (duration: …)]` or the untranscribed variant and extract the same way, flagged as voice messages. Because user bubbles are otherwise verbatim text, [[src/renderer/src/screens/Chat/mediaUtils.ts#hasUserMediaHints]] cheaply gates which user rows run the media pipeline at all ([[src/renderer/src/screens/Chat/MessageRow.tsx#MessageRow]]); hints inside fenced/inline code are ignored.

## Inline audio players

Audio tokens render as playable rows instead of download chips; voice-flagged audio gets the compact voice-message styling with a mic icon.

[[src/renderer/src/components/MediaImage.tsx#AudioPlayer]] resolves the source (data URL directly, local path via `readMediaFile`, covering remote connections), renders a native `<audio controls>` element, and offers download via context menu or an explicit button on the generic (non-voice) variant. Routing lives in [[src/renderer/src/components/MediaImage.tsx#MediaSegmentView]]: image → MediaImage, audio → AudioPlayer, everything else → download chip. Specified by the AudioPlayer tests in [[src/renderer/src/components/MediaImage.audio.test.tsx]].

## Remote media resolution and the OAuth trap

Remote media reads must go through `remoteDashboardRequestJson` (auth-mode aware); gating them on a non-empty `apiKey` silently disables every OAuth connection.

The original `getActiveDashboardMediaConfig` in [[src/main/ipc/register.ts]] rejected remote connections without an API key — which is every OAuth connection, whose auth lives in the cookie partition, not in the key. Symptom: players and images render their shell but always show "Could not load", while the chat WebSocket stays connected (the same cookie works there). Direct-remote reads now use [[src/main/remote-files.ts#remoteReadImageFile]] (`fs/read-data-url`, OAuth routed through the Electron cookie partition); the SSH tunnel+token bridge keeps the old path. Server-side note: files under `/tmp` may live in the dashboard service's PrivateTmp namespace and be invisible to the API even though SSH sees them — media that matters lands under the agent's cache directories.
