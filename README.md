<img width="100%" alt="HERMES DESKTOP" src="assets/header.webp" />

> [!NOTE]
> **This is a personal fork** of [fathah/hermes-desktop](https://github.com/fathah/hermes-desktop) maintained by [@nikitinvasily](https://github.com/nikitinvasily). It tracks `upstream/main` and carries the fork-specific fixes and features listed below.

## Fork differences vs upstream

Changes in this fork that are **not** in upstream.

### Features

- **Project management in the sidebar** — create, rename, and delete projects without leaving the app. Over SSH, a directory browser walks the agent host's filesystem. Projects show the names you gave them in the agent ("Infrastructure" instead of `infrastructure`), and empty projects stay visible.
- **Project picker for the working folder** — the context-folder chip in the chat input lists your projects instead of raw recent paths; picking one sets its primary directory as the session's working folder.
- **Session archiving** — hide a chat from the sidebar without deleting it, and restore or delete archived chats from a modal. The archive browser is scoped per project (or shows unbound chats from the Chats header). Uses the agent's own `archived` flag, so the CLI and dashboard see the same state.
- **Session state bullets** — the dot next to each chat tells you at a glance whether the agent is working, the chat has unread output, or a command is waiting for your approval. Works on local, remote, and SSH connections.
- **Subagents panel in the chat** — when the agent delegated work in a chat, a small floating panel appears top-right over the conversation listing every subagent run (its goal, a spinner while it works). Click a subagent to read its full transcript. The panel only exists in chats that actually used subagents. It also shows the chat's live TODO list (what the agent is working through, with progress counter) while there are open items.
- **Per-chat approval toggle** — a shield button in the chat toolbar disables dangerous-command approvals for the current chat only; the global approval setting is never touched. The choice is remembered per chat, so it survives an app restart.
- **Approval cards show their outcome** — after you approve or deny a command, the card turns green or red accordingly (muted grey when answered elsewhere), and scanner boilerplate like "Security scan — [HIGH] …" is stripped so only the command (and a real description, when there is one) remains. The fallback Approve/Deny buttons under a text-only approval prompt stay below the message instead of floating beside it, and no longer appear under ordinary messages that merely mention the commands.
- **Discover and Skills over remote connections** — the marketplace works in remote mode: "Installed" markers reflect the server's state, and installs (skills, workflows, MCP servers, agents) land on the server.
- **Data screens follow connection switches** — Discover, Kanban, and Schedules reload their data automatically when you switch between local and remote agents, instead of keeping the previous source's contents until a manual refresh.
- **Kanban board over remote connections** — the board screen works in remote (HTTP) mode too: boards, cards, drag-drop moves, comments, and dispatch go through the agent dashboard's kanban API. Older agents without that API show an "update the agent" hint instead of a dead screen.
- **Status-bar connection switcher** — switch between saved connections right from the status bar; each switch also activates a run on the target connection.
- **Connection switch returns you to your chat** — switching connections reopens the conversation you left open there, and a first new chat starts in the same project when one matches.
- **New-chat buttons in the sidebar** — quick actions on project headings and on the Chats header.
- **Resizable sidebar** — drag the right edge (200–420 px, double-click resets), remembered across restarts.
- **Readable conversation column on wide screens** — messages and the input live in a centered column of capped width instead of stretching line length across the whole monitor.
- **Stable, predictable sidebar order** — projects sort alphabetically, chats sort by last activity, the active chat keeps its highlight, and the title bar shows a single tab for the current chat instead of one chip per conversation.
- **Office tab hidden** — the 3D "Office" tab is removed from the sidebar; the feature stays in the code and can be re-enabled.
- **Voice messages and audio players in the chat** — spoken replies (TTS) and voice messages from messaging platforms render as playable audio rows (voice-message style when the agent sent it as speech) instead of a raw `[[audio_as_voice]]` marker or a download chip; any audio file the agent delivers gets an inline player. Photos you send via Telegram and similar platforms are displayed in the chat instead of only being described in text, and voice notes that could not be transcribed are playable too. The agent's auto-generated description of an incoming photo folds into a compact collapsible card under the image. Works on local and remote connections.
- **Documents you send render as file cards** — a document attached to a message (PDF, JSON, spreadsheet…) shows as a compact card with its original filename that saves the file on click, instead of a paragraph of raw system text. When the file was cleaned up on the agent side, the card says so explicitly instead of failing silently.

### Fixes

- **List markers survive in your own messages** — lines starting with `-` or `1.` in what you send keep their bullets and numbers in the chat bubble instead of collapsing into plain text.

- **`/moa` works on remote connections** — running a prompt through the Mixture-of-Agents preset no longer fails with a "did not switch to <model>" error: the chat used to force its configured model back while the one-shot MoA turn was still in flight, killing it. The turn now runs and the configured model is restored afterwards, as designed.

- **Remote sidebars no longer show duplicate projects** — over a remote/SSH connection the agent's project tree also contains auto-generated folder groups (e.g. the whole workspace or /tmp); these used to leak into the sidebar's Projects section and the "Move to project" menu as look-alike duplicates of real projects, especially while the connection's session token was stale. Only real projects are listed now, and a chat can never appear in two project groups at once.

- **Switching the model no longer kills running subagents** — changing the model (or an API key, or a messaging setting) used to restart the agent backend immediately, silently killing every running session and in-flight subagent; the restart now waits until the work finishes (a system notification says the switch was queued). Subagent runs that did die with an old backend restart show as finished in the Subagents panel instead of spinning forever.
- **Sidebar hover highlight is visible** — hovering (or focusing) a chat row, nav item, or project heading in the sidebar now shows a clear highlight against the sidebar background in every theme; the active chat keeps the same visible highlight.
- **Model switches show as timeline events, not fake messages** — when the active model changes mid-conversation (a `/model` switch or a config change picked up on the next turn), the chat shows a quiet "model changed" line instead of a raw `[System: The active model for this chat has changed to …]` message that looked like something you sent. Interrupted-turn resumes and background-agent completions get the same quiet treatment.
- **Background-process results show as compact notices** — when a background command finishes, its result appears as a small centered note (process, exit status, expandable command/output) instead of a wall of `[IMPORTANT: Background process …]` text styled as your own message.
- **Machine envelopes render as notices, not bubbles** — internal agent traffic injected into the transcript (background subagent completions with their goal/status and collapsed job output, system continuation notes, silent turns, and any future bracketed machine envelope) appears as a compact centered notice. A message you sent mid-turn from another device (a Telegram steer) shows as your normal chat bubble with a small "via telegram dm" caption instead of the raw `[OUT-OF-BAND …]` wrapper text.
- **A new chat shows up in the sidebar right away** — the chat appears in the list the moment you send its first message, while the agent is still working on the reply, instead of only after the turn finishes.
- **Subagent sessions stay out of the sidebar** — when the agent spawns subagents, their internal sessions no longer clutter the chat list, project groups, or the archive (local and SSH connections; the remote dashboard already filtered them).
- **Channel icons in the chat list** — a session that came from another channel (Telegram, the scheduler, the API, or the web) shows that channel's small icon in place of the plain dot next to its title, and hovering the row tells you where it came from ("via Telegram"). Status markers (approval, running, unread, pinned) always take precedence.
- **Damaged chat streams no longer corrupt messages** — when the agent core delivers a lossy stream (lost chunks, stray characters), the text is reconciled against the final result instead of gluing garbage into the bubble.
- **Schedules work over remote connections** — over SSH tunnels and OAuth-gated remote dashboards the Schedules tab used to render empty (every operation silently failed); it now uses the dashboard API with correct auth and refreshes when you switch connections.
- **File viewer works over remote connections** — the working-folder panel on the right of the chat lists the server's directories and opens files (text with syntax highlighting, image previews) from the server instead of silently reading the local disk; binary files are detected server-side.
- **Remote Settings manage the server, not the Mac** — while a remote connection is active, Settings screens (Memory, Soul, Toolsets, Logs, Profiles, Config, gateway start/stop) read and write the server through the dashboard API instead of silently mutating local `~/.hermes`. Works against password/OAuth-protected dashboards, and remote is dashboard-only: no silent fallback to the legacy transport when the dashboard is unreachable.
- **Project grouping works everywhere** — chats group by project on every connection type, including sessions started outside the desktop (Telegram, cron, gateway). Folders without a project record no longer appear as pseudo-groups, and agent-home sessions land in the flat Chats list instead of a fake project. Group counts are stable and complete, not just whatever fits in the recent-sessions window.
- **"Move to project" is reliable** — works over SSH/remote, re-homes the session's workspace on the agent itself (the chat's working directory follows the move), leaves no ghost in the old group, and the picker lists all projects.
- **Switching the model over SSH has no side effects** — the pick writes only the model block of the remote config; it used to silently force streaming on and disable smart model routing.
- **Switching connections no longer freezes a running chat** — a mid-flight turn survives connection switches and dashboard drops: the spinner stops with a note that the agent keeps running server-side, and switching back resumes the session and shows the missed tail, including the final answer.
- **A running turn keeps its spinner and Stop button** — reopening a chat (or reconnecting after a network blip) while the agent is still working restores the live run state instead of showing an idle chat: streaming continues into the open chat, and Stop works again. Related: queued messages gain a "send now" button that interrupts the current run and sends that message immediately.
- **Onboarding never writes to the remote agent** — completing the local Setup screen while an SSH connection is active no longer rewrites the remote agent's global model.
- **Multi-question clarify prompts render** — each question gets its own interactive answer card; they used to be silently dropped, leaving the chat looking frozen.

The updater publishes to and checks this fork's releases (`nikitinvasily/hermes-desktop`), so a fork install never auto-updates into an upstream build. Upstream merges are pulled regularly; fork commits live in `main` ahead of `upstream/main`.

<br/>
<p align="center">
  <a href="https://x.com/HermesOneApp"><img src="https://img.shields.io/badge/Follow Us-000000?style=for-the-badge&logo=x" alt="Twitter"></a>
  <a href="https://discord.gg/Fqu72h8z"><img src="https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/fathah/hermes-desktop/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License: MIT"></a>
  <a href="https://hermesone.org"><img src="https://img.shields.io/badge/Download-Releases-FF6600?style=for-the-badge" alt="Releases"></a>
<a href="https://github.com/fathah/hermes-desktop/stargazers">
  <img src="https://img.shields.io/github/stars/fathah/hermes-desktop?style=for-the-badge&color=FFD700&label=Stars" alt="Stars">
</a>
  <a href="https://github.com/fathah/hermes-desktop/releases/">
  <img src="https://img.shields.io/github/downloads/fathah/hermes-desktop/total?style=for-the-badge&color=00B496&label=Total%20Downloads" alt="Downloads">
</a>
   <a href="https://bankr.bot/launches/0xfda75f77a22b4f4b783bbbb21915ef64d149bba3">
  <img src="https://img.shields.io/badge/Token-$HD-purple?style=for-the-badge&logo=ethereum" alt="Downloads">
</a>
  
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja-JP.md">日本語</a> ·
  <a href="README.es-LATAM.md">Español (LATAM)</a>
</p>

<p align="center">
  
  
  
 <a href="https://www.star-history.com/fathah/hermes-desktop">
  <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/badge?repo=fathah/hermes-desktop&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/badge?repo=fathah/hermes-desktop" />
   <img alt="Star History Rank" src="https://api.star-history.com/badge?repo=fathah/hermes-desktop" />
  </picture>
 </a>
</p>


> **This project is in active development.** Features may change, and some things might break. If you run into a problem or have an idea, [open an issue](https://github.com/fathah/hermes-desktop/issues). Contributions are welcome!

Hermes One is a community maintained native desktop app for installing, configuring, and chatting with [Hermes Agent](https://github.com/NousResearch/hermes-agent) — a self-improving AI assistant with tool use, multi-platform messaging, and a closed learning loop.

Instead of managing the CLI by hand, the app walks through install, provider setup, and day-to-day usage in one place. It uses the official Hermes install script, stores Hermes in `~/.hermes`, and gives you a GUI for chat, sessions, profiles, memory, skills, tools, scheduling, messaging gateways, and more.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/D1D41ZEKFO)

## Sponsors

> [Want to appear here?](mailto:fathah@hermesone.org)

<details open>
<summary>Click to collapse</summary>
<br/>
<table>

<tr>
<td width="180"><a href="ttps://www.atlascloud.ai/?utm_source=github&utm_medium=link&utm_campaign=hermes-desktop"><img src="assets/partners/atlascloud.webp" alt="Atlas Cloud" width=""></a></td>
<td> <a href="https://www.atlascloud.ai/?utm_source=github&utm_medium=link&utm_campaign=hermes-desktop">Atlas Cloud</a> is a full-modal, OpenAI-compatible AI inference platform. Use it in Hermes One by selecting <b>Atlas Cloud</b> as your provider. The base URL is pre-configured automatically. </td>
</tr>

<tr>
<td width="180"><a href="https://www.greptile.com/?utm_source=hermes-desktop"><img src="assets/partners/greptile.webp" alt="Greptile" width=""></a></td>
<td> <a href="https://www.greptile.com/?utm_source=hermes-desktop">Greptile</a> is an AI code reviewer. It reviews and tests pull requests with full context of the codebase. It catches bugs, flags regressions, and leaves inline review comments on every PR automatically. </td>
</tr>

</table>

</details>

## Install

<a href="https://hermesone.org"><img width="380" alt="Download Now" src="previews/download.webp" /></a>

<details>
<summary>Windows</summary>
<br/>

> **Windows users:** The installer is not code-signed. Windows SmartScreen will warn on first launch — click "More info" → "Run anyway".

> **WSL users:** If the installer stalls at `Switching to root user to install dependencies...`, Playwright is waiting for a sudo password that has no TTY to read from. Grant passwordless sudo for the install, then revert when finished:
>
> ```bash
> echo "$USER ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/hermes-install
> # …re-run the installer; once it finishes:
> sudo rm /etc/sudoers.d/hermes-install
> ```
>
> Tracked in [#109](https://github.com/fathah/hermes-desktop/issues/109).

</details>

<details>
<summary>Fedora (RPM)</summary>
<br/>

```bash
sudo dnf install ./hermes-desktop-<version>.rpm
```

> **Fedora users:** The `.rpm` is not GPG-signed. If your system enforces signature checking, append `--nogpgcheck` to the install command. Auto-update is not supported for `.rpm` builds (limitation of `electron-updater`); reinstall the new `.rpm` to update.

</details>

## Preview

<table>
<tr>
<td width="50%" align="center"><b>Chat</b><br/><img width="100%" alt="Chat" src="previews/chat.png" /></td>
<td width="50%" align="center"><b>Profiles</b><br/><img width="100%" alt="Profiles" src="previews/profiles.png" /></td>
</tr>
<tr>
<td width="50%" align="center"><b>Models</b><br/><img width="100%" alt="Models" src="previews/models.png" /></td>
<td width="50%" align="center"><b>Providers</b><br/><img width="100%" alt="Providers" src="previews/providers.png" /></td>
</tr>
<tr>
<td width="50%" align="center"><b>Tools</b><br/><img width="100%" alt="Tools" src="previews/tools.png" /></td>
<td width="50%" align="center"><b>Discover</b><br/><img width="100%" alt="Skills" src="previews/discover.png" /></td>
</tr>
<tr>
<td width="50%" align="center"><b>Schedules</b><br/><img width="100%" alt="Schedules" src="previews/schedules.png" /></td>
<td width="50%" align="center"><b>Gateway</b><br/><img width="100%" alt="Gateway" src="previews/gateway.png" /></td>
</tr>
<tr>
<td width="50%" align="center"><b>Persona</b><br/><img width="100%" alt="Persona" src="previews/persona.png" /></td>
<td width="50%" align="center"><b>Kanban</b><br/><img width="100%" alt="Kanban" src="previews/kanban.png" /></td>
</tr>
<tr>
<td width="50%" align="center"><b>Office</b><br/><img width="100%" alt="Office" src="previews/office.png" /></td>
<td width="50%" align="center"><b>Settings</b><br/><img width="100%" alt="Settings" src="previews/settings.png" /></td>
</tr>
</table>

## Features

- **Guided first-run install** for Hermes Agent with progress tracking and dependency resolution
- **Local or remote backend** — run Hermes locally on `127.0.0.1:8642`, or connect the desktop app to a remote Hermes API server with URL + API key
- **Multi-provider support** — OpenRouter, Anthropic, OpenAI, Google (Gemini), xAI (Grok), Nous Portal, Qwen, MiniMax, Hugging Face, Groq, and local OpenAI-compatible endpoints (LM Studio, Atomic Chat, Ollama, vLLM, llama.cpp)
- **Streaming chat UI** with SSE streaming, tool progress indicators, markdown rendering, and syntax highlighting
- **Token usage tracking** — live prompt/completion token counts and cost display in the chat footer, plus a `/usage` slash command
- **22 slash commands** — `/new`, `/clear`, `/fast`, `/web`, `/image`, `/browse`, `/code`, `/shell`, `/usage`, `/help`, `/tools`, `/skills`, `/model`, `/memory`, `/persona`, `/version`, `/compact`, `/compress`, `/undo`, `/retry`, `/debug`, `/status`, and more
- **Session management** — full-text search (SQLite FTS5), date-grouped history, resume and search across conversations
- **Profile switching** — create, delete, and switch between separate Hermes environments with isolated config
- **14 toolsets** — web, browser, terminal, file, code execution, vision, image gen, TTS, skills, memory, session search, clarify, delegation, MoA, and task planning
- **Memory system** — view/edit memory entries, user profile memory, capacity tracking, and discoverable memory providers (Honcho, Hindsight, Mem0, RetainDB, Supermemory, ByteRover)
- **Persona editor** — edit and reset your agent's SOUL.md personality
- **Saved models** — CRUD management for model configurations across providers
- **Scheduled tasks** — cron job builder (minutes, hourly, daily, weekly, custom cron) with 15 delivery targets
- **16 messaging gateways** — Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Mattermost, Email (IMAP/SMTP), SMS (Twilio/Vonage), iMessage (BlueBubbles), DingTalk, Feishu/Lark, WeCom, WeChat (iLink Bot), Webhooks, Home Assistant
- **Hermes Office (Claw3d)** — visual 3D interface with dev server and adapter management
- **Backup, import & debug dump** — full data backup/restore and system diagnostics from Settings
- **Log viewer** — view gateway and agent logs directly from the Settings screen
- **Auto-updater** — check for and install updates via electron-updater
- **i18n ready** — internationalization framework with English locale covering all screens, ready for community translations
- **Test suite** — SSE parser, IPC handlers, preload API surface, installer utilities, and constants validation with Vitest

## How It Works

On first launch, the app:

1. Asks whether you want to run Hermes **locally** or connect to a **remote** Hermes API server.
2. **Local mode:** checks whether Hermes is already installed in `~/.hermes`; if not, runs the official Hermes installer with dependency resolution (Git, uv, Python 3.11+).
3. **Remote mode:** prompts for the remote API URL and API key, validates the connection, and skips local install.
4. Prompts for an API provider or local model endpoint.
5. Saves provider config and API keys through Hermes config files.
6. Launches the main workspace once setup is complete.

In local mode, chat requests go through `http://127.0.0.1:8642` with SSE streaming. In remote mode, the app talks to your configured remote URL with the same streaming protocol. The desktop app parses the stream in real time, rendering tool progress, markdown content, and token usage as it arrives.

## Screens

| Screen        | Description                                                                           |
| ------------- | ------------------------------------------------------------------------------------- |
| **Chat**      | Streaming conversation UI with slash commands, tool progress, and token tracking      |
| **Sessions**  | Browse, search, and resume past conversations                                         |
| **Agents**    | Create, delete, and switch between Hermes profiles                                    |
| **Skills**    | Browse, install, and manage bundled and installed skills                              |
| **Models**    | Manage saved model configurations per provider                                        |
| **Memory**    | View/edit memory entries, user profile, and configure memory providers                |
| **Soul**      | Edit the active profile's persona (SOUL.md)                                           |
| **Tools**     | Enable or disable individual toolsets                                                 |
| **Schedules** | Create and manage cron jobs with delivery targets                                     |
| **Gateway**   | Configure and control messaging platform integrations                                 |
| **Office**    | Claw3d visual interface setup and management                                          |
| **Settings**  | Provider config, credential pools, backup/import, log viewer, network settings, theme |

## Supported Providers

### Sponsors

| Provider        | Notes                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Atlas Cloud** | OpenAI-compatible gateway — DeepSeek, Qwen, GLM, Kimi, MiniMax and more ([atlascloud.ai](https://www.atlascloud.ai/?utm_source=github&utm_medium=link&utm_campaign=hermes-desktop)) |

### LLM Providers

| Provider            | Notes                                    |
| ------------------- | ---------------------------------------- |
| **OpenRouter**      | 200+ models via single API (recommended) |
| **Anthropic**       | Direct Claude access                     |
| **OpenAI**          | Direct GPT access                        |
| **Google (Gemini)** | Google AI Studio                         |
| **xAI (Grok)**      | Grok models                              |
| **Nous Portal**     | Free tier available                      |
| **Qwen**            | QwenAI models                            |
| **MiniMax**         | Global and China endpoints               |
| **Hugging Face**    | 20+ open models via HF Inference         |
| **Groq**            | Fast inference (voice/STT)               |
| **Local/Custom**    | Any OpenAI-compatible endpoint           |

Local presets are included for LM Studio, Atomic Chat, Ollama, vLLM, and llama.cpp.

### Messaging Platforms

Telegram, Discord, Slack, WhatsApp, Signal, Matrix/Element, Mattermost, Email (IMAP/SMTP), SMS (Twilio & Vonage), iMessage (BlueBubbles), DingTalk, Feishu/Lark, WeCom, WeChat (iLink Bot), Webhooks, and Home Assistant.

### Tool Integrations

Exa Search, Parallel API, Tavily, Firecrawl, FAL.ai (image generation), Honcho, Browserbase, Weights & Biases, and Tinker.

## First-Time Setup

When the app opens for the first time, it will either detect an existing Hermes installation or offer to install it for you.

Supported setup paths in the UI:

- `OpenRouter`
- `Anthropic`
- `OpenAI`
- `Local LLM` via an OpenAI-compatible base URL

Local presets are included for:

- LM Studio
- Atomic Chat
- Ollama
- vLLM
- llama.cpp

Hermes files are managed in:

- `~/.hermes`
- `~/.hermes/.env`
- `~/.hermes/config.yaml`
- `~/.hermes/hermes-agent`
- `~/.hermes/profiles/` — named profile directories
- `~/.hermes/state.db` — session history database
- `~/.hermes/cron/jobs.json` — scheduled tasks

## Secrets provider

By default, API keys live in `~/.hermes/.env` (the **env** provider). No
configuration is needed — this is byte-for-byte the historical behavior, and
nothing changes for you.

If you'd rather not keep keys in a plaintext `.env`, the opt-in **command**
provider resolves them by running a helper command you configure. Resolution
order everywhere is: `process.env` → `.env` → provider → unset.

Per-key helper (the requested key name arrives as `$HERMES_SECRET_KEY`):

```yaml
# ~/.hermes/config.yaml
secrets:
  provider: command
  command: secret-tool lookup hermes "$HERMES_SECRET_KEY"
```

Or a helper that dumps a dotenv blob (e.g. a vault that unseals into tmpfs):

```yaml
secrets:
  provider: command
  command: "cat /run/user/1000/hermes-secrets.env"
```

The helper's stdout may be either a single bare value (per-key helpers) or
`KEY=VALUE` lines (dotenv dumps); both shapes are auto-detected.

### Vault / secret manager integration (no TPM required)

The `command` provider is **vault-agnostic** — it runs whatever helper you
configure and reads its stdout. The helper is the only thing that needs to
talk to your secret store. If you don't have a TPM-sealed keyfile, any of
these work without code changes to Hermes:

- **KeePassXC (password-only DB, no keyfile):** point `secrets.command` at a
  small `kpxc-export.sh` script that does
  `keepassxc-cli ls ~/secrets/hermes.kdbx <<<"$KPXC_PASSWORD"` and dumps
  the relevant group as dotenv. Prompt the user for the master password
  once per session.
- **GnuPG with a passphrase-only key:** `gpg --batch --passphrase-fd 0
--decrypt ~/.keys/api-keys.gpg` works directly as the `command` value.
  Pass the passphrase via a file descriptor or env var, never argv.
- **`pass` (the standard unix password manager):**
  `command: "pass show hermes/$HERMES_SECRET_KEY"` for a per-key helper,
  or a small wrapper script for a dotenv dump.
- **`secret-tool` (libsecret/Gnome Keyring):**
  `command: "secret-tool lookup hermes $HERMES_SECRET_KEY"` (already
  shown above as the canonical per-key example).
- **Bitwarden CLI:** `bw get item "$HERMES_SECRET_KEY" | jq -r .notes`
  (after `bw unlock` in the session).
- **1Password CLI:** `op read "op://vault/$HERMES_SECRET_KEY/credential"`.
- **Plain env file with user-managed permissions:**
  `command: "cat ~/.config/hermes/secrets.env"` with `chmod 600` and
  the file owned by your user. Not as secure as a vault, but better than
  a world-readable `.env`.

The point: **any helper that prints a value (per-key) or a dotenv blob
(list-mode) on stdout will work**, and Hermes imposes a 3-second timeout
and 1 MiB output cap on the helper so a misbehaving one can't wedge the
app. The provider makes no assumptions about TPM, FIDO2, smart cards,
or platform keychains.

Security model:

- The command string is your own configuration — same trust level as `.env`.
  It runs via `/bin/sh -c`, so the command provider is POSIX-only
  (Linux/macOS); Windows stays on the env provider.
- The helper inherits the process environment plus `HERMES_SECRET_KEY`; the
  key name is passed as data, never interpolated into the shell string.
- Hard 3-second timeout (resolution is synchronous on the main process — keep
  helpers fast and non-interactive), 1 MiB output cap, and stderr is discarded.
- Resolved values are never logged or written to disk; failures degrade to
  "key unset", logging only exit code/signal.
- The gateway-spawn broadcast uses a single `list()` call, never a per-key
  helper loop.

Source of truth: [`src/main/secrets/`](src/main/secrets/).

## Notes

- The desktop app depends on the upstream Hermes Agent project for agent behavior and tool execution.
- The built-in installer runs the official Hermes install script with `--skip-setup`, then completes provider configuration in the GUI.
- Local model providers do not require an API key, but the compatible server must already be running.
- Alternative npm registry routes are supported for environments with restricted network access.

## Contributing

Contributions are welcome! Check out the [Contributing Guide](CONTRIBUTING.md) to get started. If you're not sure where to begin, take a look at the [open issues](https://github.com/fathah/hermes-desktop/issues). Found a bug or have a feature request? [File an issue](https://github.com/fathah/hermes-desktop/issues/new).

## Related Project

This repo is not affiliated to **Nous Research**. This is a community maintained project.

For the core agent, docs, and CLI workflows, see the main Hermes Agent repository:

- https://github.com/NousResearch/hermes-agent
