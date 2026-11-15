# Changelog

All notable changes to claude-honcho will be documented in this file.

## [0.4.0-outpoints.1] - 2026-11-15

Upstream 0.4.0 (`6947c56`, npm `latest`) with upstream #169 and #170. Upstream's own changes are listed under [Unreleased] below, where upstream keeps them until it adds a 0.4.0 heading. 0.4.0 is a breaking redesign: each chat is its own Honcho session, nothing is injected per prompt, settings live only in `hosts.claude_code`, and `/honcho` opens a pane.

### Changed

- The repo-local `.honcho/config.json` overlay is ported to 0.4.0 (plastic-labs/claude-honcho#44; see its entry under [Unreleased]). Existing repo-local files keep their behavior: `sessionStrategy: "per-repo"` still gives each git repository under the project one shared session, `"per-directory"` one session for the project root, and `sessionName` pins one. A shared session joins only the scopes it is missing, so a new chat never queues a backfill of its history.
- Repo-local `enabled: false` and `saveMessages: false` still keep a project out of Honcho, live and on import. Upstream 0.4.0 removed both settings; the fork honors them in repo-local files only.
- Session names are used exactly as written. `sessionPeerPrefix` no longer adds the peer name, so to keep using a session such as `alice-notes`, set `"sessionName": "alice-notes"`.
- Fork releases must use an `-outpoints.N` version. Upstream's `release-branch.yml` mirrors any stable `honcho-v*` release from npm, so a fork tag naming an upstream version would replace the fork's bundle on `release/honcho`.

### Removed

- `sessionStrategy` and the `sessions` map in `~/.honcho/config.json` no longer name sessions, along with upstream's other global session settings. Set the strategy in a project's `.honcho/config.json` instead.
- The 0.3.x context-cache scoping, MCP last-active-directory pinning and per-destination import ledger. The mechanisms they patched are gone upstream: there is no context cache, the MCP server reads its launch directory, and an import routes each whole transcript.

## [Unreleased]

### Added

- `/honcho setup` signs in to Honcho cloud with your browser, or takes an API key, then asks what Honcho should call you. A browser sign-in refreshes its own token.
- Each new session joins two Honcho scopes, named after its git repository and the machine's hostname. `chat` takes `scope` to answer only from one scope's sessions, or `workspace: true` to ask across the whole workspace.
- A repository's `.honcho/config.json` overrides `~/.honcho/config.json` for everything under it (the nearest file wins): its own workspace, peers, server or key, with everything it doesn't set taken from the global config. The plugin never writes the file, and `set_config` refuses a field it sets. `sessionName` or `sessionStrategy` (`per-repo`, `per-directory`) put the project's chats into one shared session, the repo scope is the project root's (`splitSubmodules` gives nested repositories their own), and `saveMessages: false` or `enabled: false` keeps a project out of Honcho. `/honcho import` sends each transcript where its project's config says.

### Changed

- Config is read and written through `@honcho-ai/harness-plugin-core` 0.2.0 (config schema version 2). The plugin reads only `hosts.claude_code`; top-level `apiKey`, `peerName`, `workspace` and `baseUrl` are no longer read. If your file still has them, the plugin copies them (and old key names like `endpoint`) into `hosts.claude_code` at session start and says so once. It leaves the top level and other plugins' blocks alone. `HONCHO_BASE_URL` replaces `HONCHO_ENDPOINT` (`local` meant `http://localhost:8000`) and `HONCHO_AI_PEER` replaces `HONCHO_CLAUDE_PEER` / `HONCHO_CURSOR_PEER`; as before, the old names still work in a setup configured only through environment variables, with no key or sign-in in the config file. `HONCHO_WORKSPACE` / `HONCHO_AI_PEER` now override the file.
- Each Claude Code chat is its own Honcho session, named after the Claude Code session id: `/clear` and a new chat start a new one, resume continues it. This replaces per-directory sessions; `sessionStrategy`, `sessionPeerPrefix` and `sessions` are removed.
- Nothing is injected per prompt. Session start injects the memory directives and your peer card, and Claude recalls the rest by calling `chat`.
- `/honcho` (Claude Code 2.1.287 or later) replaces the `/honcho:status`, `/honcho:config`, `/honcho:import` and `/honcho:setup` skills and the statusline script, and opens a pane with the session link, dream history and peer card.
- `search` covers all sessions by default; pass `scope: "session"` for this chat only.
- `/honcho import` names sessions by Claude Code session id, like the live hooks, and skips chats the plugin already saved as they happened, including the one you run it from.
- `logging: false` and `HONCHO_LOGGING=false` from earlier versions still turn off the logs in `~/.honcho/`, and the upgrade keeps the setting in your config.
- `peerName` and the API key from `/honcho setup` are stored in the plugin's own block, `hosts.claude_code`, not at the top of `~/.honcho/config.json`. With no `peerName` of its own, the plugin uses the top-level one, then one another plugin already uses, then your login name, so plugins sharing a workspace stay one peer.
- The base URL setting is `baseUrl`, the same key every other Honcho plugin reads.
- Short replies ("ok", "yes", "go ahead") are saved and reasoned over like any other message. They were saved with reasoning turned off.

### Fixed

- Subagent hand-backs (`<agent-message …>`) and attribute-bearing `<system-reminder …>` envelopes are no longer saved as user messages or used for recall. Genuine prompts following leading reminders are preserved across live hooks and transcript imports; similar tag names and literal XML remain user content.

### Removed

- Config settings that no longer did anything: `reasoningLevel` (the `chat` tool defaults to `medium`; pass `reasoning_level` per call), `contextRefresh`, `messageUpload` and `statusline`, plus the context cache `contextRefresh` fed.
- Tool-use capture (`saveToolUse`, the PostToolUse hook and `redactPatterns`) and git-event capture (`saveGitEvents`). The plugin saves your messages and Claude's replies, nothing else.
- The opt-in `honcho_remember` tool and its `rememberTool` setting. `chat` is the one recall tool; Claude can call it several times in parallel.
- `globalOverride`. Each plugin now uses the `workspace` in its own block under `hosts`. If your config set `globalOverride: true`, the upgrade copies the top-level `workspace` and `aiPeer` into `hosts.claude_code`, so you stay in the same workspace.
- `saveMessages`, `enabled`, `HONCHO_SAVE_MESSAGES` and `HONCHO_ENABLED`. Every message is saved; to stop, disable the plugin in Claude Code's `/plugin` menu or uninstall it. The upgrade removes the two settings from `hosts.claude_code`.
- `observationMode`. Recall, conclusions and the peer card always read your own view (what was `unified`).
- The `get_briefing`, `get_context` and `get_representation` MCP tools and `/honcho:briefing`. Use `chat`.
- `injection.sessionStart`. Session start always injects the directives and your peer card.
- `endpoint.environment`. Set `baseUrl` instead (`http://localhost:8000` for a local Honcho), the same key every other Honcho plugin reads. Session start moves an existing `endpoint` into `baseUrl`.
- The PreCompact hook. Claude Code writes PreCompact stdout only to its debug log, so the "memory anchor" never reached the model or the compaction summary. SessionStart already re-injects memory after compaction (`source: "compact"`).

## [0.3.4] - 2026-10-21

Covers 0.3.0 through 0.3.4.

### Added

- Every Honcho request carries `X-Honcho-Host` and `X-Honcho-Plugin` headers (via `@honcho-ai/harness-plugin-core`) so server-side telemetry can attribute traffic to the plugin and host harness.

### Changed

- The plugin is distributed as the npm package `@honcho-ai/claude-honcho` and the marketplace installs from it. Releases ship a self-contained bundle that runs under Node, so Bun is no longer a prerequisite for using the plugin — it remains the development toolchain.

### Fixed

- Stop hook no longer drops the turn's final reply when it fires before Claude Code has flushed the assistant entry to the transcript. The payload's `last_assistant_message` fills in.
- Prompts that arrive behind a harness `<system-reminder>` block (the desktop app's worktree notice, background-task status) are no longer treated as harness-injected. The hooks strip the leading reminders, then save the prompt, run recall on it, and use it as the Stop hook's turn boundary.
- Messages relayed from another Claude Code session (`<cross-session-message …>` in the user slot) are treated as harness-injected: they are no longer saved as the user's own message or used as a recall query. Before, the deriver turned another agent's text into conclusions about the user. Supersedes #132, which no longer applies after the filters moved to `src/prompt-filters.ts`.
- `HONCHO_SAVE_MESSAGES=false` now stops message uploads when `~/.honcho/config.json` exists. It was only honored in env-only setups, so installs with a config file kept uploading while `get_config` reported `saveMessages` as shadowed by the env var.

### Removed

- `install-local.sh` / `install-local.ps1`. Develop against a working tree with `claude --plugin-dir plugins/honcho` instead.
- Vendored `node_modules` are no longer committed.

## [0.3.3-outpoints.2] - 2026-10-10

### Fixed

- Stop hook prints only when the upload fails (upstream #153). Claude Code shows an async hook's `systemMessage` to the model on the next turn, so the per-turn "saved N assistant msg(s)" line cost context to report success. Success now goes only to `~/.honcho/activity.log`. A failed upload prints one warning line with the message count, and the error text stays in the log.

## [0.3.3-outpoints.1] - 2026-10-04

### Fixed

- Correct the fork version to reflect its upstream 0.3.3 baseline. The previous `0.3.0-outpoints.1` release already contained upstream 0.3.3 (`fc5cbc4`) and the subsequent main-branch fix (`aab96b9`); this release corrects metadata and documents how to select the version without changing runtime behavior.

## [0.3.0-outpoints.1] - 2026-10-04

### Added

- `sessionStrategy: "per-repo"` maps every working directory to its nearest Git repository root, so subfolders of a repo share one session while worktrees and nested repos (detected via `.git` directories *or* files) each get their own. Outside Git it falls back to `per-directory`, and a repo-local config bounds discovery to the project tree — giving the `splitSubmodules` split without needing that flag.

### Changed

- The workspace-scoped injected-context cache now covers the assistant-context slot only, matching upstream's injection refactor (v0.2.7+), which no longer caches user context at all.

### Fixed

- Backfill uploads now retain each repo's endpoint, credentials, peers, and observation mode, including when `--workspace` overrides the workspace name. Identical session/workspace names on different servers or with different peers remain separate.
- Import completion is recorded per destination, session, and transcript. Retrying a partial failure skips successful destinations; legacy workspace-only records remain valid for imports that used the correct global endpoint and peers. Credentials are never stored in the ledger.
- The fork marketplace installs the self-contained Node bundle from `release/honcho`. The existing release workflow supports fork publication without access to upstream's npm package, and hook commands support installation paths containing spaces.

- Preserve per-repo workspace/session behavior through upstream’s skill-module refactor. Project-launched MCP servers stay with their repo-local workspace instead of following another window’s last-active directory.

- Skill runners ignored repo-local `.honcho/config.json`. Only the hooks and the MCP server registered the overlay, so `/honcho:status` reported the *global* workspace, peer, and session name while the hooks were reading and writing the repo-local ones — the status was simply wrong in any project with its own config. `/honcho:status` now resolves the same config the hooks do, and names the active repo-local file.
- `/honcho:import` (backfill) sent every project's transcripts to a single workspace, ignoring the repo-local config of the projects it was importing. A backfill run walks transcripts from every project on the machine, so each transcript's cwd is now resolved against its own nearest `.honcho/config.json`: projects pinned to their own workspace backfill into that workspace, everything else keeps the global one, and `--workspace` still forces one target for the whole run. The import ledger is tracked per workspace, so a failure in one no longer blocks the others from being marked complete.
- Backfilled session names now match the names live hooks produce. `getSessionName()`'s anchoring rules (`per-repo` git-root resolution, repo-local project-root anchoring, `sessionName` pinning) are extracted into a shared `resolveSessionName()` used by both paths — previously the backfill called the low-level deriver directly, so a `per-repo` project imported from a subdirectory was named after the subdirectory.
- `/honcho:setup` writes the global config, but said nothing when a repo-local config shadows it in the current directory. It now points at the file that overrides it.

## [0.2.11] - 2026-07-31

### Added

- `/honcho:insights` skill — runs a max-reasoning dialectic pass over accumulated memory and turns it into proposed CLAUDE.md edits, output-style rules, and skill ideas. Falls back to a parallel `honcho_remember` fan-out at `high` if the max query times out. Read-only until the user picks what to apply.
- Session briefing (session summary + peer card) — injectable at session start, and loadable on demand via the `get_briefing` MCP tool or `/honcho:briefing` skill.

### Fixed

- Hook timeouts specified in seconds instead of milliseconds.
- `set_config` coerces string booleans.

## [0.2.10] - 2026-07-29

### Changed

- Per-turn injection components report a one-line summary instead of printing their contents. `injection.showContents` lists the components that should still print their full payload (default: none). Display only — what reaches the model is unchanged.

## [0.2.9] - 2026-07-28

### Changed

- Per-turn injection's `context` component split into three independently selectable components: `userContext` (the former `context`), `assistantContext` (the same fetch for the AI peer), and `sessionContext` (recent raw messages from the mapped Honcho session via `session.context()`, budget via `injection.sessionContextTokens`). Stored configs using `context` keep working — it resolves to `userContext`.

## [0.2.8] - 2026-07-27

### Added

- `/honcho:import` skill to backfill past Claude Code sessions into Honcho memory.
- Composable, config-driven memory injection — `injection` config block with per-surface component menus (`sessionStart` / `perTurn`) and retrieval tuning (`searchTopK`, `maxConclusions`, `searchMaxDistance`).
- Memory-usage directives now ship automatically as SessionStart context — no more manual CLAUDE.md paste.
- Optional dialectic summary component for the user-prompt hook.
- `honcho_remember` MCP tool for mid-conversation recall (batched questions, configurable reasoning tier) — opt in via the `rememberTool` config flag; session-start directives nudge proactive use when enabled.

### Fixed

- Machine plumbing (runtime `<<...>>` sentinels, `[Session ended]` markers) is no longer attributed to the user peer.
- Batched message uploads no longer replay already-accepted batches after a partial failure.
- SessionEnd hook does nothing beyond logging and state cleanup, so `/exit` can no longer surface "Hook cancelled".

## [0.2.7] - 2026-07-22

### Added

- `saveToolUse` config flag (`HONCHO_SAVE_TOOL_USE` env var) to opt into uploading tool-use messages.

### Changed

- Messages upload live (user prompts on submit, assistant messages from the stop hook) instead of being queued and flushed at session end.

### Fixed

- Stop hook no longer uploads assistant messages when the turn has no preceding user prompt.

## [0.2.6] - 2026-07-21

### Fixed

- MCP `chat` tool no longer times out on long dialectic queries (~80s at max reasoning). Dialectic calls run on a dedicated no-retry Honcho client under a single 120s deadline covering the whole flow, and the plugin's MCP server config sets a 150s per-tool timeout, so the server's clean timeout error always surfaces before the harness aborts the call.

## [0.2.5] - 2026-06-02

### Added

- Memory statusLine — surfaces what Honcho memory is doing on the Claude Code statusLine. Hooks write a per-window activity-state file (`~/.honcho/state-<session>.json`) and a host-managed renderer (`plugins/honcho/scripts/honcho-statusline.sh`) draws sync status, a clickable session link, and a live activity glyph (loading/compacting/recalling/querying). Installed and registered by `/honcho:setup`; toggle on/off via the `statusline` config key, settable through `/honcho:config`.
- First-prompt tool hint — on the first prompt of a session, nudges the harness to actively call the Honcho MCP tools rather than rely only on passive context injection.
- Per-host `apiKey` field in `hosts.<name>` — takes precedence over root `apiKey`, still overridden by `HONCHO_API_KEY` env var. Lets different integrations authenticate against different Honcho orgs from one config file.
- `get_config` now warns when `HONCHO_API_KEY` is set and overrides the `apiKey` in `config.json`, so the active key is never ambiguous.
- Version-update nag: warns on first prompt when the installed plugin is behind the published version (checks for updates at most once a day; silent on failure).
- `scripts/analyze-usage.py` — analyzes Claude Code Honcho usage from `~/.claude` logs.

### Changed

- Skip `cd` commands when logging Bash tool calls

### Fixed

- Spinner degrades gracefully without a TTY — Claude Code >=2.1.139 runs hooks without a controlling terminal, so `/dev/tty` fails; probe for a real terminal and fall back to a single clean line when none is available.
- `sessionStart` hook now runs async (#43).
- Preserve a host-scoped `apiKey` already on disk when rewriting config — no longer drops `hosts.<host>.apiKey` on save.

## [0.2.4] - 2026-04-01

### Added

- `observationMode: "unified" | "directional"` config flag — per-host with root fallback, default `"unified"`
  - **unified** (default): all agents contribute to the user's self-observation collection (`observer=user, observed=user`); conclusions are portable across agents
  - **directional** (opt-in): each AI maintains its own view of the user (`observer=aiPeer, observed=user`); useful for isolated multi-agent workspaces
  - Resolves the ambiguity from issue #22 — prior code was implicitly directional with no user control; peer-call routing in all hooks and MCP tools now branches on this flag
- `get_context` MCP tool — retrieves the full context object (representation + peer card), scoped by observation mode
- `get_representation` MCP tool — lightweight representation string fetch, scoped by observation mode
- `list_conclusions` MCP tool — paginated list of saved conclusions with `id`, `content`, and `createdAt`
- `delete_conclusion` MCP tool — remove a conclusion by ID
- `schedule_dream` MCP tool — trigger background memory consolidation; Honcho merges redundant conclusions and derives higher-level insights
- `search` tool `scope` parameter — `"session"` (default) or `"workspace"` to search across all sessions
- `observationMode` settable via `set_config` and visible in `get_config` output and status card

### Fixed

- `aiPeer` peer config: `observeMe` corrected to `false` — agent peers don't need self-representation; eliminates wasted background reasoning compute
- `addPeers` session config: `aiPeer.observeOthers` is now `false` in unified mode and `true` in directional mode (was unconditionally `true`)

### Changed

- Bump `@honcho-ai/sdk` floor to `^2.1.0` (adds pagination, `getMessage`, `createdAt`/`isActive` on peers/sessions, strict validation)
- Bump `@modelcontextprotocol/sdk` floor to `^1.26.0`

## [0.2.3] - 2026-03-25

### Fixed

- Adding peers to session with config
- Windows compatibility for TTY, setup, and install
- Per-host config ownership, `saveRootField`, SDK client options
- Resilient hook lifecycle: phased session-end, cache-first user-prompt

## [0.2.2] - 2026-03-03

### Fixed

- Fix `chat-instance` session strategy ignoring `sessionPeerPrefix` setting — sessions now correctly prefix with peer name when enabled

## [0.2.1] - 2026-03-02

### Added

- Global `~/.honcho/config.json` with per-host config blocks (Claude Code, Cursor, Obsidian)
- Host auto-detection via environment signals (`HONCHO_HOST`, `CURSOR_PROJECT_DIR`)
- Linked workspaces for cross-host context sharing at runtime
- `/honcho:config` skill with `get_config` and `set_config` MCP tools
- `/honcho:setup` skill for first-time API key validation and config creation
- Multiple session strategies: `per-directory`, `git-branch`, `chat-instance`
- `globalOverride` flag to apply flat config fields across all hosts
- `sessionPeerPrefix` option to prefix session names with peer name

### Fixed

- Stale cache fallback with timeout for context fetch
- Clear stale session overrides when prefix/strategy/peerName changes
- Message sync bugs: dedup uploads, scope instance IDs per-cwd, add createdAt
- Chat-instance strategy ignores stale session overrides
- Respect `HONCHO_WORKSPACE` env var during legacy config migration
- Various config menu UX improvements (single-select link/unlink, granular host toggles)

### Changed

- Extracted `initHook()` for shared hook entry points
- Unified aiPeer defaults across hosts
- Renamed host identifier from `claude-code` to `claude_code`
- Skills synced to marketplace directory where plugin loader reads them

## [0.2.0] - 2026-02-10

### Added

- Visual logging with pixel art banner
- Configurable file logging to `~/.honcho/` (on by default, togglable)
- Session name prefixing with `peerName` (configurable, default on)
- Installation instructions for adding to Claude Code

### Changed

- Removed legacy SDK format support — all code uses Honcho SDK v2.0.0 natively
- Pinned `@honcho-ai/sdk` to `~2.0.0`
- Updated terminology: "facts" renamed to "conclusions" throughout

## [0.1.2] - 2026-02-05

### Added

- Message chunking for large payloads
- Interview skill (`/honcho:interview`) for capturing user preferences
- Plugin validation on install
- Bundled `node_modules` for marketplace distribution

### Fixed

- Full dependencies declared in package.json for plugin portability
- Banner display on session start

## [0.1.1] - 2026-01-30

### Added

- `honcho enable` / `honcho disable` commands
- Developer plugin (`honcho-dev`) with SDK integration and migration skills
- Pure plugin structure for Claude Code marketplace

### Changed

- Renamed from `honcho-claudis` to `claude-honcho`
- Updated to `@honcho-ai/sdk` v2.0.0
- Removed old handoff and setup skills
- Removed hard dependency on Bun for broader portability

## [0.1.0] - 2026-01-05

### Added

- Initial release as `honcho-claudis`
- Persistent memory for Claude Code sessions using Honcho
- Session-start hook with wavy loading animation
- User-prompt-submit hook with dialectic reasoning context
- Assistant-response-stop hook for real-time response capture
- Pre-compact hook for session state preservation
- Cost optimization with configurable context refresh thresholds
- Endpoint switching between SaaS and local Honcho instances
- Git state tracking with inferred feature context
- Activity logging with tail command
- Self-improvement from AI feedback analysis
- Pixel art and colorful wave spinner UI
- Session isolation per working directory
