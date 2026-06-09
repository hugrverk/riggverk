# Agent Workspace

Local macOS control panel for skills, rules, config, and workflow sync.

## Purpose

Thin GUI wrapper around the existing workspace scripts. Cursor global setup (agents, skills, MCP) uses native Rust on all supported desktop platforms. Skills installation uses workspace scripts on macOS/Linux and a hardened native installer on Windows. Shell-only Cursor helpers (`--show-user-rules`, `--copy-user-rules`, `--open-cursor-settings`, CLI-only `--project*`) route through `install-cursor-workspace.sh` on Unix or fail clearly on Windows.

App-triggered script actions use each script's `--quiet` option for compact terminal output. Running the scripts manually without `--quiet` keeps the more verbose CLI/debug output.

### Cross-platform notes

- **Cursor profile:** GUI diff/apply/validate and global agent sync use native Rust on all platforms with the same templates, manifest, and `CURSOR_*` path env overrides. `install-cursor-workspace.sh` is for manual helpers and CLI-only project installs; it never writes `~/.cursor/agents`.
- **Skills:** macOS/Linux route through `scripts/install-skills.sh`. Windows uses the hardened native installer with staged replacement and destination containment.
- **Home resolution:** Windows prefers non-empty `USERPROFILE`, then `HOMEDRIVE`+`HOMEPATH`, then `HOME`. macOS/Linux prefer `HOME`.
- **Safety:** Backup roots and skill destinations reject broad targets such as filesystem roots, Windows drive roots, UNC share roots, and the resolved user home directory.

## Prerequisites

- Node.js 20+
- npm 10+
- Rust (stable toolchain via rustup)
- macOS (uses `/usr/bin/open` for doc actions and `bash` for scripts)

## Local dev

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm install
npm run tauri build
```

The built `.app` bundle will be in `src-tauri/target/release/bundle/macos/`.

## Release Check

Run from the repository root:

```bash
./scripts/release-check.sh
```

The check validates bundled default workspace scripts and metadata, scans app source for forbidden command patterns, runs the frontend build, and runs Rust formatting, check, clippy, and tests.

## Workspace

The app operates on a workspace folder — a user-owned data directory containing configuration, docs, skills, templates, and scripts. The workspace folder is not the app source checkout.

Workspace validation uses `.agent-workspace/workspace.json` and required workspace markers (scripts, templates, Cursor setup assets, README, skills directory).

This repository is the Agent Workspace **app and runtime**: the Tauri GUI, bundled default workspace resources (28 skills, templates, scripts, docs), and release tooling. Installed user workspace content lives at `~/.config/agent-workspace` (or `AGENT_WORKSPACE_PATH` for dev/test) and is separate from this checkout.

See [docs/WORKSPACE_CONTRACT.md](docs/WORKSPACE_CONTRACT.md) for the workspace contract.

The app source includes a shared starter workspace under `resources/default-workspace/` with bundled default templates, scripts, docs, 28 skills, and a workspace marker. These resources are bundled into the macOS app bundle as Tauri resources and are available in the installed app. They are also available in dev/source checkout mode.

Bundled defaults are copied only when you click **install** or **repair** on the Workspace (Start) page. The app installs the local runtime workspace at `~/.config/agent-workspace` — it does not ask you to choose a folder. No files are created automatically on launch. Install and repair are explicit user actions; they do not overwrite existing files, do not run scripts, and only write under the canonical install path (or `AGENT_WORKSPACE_PATH` for dev/test overrides).

Existing installs that are missing newer bundled files (for example prompt-template docs added in a later app release) can be fixed on the Workspace page:

- **repair** — when the workspace is invalid or missing required markers; copies only missing bundled files and never overwrites existing user edits.
- **update resources** — when the workspace is valid but newer bundled files are absent (for example empty or missing prompt-template docs); same non-destructive copy rules as repair.

Library → Docs shows a hint when bundled curated docs are absent on disk.

### Workspace startup

On app startup, the Workspace page loads settings, install/repair diagnostics, and workspace contract status. Skills are loaded in the background for harness pages; skill count, selection, and install live on each tool harness (Codex, OpenCode, Cursor, Claude), not on Workspace.

### Skill selection

Skill selection is per-workspace on harness pages. When the active workspace changes (for example after install or a dev override), the selection resets and all available skills for the new workspace are auto-selected by default. If you clear the selection within a workspace, that choice is respected until the workspace changes again. Harness Skills cards show **Loading**, **No skills in workspace**, or **Select skills to install** states.

### Installed workspace path

The workspace root is resolved in order of precedence:

1. **Environment**: `AGENT_WORKSPACE_PATH` (dev/test override when set and non-empty).
2. **Settings**: `workspace_path` in app settings when set to a valid non-legacy custom path.
3. **Default**: `~/.config/agent-workspace` (canonical installed runtime workspace).

The Workspace (Start) page shows whether the local runtime workspace is installed, missing, or needs repair. Use **install** or **repair** there; the app does not expose arbitrary path selection in normal UI. The deprecated `~/Agent Workspace` default is not used; existing folders at that path are not modified automatically.

`AGENT_WORKSPACE_PATH` overrides the canonical path for development and tests. Sync, install, and release actions run allowlisted scripts from the resolved workspace only.

## Settings

Settings are stored as JSON at `~/Library/Application Support/ai.agentworkspace.app/settings.json` (macOS) and persist across app restarts.

### Available settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `appearance` | `"dark"` `"light"` `"system"` | `"dark"` | Theme mode. `system` follows the OS colour scheme via `prefers-color-scheme`. |
| `app_font_size` | `"small"` `"medium"` `"large"` `"extra-large"` | `"medium"` | Global app text size (Settings → Text size). Scales UI typography via root CSS variables. |
| `workspace_path` | `string` or `null` | `null` | Optional persisted path after a successful install (usually the canonical install path). When `null`, resolution uses `AGENT_WORKSPACE_PATH` or `~/.config/agent-workspace`. Legacy `~/Agent Workspace` values are ignored. Whitespace-only values are saved as `null`. |
| `enabled_target_ids` | `string[]` | `["codex_rules","opencode_rules","opencode_config"]` | Which agent and config targets are enabled for status checks and sync. Edited on harness pages (Targets panel); changes **autosave** (debounced). `codex_config` is available on the Codex harness but is not enabled by default. Profiles are quick-select presets on each harness page — they do not run sync or write target files. |

The settings file is created at the macOS application support path under the current user's `HOME` (`~/Library/Application Support/ai.agentworkspace.app/settings.json`). If `HOME` is unavailable, settings cannot be saved and an error is returned. Loading falls back to defaults when the file is missing or invalid.

### Settings security

Settings are validated before save: `appearance` is enum-constrained to `dark`/`light`/`system`, `workspace_path` is trimmed and normalized. Settings do not expose the app to arbitrary command execution — all backend actions remain allowlisted. The workspace path only affects the working directory of existing allowlisted commands and cannot introduce new commands or shell execution.

Install and repair copy bundled defaults only into the canonical path (`~/.config/agent-workspace`). They never overwrite existing files, never run scripts, and never write outside that install directory (except `AGENT_WORKSPACE_PATH` dev/test overrides).

## App Surfaces

Primary navigation:

- **Workspace** — landing page and operations terminal. Shows install state for `~/.config/agent-workspace` with **install**, **repair**, **refresh**, and **open folder**. Verify section runs release-check and manages backups. No path chooser or pull workflow.
- **Harness pages** (Codex, OpenCode, Cursor, Claude) — per-tool diff/sync/install actions and skills install for that tool.
- **Library** — browse and edit workspace sources: Docs (curated user-facing docs plus custom `docs/context/` notes), Rules, Skills, Agents, Configs, and Brain Setup. Prompt Templates appear under Library → Docs after install or repair has copied bundled `docs/prompt-templates/*` into the workspace. Internal Cursor implementation assets (manifest, MCP JSON, adapter agents, project rules) stay in the workspace for repair but are not listed as normal Library docs.
- **Prompt Loops** — direct navigation destination for copy-ready prompt templates and the optional composer (see below).
- **Repo Dashboard** — direct navigation destination for local-git-first repository insight (see below).
- **Settings** — appearance, global text size (`small`, `medium`, `large`, `extra large`), and theme colors. Target profiles and sync toggles live on harness pages.

### Prompt Loops and Repo Dashboard

**Prompt Loops** is a copy-ready template browser first, with an optional composer second. Groups: standard, masterprompt, batchprompt, and rewrite. Select a template, preview the prompt, and copy it unchanged when no repo context, task/context text, or prompt options are active. Optional controls add visible sections only: saved Repo Dashboard repo metadata resolved via safe local git inspection (label, sanitized `owner/repo` slug, current/default branch; never local paths or raw remotes in composed output), a task/context textarea, and a collapsed **Prompt options** panel with a small fixed set of generic hard-constraint chips. Copy always matches the preview exactly.

v1 does not parse repos or docs on its own, does not call LLMs, does not hardcode repository names or project-specific repo profiles, and does not persist composer state in app settings or localStorage. Open Prompt Loops or Repo Dashboard from the header navigation icons (there is no shared Tools page). Templates require operator metadata above the copy/paste block; generated prompts must weave exact skill names (e.g. `Use diagnose...`) into executable English instructions, not only list them under Relevant skills. Run `npx tsx scripts/check-prompt-loops-templates.ts` to validate templates and the deterministic composer.

**Use as context** (session-only handoff from Repo Dashboard): on eligible docs-backed work items (`feature`, `roadmap`, `todo` only — not `gap`, `fix`, `note`, or GitHub issues), **Use as context** switches to Prompt Loops and fills the optional task/context textarea with a deterministic block for that item. It does not generate a prompt, change the active template/group, auto-select standard/master/batch/rewrite, or bypass preview/copy. If the active Repo Dashboard path matches a saved repo entry, Prompt Loops may select that repo context; otherwise task/context is filled and repo context stays unset. No right-click, multi-select, persistence, GitHub API, or `gh` calls. Run `npx tsx scripts/check-prompt-context-handoff.ts` for handoff formatter/eligibility checks.

**Repo Dashboard** is local-git-first with a full-width top tab layout (Overview, Work, Docs). The repository strip includes path entry, optional **default branch override** (empty = auto-detect), **Discover local repos**, save, and refresh controls. Point it at a checkout path on disk; the app runs fixed allowlisted `git` commands via the Tauri backend (branch, dirty state, ahead/behind, commit log, changed files at `HEAD`, and local docs parsing). **Discover local repos** scans one parent folder you choose (shallow, bounded depth) and lets you import found checkouts into saved repo entries (shared with Prompt Loops). It does **not** store GitHub PATs, does **not** call the GitHub API directly, does **not** list account repos or clone, and does **not** accept frontend-supplied shell commands.

Optional enhancement: when the `gh` CLI is installed and authenticated, the dashboard may enrich merged PR metadata and open issues using fixed `gh` subcommands with explicit args and bounded JSON output. If `gh` is missing or not authenticated, the UI stays in local-git-only mode. The **Changed files** panel always reflects local `git show HEAD`, not a GitHub PR file list, even when merge metadata comes from `gh`.

Repo dashboard entries (label, path, optional default branch) may be saved from the dashboard **save** control or imported after **Discover local repos** via app settings. Only non-secret metadata is persisted. Commit history and activity charts load all history reachable from the current local `HEAD` through bounded paginated Git reads (shallow clones expose only history present locally).

Supported data quality states:

| State | Meaning |
| --- | --- |
| Not synced | No path refreshed yet |
| Local-git-only | Git and docs from disk; `gh` unavailable or not authenticated |
| Enhanced | Local git plus optional `gh` PR/issue metadata |
| Warnings | Partial data (missing docs, no remote, git errors) with evidence in source health |

**Brain Setup** (under Library) is a copy-paste instruction surface for external AI assistants. It helps you copy a durable prompt block for ChatGPT, Claude Web, Codex, or another coding assistant — skill routing discipline, model/tool recommendations, security rules, and verification discipline. It does not run agents, change enabled sync targets, or mutate runtime config.

## Docs security

- `save_doc` is allowlisted by curated doc id or custom doc slug. The backend resolves the file path exclusively through the internal curated doc registry or the validated custom doc slug.
- `save_agent_template` resolves the template path internally as `templates/global-agent-rules.md` under the validated workspace root. No frontend-supplied paths are accepted.
- The frontend never supplies file paths for doc or template writes.
- Unknown doc ids and invalid custom slugs are rejected before any filesystem access.
- Content is capped at 512 KB for docs, configs, and agent template.
- The resolved target path is verified to remain under the validated workspace root.
- Existing content is backed up before overwrite only when the new content differs.
- Custom docs are restricted to `docs/context/<slug>.md` with strict slug validation. No subdirectories, no recursion.
- `create_doc` rejects existing files and invalid slugs.
- No arbitrary file browsing, creation, or restoration is supported.

## Security model

- Frontend requests only named actions. No arbitrary commands, paths, or arguments pass from frontend to backend.
- Backend maps named actions to fixed commands via `std::process::Command` with explicit program and args.
- No shell string concatenation. No `sh -c`. No Tauri shell plugin.
- Sync targets are defined through an internal agent target registry (`agent_targets.rs`). This does not permit arbitrary file sync or arbitrary commands.
- Config sync targets are managed through an internal allowlisted config target registry (also in `agent_targets.rs`). Config scripts are mapped by enum, not by frontend-supplied paths.
- Editable config templates use a narrower allowlist. Cursor setup is a native sync/status target and is not exposed through the Library Configs editor.
- **Repo Dashboard** uses a dedicated backend module with fixed `git` and optional fixed `gh` invocations. Repo path is validated and normalized; command strings never come from the frontend.
- Supported targets: Codex rules + config; OpenCode rules + shared runtime agents + config/TUI; Claude rules + shared runtime agents; Cursor adapter global agents (`templates/cursor/agents/`). Rules, agents, config, and skills are separate sync surfaces on harness pages.

### Agent rule sync (scripts/install-agent-rules.sh)

`scripts/install-agent-rules.sh` syncs `templates/global-agent-rules.md` to agent-specific paths:

| Flag | Target path (with env override) |
|------|-------------------------------|
| `--codex` | `${CODEX_AGENTS_PATH:-$HOME/.codex/AGENTS.md}` |
| `--opencode` | `${OPENCODE_AGENTS_PATH:-$HOME/.config/opencode/AGENTS.md}` |
| `--claude` | `${CLAUDE_RULES_PATH:-$HOME/.claude/CLAUDE.md}` |

On apply, existing diverged rule targets are backed up under `~/Library/Application Support/ai.agentworkspace.app/backups` before overwrite. `AGENT_WORKSPACE_BACKUP_DIR` can override the backup root for testing or advanced local use. Diff and dry-run modes do not create backups.

### Shared runtime agents (scripts/install-runtime-agents.sh)

`scripts/install-runtime-agents.sh` syncs `agents/*.md` to harness-specific agent directories:

| Flag | Target directory |
|------|------------------|
| `--opencode` | `${OPENCODE_AGENTS_DIR:-$HOME/.config/opencode/agents}` |
| `--claude` | `${CLAUDE_AGENTS_DIR:-$HOME/.claude/agents}` |

Codex uses TOML custom agents under `~/.codex/agents/` (not this `.md` bundle). Cursor uses native setup from the Cursor page (agents, starter skills, Playwright MCP under `~/.cursor/`).

## Skill installation

Skills are installed into agent skill folders using local filesystem copy from validated workspace `skills/` directories (bash script on macOS/Linux, native adapter on Windows). No external package managers are used for install.

Global destinations:
- Codex: `$HOME/.agents/skills` (override with `CODEX_SKILLS_PATH`; legacy installs may remain under `${CODEX_HOME:-$HOME/.codex}/skills`)
- OpenCode: `$HOME/.config/opencode/skills` (override with `OPENCODE_SKILLS_PATH`)
- Claude: `$HOME/.claude/skills` (override with `CLAUDE_SKILLS_PATH`)
- Cursor: `$HOME/.cursor/skills` (override with `CURSOR_SKILLS_PATH`)

The app installs skills globally only (Codex, OpenCode, Claude, Cursor home skill folders). Cursor’s primary workflow applies native setup from the Cursor page: `~/.cursor/agents`, `~/.cursor/skills` (recommended pinned skills), and `~/.cursor/mcp.json` (playwright server merge). Apply may remove a legacy Agent Workspace-owned `playwright:*` mcpAllowlist entry from `~/.cursor/permissions.json` when present; it does not install a replacement permissions template. User Rules remain manual (`templates/cursor/user-rules.md`). Setup never writes project `.cursor/*`, `.cursorignore`, or `AGENTS.md`. Auto Review, sandbox behavior, and general permissions remain IDE-managed.

## Workspace Contract Validator

The app includes a read-only Workspace Contract Validator that checks an active workspace against the workspace contract. It validates skills, agent metadata, and agents without executing scripts or modifying files.

### What it checks

| Check | Description |
|-------|-------------|
| Workspace root | Resolves and verifies `.agent-workspace/workspace.json` exists |
| Skills directory | `skills/` exists and contains root-level skills at `skills/<skill>/SKILL.md` |
| Skill metadata | Every `SKILL.md` has required `name` and `description` fields |
| Skill uniqueness | No duplicate skill names (deterministic failure) |
| Legacy skills | No legacy nested skills at `skills/<group>/<skill>/SKILL.md` (fails — workspace contract is root-level only; nested skills are ignored by skill discovery) |
| Agent metadata | `metadata/agents.json` is optional; validates JSON, size, and structure when present |
| Metadata notes | All notes fields in agent metadata are string arrays |
| Metadata keys | All agent keys in metadata map to known agent files (warns on unknown keys) |
| Default skills | All `default_skills` in agent metadata reference existing workspace skills |
| Agent files | Lists known agent source files and reports presence |

### What it does NOT do

- Run scripts, install skills, or sync configs
- Modify any files in the workspace
- Change OpenCode runtime behavior or agent permission blocks
- Change `default_agent`, install destinations, or sync semantics
- Fix or auto-correct validation failures
- Execute shell commands, read secrets, or browse arbitrary filesystem paths

## Resource Intelligence v1

Resource Intelligence enriches the GUI's understanding of skills and agents with safe metadata. It improves Library visibility while keeping the app a narrow local workspace management GUI — not an orchestration layer.

### What it does

- Describes resources with category, risk, target compatibility, and related-skill references.
- Shows compatibility between skills, agents, and target tools.
- Helps the operator choose better without automating execution.

### What it does NOT do

- Run agents or trigger tool actions.
- Route automatically or generate prompts automatically.
- Mutate runtime configs, OpenCode config, or agent permission blocks.
- Install or sync from Library → Brain Setup.
- Add MCP, background workers, memory, task queues, chat, or agent execution.
- Add arbitrary filesystem browsing or new dependencies.

## Architecture

```
├── package.json          Frontend dependencies and scripts
├── index.html            Entry HTML
├── tsconfig.json         TypeScript config
├── vite.config.ts        Vite config (port 1420)
├── src/
│   ├── main.tsx          React entry
│   ├── App.tsx           Main UI component
│   ├── components/
│   │   ├── Markdown.tsx  Markdown renderer
│   │   └── TerminalOutput.tsx Shared terminal output primitives
│   ├── lib/
│   │   ├── brainSetup.ts  Brain Setup copy block builder
│   │   ├── editorGuards.ts  Dirty editor guard helpers
│   │   ├── libraryDirtyGuards.ts  Library source type dirty-state checker
│   │   ├── redactTerminalOutput.ts  Terminal output redaction helpers
│   │   ├── settingsDraft.ts  Settings defaults and comparison
│   │   ├── status.ts     Status count and class-name helpers
│   │   ├── timing.ts     Small timing helpers
│   │   ├── useBackups.ts  Backup state hook
│   │   ├── useWorkspaceActions.ts  Workspace operation action dispatcher
│   │   └── useWorkspaceGeneration.ts  Workspace generation hook
│   ├── views/
│   │   ├── StartView.tsx        Workspace install/repair landing page
│   │   ├── CodexView.tsx        Codex harness (rules/config/skills)
│   │   ├── OpenCodeView.tsx     OpenCode harness
│   │   ├── CursorView.tsx       Cursor harness
│   │   ├── ClaudeView.tsx       Claude harness
│   │   ├── LibraryView.tsx      Unified source browser/editor (Docs, Rules, Skills, Agents, Configs)
│   │   ├── library/BrainSetupContent.tsx  Brain Setup copy-paste surface
│   │   ├── SettingsView.tsx     Settings view
│   │   └── library/
│   │       ├── DocContent.tsx   Docs browser/editor content pane
│   │       ├── RulesContent.tsx Rules template content pane
│   │       ├── SkillsContent.tsx Skills browser content pane
│   │       ├── AgentContent.tsx Agent source editor content pane
│   │       └── ConfigContent.tsx Config template content pane
│   ├── types.ts          Shared frontend data types
│   └── styles.css        Dark macOS utility styles
└── src-tauri/
    ├── Cargo.toml        Rust dependencies (tauri, serde)
    ├── tauri.conf.json   Tauri v2 config
    ├── capabilities/
    │   └── default.json  Tauri v2 capability permissions
    └── src/
        ├── main.rs         Tauri entry point
        ├── lib.rs          Tauri builder
        ├── commands.rs     Tauri command module root
        ├── commands/       Focused command modules
        │   ├── actions.rs  Action dispatcher and script actions
        │   ├── backups.rs  Backup listing and Finder open commands
        │   ├── content.rs  Docs/templates/config content commands
        │   ├── contract.rs Workspace contract validator
        │   ├── defaults.rs Bundled starter workspace summary
        │   ├── process.rs  Command result and process helpers
        │   ├── settings_commands.rs Settings and target commands
        │   ├── skills.rs   Skill listing/install commands
        │   ├── status.rs   Workspace status command
        │   └── workspace.rs Workspace path validation helpers
        ├── agent_targets.rs Agent sync target registry
        └── settings.rs     Persistent app settings (JSON)
```

## License and notices

Agent Workspace is released under the [MIT License](LICENSE). Some bundled starter skills are adapted from third-party skill work; see [NOTICE.md](NOTICE.md).
