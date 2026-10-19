# Security Model

## Core principles

- **Writes go only to the allowlisted paths below.** The app may read the complete contents of an allowlisted Codex, OpenCode, Cursor or light-harness MCP, rules, or backup file locally when it must parse, compare, preserve, validate, merge, or restore it. Only documented keys, named entries, or the managed rules block are modified; unrelated user-owned values are preserved or cause a safe refusal with zero mutation.
- **Writes are explicit.** Install or Update shows an artifact-level plan (create, update, remove, conflict rows) and writes only after the user presses `y`. Uninstall and rollback show a preview or dry run and ask for confirmation. Library saves write only the selected personal doc (`docs/context/<slug>.md`) or the text below the managed block of an enabled harness's rules file; bundled items are read-only in the Library. Settings are an app preference and autosave. Nothing is written on launch.
- **Target toggles gate Install.** A surface whose target toggle or harness is off is excluded from preview, apply, and status; the backend rejects it even if a stale request names it.
- **No credential use by the app.** The app does not authenticate with, intentionally extract, log, transmit, or expose credential-like values. Allowlisted config files and their backups can contain such values because complete bytes may need to be preserved and restored; that data stays local and is read only for bounded parsing, comparison, merge, and rollback.
- **No remote control.** The app accepts no remote commands, webhooks, or external IPC. The app makes no network requests. No telemetry, no analytics, no cloud service, no AI model.
- **No unrelated credential surfaces.** The app does not inspect `.env` files, private keys, browser profiles, sessions, trust databases, keychains, or personal files outside the surfaces below.

## What the app writes

| Surface | Path | Notes |
|---------|------|-------|
| Workspace root | `~/.config/agent-workspace` (Settings workspace path or `AGENT_WORKSPACE_PATH` override) | Bundled files via Install; Library saves and created docs, personal docs only (`docs/context/*.md`), via atomic, symlink-refusing writes. Scripts in it are never run by the app. |
| Managed state | `<workspace>/.agent-workspace/managed-state.json` | Schema 2, SHA-256 ownership proof. Prior bytes saved as `managed-state.previous.json` in the transaction backup. |
| Rules preferences | `<workspace>/.agent-workspace/rules-preferences.json` | "Leave as is" choices, as non-secret identities. |
| Kept files | `<workspace>/.agent-workspace/kept-files.json` | "Keep mine" choices for skill and agent files: artifact identity, destination and a digest of the bundled file. Written atomically through `safe_filesystem`; no file content. Keeping never writes the skill or agent file; "take bundled" overwrites it only as a backed-up transaction (below). |
| App settings | `settings.json` in the app support dir | Autosaved. A corrupt file is renamed aside and defaults load. Not backed up. |
| OpenCode model override | `opencode-model-selection.json` in the app support dir | Non-secret model preference. Not backed up. |
| Backups | `backups/` in the app support dir (or `AGENT_WORKSPACE_BACKUP_DIR`) | Layout below. |
| OpenCode config | `~/.config/opencode/opencode.json` | Managed-key merge. |
| OpenCode TUI config | `~/.config/opencode/tui.json` | Whole-file managed copy. |
| Playwright MCP config | `~/.config/playwright-mcp/config.json` (or `PLAYWRIGHT_MCP_CONFIG_PATH`) | Rendered from `templates/playwright-mcp.config.json`. |
| OpenCode agents | `~/.config/opencode/agents/` | |
| OpenCode rules | `~/.config/opencode/AGENTS.md` | Managed block merge. |
| Codex config | `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) | Allowlisted keys only; `model` and `model_reasoning_effort` create-only. Target `codex_config`, off by default. |
| Codex agents | `$CODEX_HOME/agents/` | |
| Codex rules | `$CODEX_HOME/AGENTS.md` | Managed block merge. |
| Claude rules | `~/.claude/CLAUDE.md` | Managed block merge. |
| Claude agents | `~/.claude/agents/` | |
| Copilot rules | `~/.copilot/copilot-instructions.md` | Managed block merge. Target `copilot_rules`; the GitHub Copilot harness is off by default. |
| Pi rules | `~/.pi/agent/AGENTS.md` | Managed block merge. Folders the app creates for it (`~/.pi`, `~/.pi/agent`) are owner-only (0700). Refused with zero mutation while `AGENTS.override.md` is beside it, or when `CLAUDE.md`, `CLAUDE.MD` or `AGENTS.MD` is there and `AGENTS.md` is not (existence checks only; those files are never read). Target `pi_rules`. |
| Kilo rules | `$XDG_CONFIG_HOME/kilo/AGENTS.md` (default `~/.config/kilo/AGENTS.md`) | Managed block merge. A relative `XDG_CONFIG_HOME` is ignored (the XDG specification calls it invalid) and the default location is used; a folder outside the home directory is the allowlisted root of that one file. Target `kilo_rules`. |
| Copilot MCP | `~/.copilot/mcp-config.json` | Entry `mcpServers.playwright` only; every other server keeps its value and its place. Strict JSON, see below. A new file is owner-only (0600). Target `copilot_mcp`; one file serves the CLI and VS Code. |
| Pi MCP | `~/.pi/agent/mcp.json` | Entry `mcpServers.playwright` only, same rules. Folders the app creates for it are owner-only (0700). Target `pi_mcp`. |
| Kilo MCP | `kilo.jsonc` in Kilo's config folder (`$XDG_CONFIG_HOME/kilo`, default `~/.config/kilo`), else an existing `kilo.json` there | Entry `mcp.playwright` only, same rules. Kilo's main config may hold provider keys, so target `kilo_mcp` is **off by default**. The file is parsed as strict JSON although Kilo accepts comments in it. |
| Cursor agents | `~/.cursor/agents/` | |
| Skills (all harnesses) | `~/.claude/skills/`, `~/.agents/skills/`, and `$CODEX_HOME/skills/` with a customised `CODEX_HOME` | Chosen from the enabled harnesses, GitHub Copilot, Pi and Kilo Code included (they add no folder of their own: Copilot and Pi use `~/.agents/skills/`). The app's copies in `~/.config/opencode/skills/`, `~/.cursor/skills/` and `$CODEX_HOME/skills/` from older versions are removed on update. Per-file ownership, backup and rollback; your files and dot directories are never touched. |
| Cursor MCP | `~/.cursor/mcp.json` | Playwright entry only. |
| Rules files, below the block (Library) | The rules file of an enabled harness (the rules rows above) | Only the bytes after the END line, through the same destination resolver, allowlisted root and symlink checks as Install. Refused with zero mutation for a symlinked file or parent folder, a file without a well-formed block, a Pi masking or peer file, a file over 4 MB or not UTF-8, a refinement line that would read as a marker, and a file whose text outside the block changed since it was opened. Atomic, keeps the file's permission bits, backed up first. |

Rules files are read in full (up to 4 MB) to locate the managed block. Only the bytes between the BEGIN and END markers are written; text outside them is preserved byte-for-byte, and a file with malformed markers, a diverged pre-block file, or an edited block is refused with zero mutation. The only explicit exceptions are the user-confirmed rules conversion, which previews the exact resulting file and runs as a backed-up transaction, and a Library save of the user's refinements, which writes only the bytes after the END line and proves before writing that the BOM, the text above BEGIN and the block are unchanged; its errors and results never carry file text. Backups copy the whole file, so user text in a rules file is stored in the backup root like any other backed-up target. The "leave as is" choice is stored as non-secret identities in `<workspace>/.agent-workspace/rules-preferences.json`.

A skill or agent file that differs from the bundle is a conflict the update never overwrites. The conflict diff reads the installed file and the bundled one, each only up to 512 KiB, never through a symlink, and compares text only: a non-UTF-8 or NUL-containing file is shown by size and digest, and a file with a private-key block on either side is withheld by the backend (the diff text never leaves it). The diff payload is the only carrier of file text, only for the open review; errors, logs, the status, the output pane and manual steps carry counts, labels and short digests, never a byte of a file. The UI masks credential shapes in the diff (private keys, Authorization and Cookie headers, signed-URL parameters, GitHub, OpenAI and JWT tokens) before rendering it, but not `name=value` text. Keeping the user's version records the choice in `kept-files.json` and writes no skill or agent file; handing it back deletes the choice. Taking the bundled version is the one action that overwrites a skill or agent file of the user, and it is a backed-up transaction like any update: `preview_take_bundled` is read-only and issues a one-time token bound to a fingerprint of the exact digest of every file it shows; `apply_take_bundled` plans again from disk, compares the fingerprint, validates the token and applies through the single apply owner (which consumes the token once, makes the backup, records the manifest, and checks and can roll back every write). It selects only the resolvable files of the named units (regular files with no symlink in their path, at most 64 MiB each because the backup reads the file into memory), and the writer refuses unless the artifact is a skill or agent file, its path is free of links and the file still has the reviewed digest; the write is the same no-follow, in-root atomic copy used by Install. A refusal happens before any backup or write. The user's file stays recoverable from the backup. No log, status, output or manual step carries file text: a preview carries labels, backup names and short digests, and the diff text only in the open review. The repository guard `scripts/check-managed-installation-contract.py` requires the command to apply through the apply owner and forbids any other token consumption site.

The MCP files of the light harnesses are read in full (up to 1 MiB) as strict JSON, to find and compare the one entry. They are not the app's: the other servers can hold tokens in `env` or `headers`, so their values are neither scanned for credentials, shown nor logged, and a message about a file carries a fixed reason ("the file has comments", "the file starts with a byte order mark", "the top level of the file is not an object") and never a byte of its text. Only the bundled entry template is scanned for credential-like literals before it is written. A file is refused with zero mutation when it is not UTF-8, starts with a byte order mark, has comments or a trailing comma, is not a JSON object at the top, or holds the servers key as something other than an object; so is an entry named `playwright` that is not the managed one (it is the user's own, unless a record proves the app wrote it and it is unchanged since). A write replaces the file with the user's keys in their order and the entry inserted or replaced: indentation is normalised to two spaces, a final newline is added, duplicate keys collapse to the last, and numbers follow serde's formatting (an integer beyond 64 bits would be written as a float); every other value is kept. The write is atomic, an existing file keeps its permission bits, and a new file is created 0600. Backups copy the whole file, so a backup of an MCP file holds whatever secrets the user keeps in it; backups are owner-only (0600, folders 0700) in the backup root like any other backed-up target. Uninstall never deletes an MCP file.

App support and backup roots are platform-resolved:

| Platform | App support dir | Backup root |
|----------|-----------------|-------------|
| macOS | `~/Library/Application Support/se.hugrverk.riggverk` | `<app support>/backups` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/se.hugrverk.riggverk` | `<app support>/backups` |
| Windows | `%APPDATA%\se.hugrverk.riggverk` | `<app support>\backups` |

Backup roots reject `/`, the home directory, and drive roots.

The app support dir is named like the bundle identifier. Builds from before the Riggverk rename used an older name. On first launch, before anything reads or writes app data, the app moves that directory to the current name with a single rename in the same parent folder: nothing is copied or deleted, and contents, modes, and modification times are preserved. The current directory wins when it already exists (the two are never merged), and an old path that is a symlink or not a directory is never followed. A failed move stops startup with both paths named and leaves the old directory where it was. [RELEASE.md](./RELEASE.md#app-data-move) has the details and the manual undo.

## Backups

Existing files that Install, uninstall, or a Library save would overwrite or remove are backed up first. Files that do not exist yet, `settings.json`, and the model override have no backup.

| Writer | Location under the backup root |
|--------|--------------------------------|
| Install, uninstall, rollback | `setup/<transaction id>/` with `manifest.json`, `artifacts/<artifact id>`, and `managed-state.previous.json` |
| Library save (personal doc) | `docs/custom_<slug>-<timestamp>/<file>` |
| Library save (rules refinements) | `docs/rules-<surface>-<timestamp>/<file>` |
| Cursor operations (and the retired CLI scripts) | `<YYYYMMDD-HHMMSS>/<label>/<file>` |

The app creates backup directories 0700 and files 0600 on Unix. Backups are read locally for validation, comparison, and rollback only and are never transmitted. Rollback restores exact prior state from a persisted transaction: per-artifact `in_flight` is recorded before mutation, interrupted rollbacks reconcile against post-apply and backup digests without overwriting unrelated user edits, and conflicts fail closed. The in-app rollback entry (`z`, `:rollback`) covers the last transaction of the current session.

Installation mutations are serialized in the trusted Rust backend. Packaged resources and runtime destinations are resolved separately and must never be the same root. Bounded copy and removal helpers require an explicit allowlisted root, reject dangling destination symlinks, and validate parent chains before creating or removing trees. Preview confirmation tokens are opaque, one-time, in-memory, expire after 600 seconds, and must not appear in logs or diagnostics.

OpenCode agent permissions are composed from `templates/opencode.policy.json` plus small `templates/opencode/agents/*.role.json` overrides. Restrictive roles use explicit `composition.replace_sections` so bash/edit profiles replace inherited capability sections instead of shallow-merging them. Shared secret denials remain canonical in the base policy and are emitted for the worktree root as well as nested paths, because OpenCode matches worktree-relative paths. The policy's `builtin_agents` section becomes managed `agent.plan.permission` and `agent.explore.permission` entries in `opencode.json` that keep OpenCode's built-in read-only agents read-only under the global permission block. Generated `agents/*.md` adapters are deterministic outputs; edit sources, not generated headers. `scripts/validate_opencode_permissions.py` enforces the semantic permission contract in release-check, evaluating bash rules per command of a compound like OpenCode; `resources/default-workspace/docs/OPENCODE_CONFIG.md` lists what the rules cannot see (the `grep` tool, a redirect behind a second command).

## Symlinks

Managed writes (Install, uninstall, rollback, backups) reject symlinked targets, symlinked parent chains, and dangling symlinks. Skill discovery rejects symlinked skill roots, groups, and directories. Library reads (documents, rules template, configs) enforce workspace containment and refuse symlinks; Library writes go only to a file directly in the workspace's own `docs/context` and refuse a symlink on the file, the folder, or a parent; the personal doc listing skips symlinks. A Library save of rules refinements refuses a symlinked rules file or a symlinked folder between it and its allowlisted root, and reads the file only when it is a regular file; `o` may open a symlinked rules file, which the OS follows to where it lives.

## Git

The status panel runs read-only git in the workspace root: `git rev-parse`, `branch`, `status`, and `log`. Nothing fetches, pushes, or contacts a remote.

Neutralized for every git call: `core.fsmonitor` (forced off), `core.hooksPath` (empty), `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, a timeout, a process-group kill, and capped output.

Still honored from repository config: filter drivers (`filter.<name>.clean` and `process`, which `git status` runs for modified files that a `.gitattributes` rule selects; no filter-free dirty check gives the same answer) and any other key not listed above. Treat a workspace you did not create as untrusted.

## Scripts

The app runs its `python3` merge and generator helpers from the bundled, read-only copy, never from the editable runtime workspace, with fixed arguments. It never uses `sh -c` or a shell plugin (`check-shell-spawn.py` enforces this in release-check).

The OpenCode runtime pane and model list also run the installed `opencode` CLI: `--version`, `debug agent <default_agent> --pure` and `models` (`--pure`, or `--standalone` on OpenCode 2.x). The binary comes from `PATH`, the Homebrew directories or `~/.opencode/bin`, never from the workspace. Arguments are fixed, except the default agent name, which must start with a letter or digit and is passed as one argument. Each call has a timeout and an output cap and runs from the system temp folder. Only the exit status, a version number and `provider/model` ids are kept; raw output is not stored or logged.

The pages of the light harnesses (GitHub Copilot, Pi, Kilo Code) run only `<cli> --version`, for `copilot`, `pi` and `kilo`. The program is found on `PATH` or, for these three only, as `bin/<name>` of the highest version folder below `~/.nvm/versions/node` (nvm's alias files are not read); the app puts that folder, which holds `node`, in front of the probe's `PATH`. The argument list is fixed and the program names come from an embedded descriptor, never from the workspace. The call has a 10 second timeout and a 4 KB output cap and runs from the system temp folder; only the version token is kept, and raw output is not stored or logged. No other subcommand is ever run: `copilot version` asks the network, `pi --help` and `kilo debug paths|config` create files in the harness's own folders, and `kilo debug config` prints the resolved config with its secrets. Apart from the rules and MCP files in the table above, nothing in `~/.copilot`, `~/.pi` or `~/.config/kilo` is read or written (`config.json`, `settings.json`, `auth.json`, `models.json`, sessions and the like are never opened, and the descriptor refuses them as targets). For Kilo, whether `opencode.json`, `opencode.jsonc` (beside the chosen file) and `~/.kilo/kilo.json[c]` exist is checked, to warn that they win over the entry; they are never opened. No MCP subcommand is ever run: `pi mcp list` starts the configured servers, `kilo mcp` and `kilo debug config` print the resolved config with its secrets and create files, and `copilot mcp` is not needed. The health rows show statuses and counts, never file text. The effective-load view opens the `SKILL.md` of the skills below `~/.copilot/skills`, `~/.pi/agent/skills` and `~/.kilo/skills`, like it does for the other harnesses' skills folders.

## What the app does NOT access

- `.env` files or arbitrary secret environment values. The app reads documented operational variables (workspace, backup, Codex home, skill roots, Playwright, XDG, `HOME`, `PATH`); their values must not be printed or persisted as user content.
- Private keys, cookies, or credential stores.
- Browser profiles, bookmarks, or saved passwords.
- System keychains, SSH agent state, or GPG state.
- IDE authentication state, tokens, sessions, or trust databases.
- Unrelated IDE settings or MCP server payloads outside the allowlisted Playwright entries of Cursor and of the light harnesses (the other servers in those files are parsed with the file and never scanned, shown or logged).
- Project `.git/` directories, except the read-only git status of the workspace root (see Git).

## Process output

Command output is redacted for display and capped at 16 MB per stream. Helper subprocesses run with a 120 s default timeout; a timeout kills the whole process group.

## Release verification

`scripts/release-check.sh` validates source format, templates, skill count, adapter currency, and contracts. It runs apply smokes against temporary `HOME` directories and never writes the real user config. See [RELEASE.md](./RELEASE.md).

## Dependencies

- [Tauri](https://tauri.app) - application shell. The webview CSP allows only `'self'` and IPC; capabilities are window dragging, the folder dialog, and listening for backend events (the webview cannot emit).
- [serde](https://serde.rs), [React](https://react.dev), [TypeScript](https://www.typescriptlang.org), [Vite](https://vite.dev) (MIT).
