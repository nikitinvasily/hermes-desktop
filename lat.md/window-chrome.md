# Window chrome and conversation navigation

The main window keeps native macOS traffic lights and a sidebar drag handle, without a session-tab strip above the content pane.

On macOS the window is frameless (`titleBarStyle: "hiddenInset"`, traffic lights inset at x/y 16, see [[src/main/app/start.ts#startMainProcess]]). The sidebar owns the main screen's drag area so it cannot cover chat controls. Other platforms keep the OS title bar.

The absolutely positioned `.sidebar-drag-region` uses the sidebar's existing top 12px of clearance, above the traffic lights. Its width follows sidebar resizing and collapse, with an 8px right inset for the resize handle. [[src/renderer/src/App.tsx]] keeps the full-width `.drag-region` only on onboarding screens. No drag overlay or top spacer occupies the main content pane; the Kanban drawer needs no tab-strip clearance.

`.app` fills the window (`height: 100vh`) so the chrome reaches every edge. The sidebar rounds only its **top-left** corner (`border-radius: 16px 0 0 0`); the full-width status strip owns the window's bottom edge and rounds both bottom corners (`0 0 16px 16px`), so the sidebar's bottom-left is square against it. A hairline seam (`.content` `border-inline-start`) separates the content pane from the sidebar.

## Sidebar surfaces and macOS vibrancy

The sidebar and floating Subagents/TODO panel share the opaque `--bg-tertiary` surface. In the default dark theme it is lighter than the conversation and darker than the active chat highlight. The status strip retains macOS vibrancy.

[[src/main/app/start.ts#createWindow]] gives the window `vibrancy: "under-window"` + `visualEffectState: "active"` + a transparent `backgroundColor` on macOS. The material's light/dark **tone follows the app theme**, not the system appearance: [[src/renderer/src/components/ThemeProvider.tsx#ThemeProvider]] pushes the resolved theme's `appearance` to the main process via the `set-native-appearance` IPC ([[src/main/ipc/register.ts#registerIpcHandlers]] → `nativeTheme.themeSource`), passing `"system"` through only for the "System" theme so its `prefers-color-scheme` still tracks the OS. This is the fix for the earlier milky-sidebar bug: `under-window` alone follows the *system* appearance, so a dark theme on a light-mode Mac frosted light; syncing `themeSource` keeps a dark theme's frost dark. `createWindow` seeds `themeSource = "dark"` (the default theme) so the first paint isn't milky before the renderer refines it.

For the material to paint, the renderer leaves surfaces transparent: [[src/renderer/src/App.tsx]] adds `shell-vibrant` to `.app` only on macOS and only on the `main` screen (onboarding stays solid). Under it, `body`/`#root`/`.app` go transparent, the `.status-bar` becomes a translucent `--bg-secondary` tint, and the sidebar stays opaque `--bg-tertiary` while `.content` keeps opaque `--bg-primary`. Because a transparent window is no longer masked to its rounded shape by macOS, `.content` also rounds its own top-right corner (`0 16px 0 0`) — the sidebar owns top-left, the status bar owns the bottom two — so the opaque panes don't show square corners.

## Modal & popover glass is near-opaque (compositing-independent)

Modals and pickers use a `--bg-secondary` tint plus `backdrop-filter: blur(30px) saturate(1.5)`, but the tint is **97% opaque** so legibility never depends on the blur actually painting.

The blur is treated as pure enhancement, not a load-bearing layer. On the transparent vibrancy window above, `backdrop-filter` is unreliable in packaged macOS builds — it silently drops to a no-op even with hardware acceleration on — which left the earlier 85%-opaque panels showing sharp app content bleeding through (the "transparent modal" bug). Raising the tint to 97% in `main.css` makes every shared frosted surface — the settings/profile/models/schedules/gateway/profile-switch modals and the model/reasoning/fast-mode dropdowns — render near-identically for all users regardless of GPU or build type; where the blur *does* paint it adds a faint frost, but its absence is barely perceptible. Keep new glass surfaces at this opacity, not the old 85%, for the same reason.

### Fast-mode icon alignment

The Fast Mode status badge keeps its Zap glyph optically centered without allowing shared popover typography to override the icon's flex alignment.

In `src/renderer/src/assets/main.css`, `.chat-fast-popover-icon` owns flex centering while the description typography selector targets only the popover's direct child `span`. [[tests/chat-fast-popover-css.test.ts]] protects that cascade boundary.

## Bottom status strip

A native system strip pinned full-width beneath the sidebar+content row surfaces live state that was otherwise hidden: gateway/connection, active model, and skill count, plus real keyboard hints.

[[src/renderer/src/screens/Layout/StatusBar.tsx#StatusBar]] self-fetches from `listProfiles` (active profile's `model`, `skillCount`, `gatewayRunning`) and `getConnectionConfig` (`mode`), polling every 4s. Every field is real — an unknown value drops its chip rather than showing a placeholder, and the hints advertise only shortcuts that exist (`/` commands, `⌘,`/`Ctrl,` settings), never a fabricated `⌘K`. [[src/renderer/src/screens/Layout/Layout.tsx]] wraps its `.layout` row in a `.layout-shell` column and renders the strip as the row's sibling; the online/offline dot uses the theme-aware `--success` token.

## Sidebar-only conversation navigation

Conversations have no top tab strip. A 24px inset inside each chat gives its content breathing room; other app screens keep their original top alignment.

The floating Subagents/TODO panel is inset 12px down and left from the conversation's top-right content edge. The horizontal anchor accounts for the transcript's 24px padding and centered 1300px maximum width. Panel width also reserves the extra 12px inset when the files panel narrows the conversation. The panel stays pinned during scrolling. [[src/renderer/src/screens/Chat/ChatMessagesWrap.tsx#ChatMessagesWrap]] observes the scroller's content-box width and publishes its actual scrollbar gutter on that wrapper, so overlay and space-taking scrollbars align equally without modifying transcript block flow.

[[src/renderer/src/screens/Layout/Layout.tsx]] renders the active chat directly in the content pane. Sidebar row selection restores an existing live run or opens a stored session; New Chat and project actions create conversations. Cmd/Ctrl+W, Cmd/Ctrl+1..9 and Cmd/Ctrl+Shift+[/] keep their existing run-management behavior without visible tabs.

[[src/renderer/src/screens/Layout/Layout.test.tsx]] covers scratch/running/resumed and non-chat views, sidebar switching and new chats, mounted background runs, keyboard activation/closing and platform-specific drag targets. [[tests/session-strip-css.test.ts]] guards the absence of reserved top space and the sidebar drag bounds.

## Follow-us modal

A one-time modal prompting the user to follow Hermes on X. Dismissed permanently via localStorage after either button is clicked.

[[src/renderer/src/components/FollowUsModal.tsx]] stores the dismissal flag in `localStorage` under `hermes-follow-x-dismissed`. Both "Follow" (opens `https://x.com/HermesOneApp` via `openExternal`) and "Not Now" write the flag and close the modal. It renders in [[src/renderer/src/screens/Chat/Chat.tsx]] only when `connectionModeLoaded && readiness.ok`, so it appears after setup is complete. The modal reuses the `.models-modal-overlay` / `.models-modal` pattern for consistent styling.
