# Agent Workspace

Local macOS control panel for skills, rules, config, and workflow sync.

## Purpose

Thin GUI wrapper around the existing workspace scripts. Scripts remain the source of truth. The app does not reimplement script logic.

App-triggered script actions use each script's `--quiet` option for compact terminal output. Running the scripts manually without `--quiet` keeps the more verbose CLI/debug output.

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

This repository is the shared private app/runtime repo for PRIVATE and his colleague. User workspace content lives in separate user-owned workspace folders outside this checkout.

### Repo boundaries

| Repo | Role |
| --- | --- |
| `agent-workspace` (this repo) | Shared app, runtime tools, 28 bundled skills, agents, templates, and install scripts for PRIVATE and his colleague |
| `private-context` | PRIVATE-only saved memory and personal context (not bundled into defaults) |
| `ux-workspace` | Deprecated migration source; do not use for new work |

See [docs/WORKSPACE_CONTRACT.md](docs/WORKSPACE_CONTRACT.md) for the full workspace contract.

The app source includes a shared starter workspace under `resources/default-workspace/` with bundled default templates, scripts, docs, 28 skills, and a workspace marker. These resources are bundled into the macOS app bundle as Tauri resources and are available in the installed app. They are also available in dev/source checkout mode.

Bundled defaults are copied only when you click **install** or **repair** on the Workspace (Start) page. The app installs the local runtime workspace at `~/.config/agent-workspace` — it does not ask you to choose a folder. No files are created automatically on launch. Install and repair are explicit user actions; they do not overwrite existing files, do not run scripts, and only write under the canonical install path (or `AGENT_WORKSPACE_PATH` for dev/test overrides).

Existing installs that are missing newer bundled files can be fixed with **repair** on the Workspace page. Repair copies only missing files from the app's bundled default workspace and never overwrites existing user edits.

### Workspace startup

On app startup, the Workspace view loads settings, diagnostics, the default workspace summary (bundled resource preview), and workspace resources (skills list, docs list, agent sources, workspace contract, and status). When a valid workspace path has been saved from a previous session, the Workspace view immediately shows the active skill count and auto-selects all workspace skills without requiring the user to open the Library first.

The Skills install lane distinguishes three states:
- **Loading** — skills are being fetched (no false "No skills selected" before data arrives).
- **No skills found** — the workspace contains no skill files.
- **No skills selected** — skills exist but the user has cleared the selection.

### Skill selection

Skill selection is per-workspace. When the active workspace changes (for example after install or a dev override), the skill selection resets and all available skills for the new workspace are auto-selected by default. If the user manually clears the selection within a workspace, that choice is respected until the workspace changes again.

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
| `workspace_path` | `string` or `null` | `null` | Optional persisted path after a successful install (usually the canonical install path). When `null`, resolution uses `AGENT_WORKSPACE_PATH` or `~/.config/agent-workspace`. Legacy `~/Agent Workspace` values are ignored. Whitespace-only values are saved as `null`. |
| `enabled_target_ids` | `string[]` | `["codex_rules","opencode_rules","auggie_rules","opencode_config","codex_config"]` | Which agent and config targets are enabled for status checks and sync. Edited on harness pages (Targets panel); persisted when you **Save** in Settings. Profiles are quick-select presets on each harness page — they do not run sync or write target files. |

The settings file is created at the macOS application support path under the current user's `HOME` (`~/Library/Application Support/ai.agentworkspace.app/settings.json`). If `HOME` is unavailable, settings cannot be saved and an error is returned. Loading falls back to defaults when the file is missing or invalid.

### Settings security

Settings are validated before save: `appearance` is enum-constrained to `dark`/`light`/`system`, `workspace_path` is trimmed and normalized. Settings do not expose the app to arbitrary command execution — all backend actions remain allowlisted. The workspace path only affects the working directory of existing allowlisted commands and cannot introduce new commands or shell execution.

Install and repair copy bundled defaults only into the canonical path (`~/.config/agent-workspace`). They never overwrite existing files, never run scripts, and never write outside that install directory (except `AGENT_WORKSPACE_PATH` dev/test overrides).

## App Surfaces

Primary navigation:

- **Workspace** — landing page and operations terminal. Shows install state for `~/.config/agent-workspace` with **install**, **repair**, **refresh**, and **open folder**. Verify section runs release-check and manages backups. No path chooser or pull workflow.
- **Harness pages** (Codex, OpenCode, Cursor, Claude, Augment) — per-tool diff/sync/install actions and skills install for that tool.
- **Library** — browse and edit workspace sources: Docs, Rules, Skills, Agents, Configs, and Brain Setup.
- **Settings** — appearance and theme colors. Target profiles and sync toggles live on harness pages.

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
- Editable config templates use a narrower allowlist. Cursor setup remains a script-backed sync/status target and is not exposed through the Library Configs editor.
- Supported targets: Codex rules (`.codex/AGENTS.md`), Codex config (`.codex/config.toml`), OpenCode rules (`.config/opencode/AGENTS.md`), Auggie rules (`.augment/rules/global.md`), Claude rules (`.claude/CLAUDE.md`), OpenCode config (`.config/opencode/opencode.json`), OpenCode TUI config (`.config/opencode/tui.json`), and Cursor setup (`.cursor/agents` via the Cursor setup script).

### Agent rule sync (scripts/install-agent-rules.sh)

`scripts/install-agent-rules.sh` syncs `templates/global-agent-rules.md` to agent-specific paths:

| Flag | Target path (with env override) |
|------|-------------------------------|
| `--codex` | `${CODEX_AGENTS_PATH:-$HOME/.codex/AGENTS.md}` |
| `--opencode` | `${OPENCODE_AGENTS_PATH:-$HOME/.config/opencode/AGENTS.md}` |
| `--auggie` | `${AUGGIE_GLOBAL_PATH:-$HOME/.augment/rules/global.md}` |
| `--claude` | `${CLAUDE_RULES_PATH:-$HOME/.claude/CLAUDE.md}` |

On apply, existing diverged rule targets are backed up under `~/Library/Application Support/ai.agentworkspace.app/backups` before overwrite. `AGENT_WORKSPACE_BACKUP_DIR` can override the backup root for testing or advanced local use. Diff and dry-run modes do not create backups.

## Skill installation

Skills are installed directly into native agent skill folders using local filesystem copy from the validated repo `skills/` directories. No external package managers are used for install.

Global destinations:
- Codex: `${CODEX_HOME:-$HOME/.codex}/skills` (override with `CODEX_SKILLS_PATH` or `CODEX_HOME`)
- OpenCode: `$HOME/.config/opencode/skills` (override with `OPENCODE_SKILLS_PATH`)
- Claude: `$HOME/.claude/skills` (override with `CLAUDE_SKILLS_PATH`)
- Cursor: `$HOME/.cursor/skills` (override with `CURSOR_SKILLS_PATH`)

The app installs skills globally only (Codex, OpenCode, Claude, Auggie, Cursor home skill folders). Cursor subagents are synced globally from Workspace via `install-cursor-workspace.sh --global-agents` to `~/.cursor/agents`. Cursor User Rules are version-controlled as `templates/cursor/user-rules.md` and can be shown or copied from Workspace; they are not auto-written because Cursor does not document a stable file-backed write target. MCP examples and sandbox/profile templates are opt-in and must use env placeholders for auth-like values. Playwright MCP support uses MCP config and MCP allowlists, not command allowlists.

CLI-only (outside app workflow): `install-skills.sh` and `install-cursor-workspace.sh` still accept `--project --target <path>` for explicit project paths when run manually from a terminal. The app never exposes those options.
- Auggie: `$HOME/.augment/skills` (override with `AUGGIE_SKILLS_PATH`)

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
│   │   ├── AugmentView.tsx      Augment harness
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
