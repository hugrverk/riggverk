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

This repository is the public app source repo. User workspace content lives in separate user-owned workspace folders outside this checkout.

See [docs/WORKSPACE_CONTRACT.md](docs/WORKSPACE_CONTRACT.md) for the full workspace contract.

The app source includes a generic starter workspace under `resources/default-workspace/` with bundled default templates, scripts, docs, starter skills, and a workspace marker. These resources are bundled into the macOS app bundle as Tauri resources and are available in the installed app. They are also available in dev/source checkout mode.

Bundled defaults are read-only source material previewed in the Workspace tab. They can be applied to create a new workspace via the **create workspace** button, which copies bundled default files into a safe empty or missing target directory. The Workspace tab shows a **Workspace Setup** panel when the active path is invalid (e.g. default path does not exist). Click **dry-run create** to evaluate safety, then **create workspace** to initialize. No files are created automatically on launch — all create actions are explicit user operations. Create does not overwrite existing files, does not run scripts, and only accepts targets that pass the planner safety checks.

### Workspace startup

On app startup, the Workspace view loads settings, diagnostics, the default workspace summary (bundled resource preview), and workspace resources (skills list, docs list, agent sources, workspace contract, and status). When a valid workspace path has been saved from a previous session, the Workspace view immediately shows the active skill count and auto-selects all workspace skills without requiring the user to open the Library first.

The Skills install lane distinguishes three states:
- **Loading** — skills are being fetched (no false "No skills selected" before data arrives).
- **No skills found** — the workspace contains no skill files.
- **No skills selected** — skills exist but the user has cleared the selection.

### Skill selection

Skill selection is per-workspace. When the workspace path changes (via **choose folder** or **use default**), the skill selection resets and all available skills for the new workspace are auto-selected by default. If the user manually clears the selection within a workspace, that choice is respected until the workspace path changes again.

### Workspace path

The workspace root is resolved in order of precedence:

1. **Settings**: `workspace_path` in app settings (if set to a non-empty string).
2. **Environment**: `AGENT_WORKSPACE_PATH` environment variable.
3. **Default**: built-in fallback path (`~/Agent Workspace`).

Set a custom workspace path in the Workspace tab using **choose folder** (native directory picker) or **use default** (resets to `~/Agent Workspace`). Both actions save the path immediately to app settings and refresh diagnostics, status, contract, and all resource views — no separate Save step required. Manual path entry in the Inventory panel updates the local draft only. The Workspace tab shows diagnostics (validity and missing markers) so invalid workspace paths are visible immediately.

A custom workspace path only changes the working directory for existing allowlisted commands (`git_pull`, `bootstrap_*`, `verify_state`, `sync_agent_rules`, etc.) — it does not add or change any allowed commands.

Selecting a workspace is a trust decision. The app exposes allowlisted actions only, but sync, install, and release actions may execute scripts from the selected workspace. Use workspaces you control. No scripts run automatically on launch, and workspace creation copies starter files without executing scripts.

## Settings

Settings are stored as JSON at `~/Library/Application Support/ai.agentworkspace.app/settings.json` (macOS) and persist across app restarts.

### Available settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `appearance` | `"dark"` `"light"` `"system"` | `"dark"` | Theme mode. `system` follows the OS colour scheme via `prefers-color-scheme`. |
| `workspace_path` | `string` or `null` | `null` | Custom workspace root path. When `null` or missing, falls back to `AGENT_WORKSPACE_PATH` env or built-in default. Whitespace-only values are saved as `null`. |
| `enabled_target_ids` | `string[]` | `["codex_rules","opencode_rules","auggie_rules","opencode_config"]` | Which agent and config targets are enabled for status checks and sync. Rule targets (codex_rules, opencode_rules, auggie_rules, claude_rules, gemini_rules) and config targets (opencode_config, cursor_setup) are filtered by kind in the UI. Claude, Gemini, and Cursor setup targets are available but not enabled by default — enable them via target profiles or manual checkboxes. Quick-select via target profiles (OpenCode, Cursor, All rules, All supported). Profiles update the enabled target selection in the settings draft; Save is still required to persist. Profiles do not run sync or write target files. |

The settings file is created at the macOS application support path under the current user's `HOME` (`~/Library/Application Support/ai.agentworkspace.app/settings.json`). If `HOME` is unavailable, settings cannot be saved and an error is returned. Loading falls back to defaults when the file is missing or invalid.

### Target profiles

Settings includes compact target profile buttons for quick target selection:

| Profile | Enabled targets |
|---------|----------------|
| OpenCode | opencode_rules, opencode_config |
| Cursor | cursor_setup |
| All rules | codex_rules, opencode_rules, auggie_rules, claude_rules, gemini_rules |
| All supported | codex_rules, opencode_rules, auggie_rules, claude_rules, gemini_rules, opencode_config, cursor_setup |

Applying a profile updates the local settings draft target selection. The user must click Save to persist. The nav tab shows `*` and the Settings header shows "modified — save to persist" when the draft differs from saved settings. Profiles are metadata only — they do not run sync or write target files. Manual target toggles use real `<button>` elements with `aria-pressed` for keyboard accessibility; the current selection is visible via a filled check-dot indicator beyond color alone. A "custom selection" label appears when the current selection does not match any defined profile.

### Settings security

Settings are validated before save: `appearance` is enum-constrained to `dark`/`light`/`system`, `workspace_path` is trimmed and normalized. Settings do not expose the app to arbitrary command execution — all backend actions remain allowlisted. The workspace path only affects the working directory of existing allowlisted commands and cannot introduce new commands or shell execution.

The workspace creation dry-run plan (`plan_create_workspace`) is a read-only evaluation that checks whether the configured workspace path is safe and viable for initialization. It does not create directories, copy files, execute scripts, or write any user data. When the plan reports a safe status (`missing_directory` or `empty_existing_directory`), the `create_workspace_from_defaults` command copies only allowlisted bundled default files into the target. This command never overwrites existing files, never runs scripts, and never writes outside the target directory.

## App Surfaces

The app has four top-level views:

- **Workspace** — operations cockpit and app landing page. Shows workspace validity, resolved path, readiness metrics (markers, rule targets, config targets, starter resource counts), and a dynamic workspace system map. Supports path input (type, choose folder, use default), read-only dry-run create that evaluates whether the current path is safe for initialization, create workspace action for safe targets (copies bundled starter files, no overwrite, no scripts). Operations section provides: git pull, diff/sync rules, diff/sync configs, skills install (with expandable skill selector for individual skill toggles, agent toggles, scope/target selection, dry-run and install actions), release-check, and backup management. Skills install lane loads workspace skills on startup when a valid workspace is selected, auto-selects all skills by default, and distinguishes between loading, empty, and unselected states. Integrated terminal output panel. All operation actions report through a single terminal pane.
- **Library** — unified source file browser and editor. Switches between source types: Docs, Rules, Skills, Agents, Configs. Docs provides curated workspace documentation browser and editor with section groups, search, custom context doc creation, and allowlisted Cursor source assets. Rules provides global agent rules template preview/edit with per-target status. Skills provides read-only skill preview with Markdown rendering and metadata display (category, risk, targets, related skills). Agents provides agent source file list with edit/open for each, plus metadata display (role, risk, targets, default skills, runtime-sensitivity warnings). Configs provides editable OpenCode config source templates with metadata. Script-backed setup targets such as Cursor setup are run from Workspace sync actions, not edited as config templates. Library handles source editing; operations (sync, install) happen in Workspace.
- **Settings** — appearance (dark/light/system), target profiles/presets, and enabled targets separated into rule targets and config targets with real toggle buttons. Changes are stored in a local draft and marked with an unsaved-changes indicator (`*` in nav tab, "modified — save to persist" in the header). Targets do not take effect until saved. Workspace path is managed in the Workspace tab. Navigating away from unsaved Settings prompts for confirmation; returning to Settings preserves the draft until Save or Reset.
- **Brain Setup** — a focused copy-paste setup surface for external AI assistants. The page helps you generate and copy a durable prompt instruction block for ChatGPT, Claude Web, Codex, or another coding assistant. The block covers skill routing discipline, model/tool recommendations, DB/migration awareness, security rules, and verification discipline. Agent Workspace is a local macOS configuration tool — it does not automatically control external chat UIs from this view, does not run agents, does not change enabled sync targets, and does not mutate runtime config. The visible action is **copy brain setup**. Paste the block into Custom Instructions, project instructions, or the first message of a long-running assistant workspace.

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
- Supported targets: Codex rules (`.codex/AGENTS.md`), OpenCode rules (`.config/opencode/AGENTS.md`), Auggie rules (`.augment/rules/global.md`), Claude rules (`.claude/CLAUDE.md`), Gemini rules (`.gemini/GEMINI.md`), OpenCode config (`.config/opencode/opencode.json`), OpenCode TUI config (`.config/opencode/tui.json`), and Cursor setup (`.cursor/agents` via the Cursor setup script).

### Agent rule sync (scripts/install-agent-rules.sh)

`scripts/install-agent-rules.sh` syncs `templates/global-agent-rules.md` to agent-specific paths:

| Flag | Target path (with env override) |
|------|-------------------------------|
| `--codex` | `${CODEX_AGENTS_PATH:-$HOME/.codex/AGENTS.md}` |
| `--opencode` | `${OPENCODE_AGENTS_PATH:-$HOME/.config/opencode/AGENTS.md}` |
| `--auggie` | `${AUGGIE_GLOBAL_PATH:-$HOME/.augment/rules/global.md}` |
| `--claude` | `${CLAUDE_RULES_PATH:-$HOME/.claude/CLAUDE.md}` |
| `--gemini` | `${GEMINI_RULES_PATH:-$HOME/.gemini/GEMINI.md}` |

On apply, existing diverged rule targets are backed up under `~/Library/Application Support/ai.agentworkspace.app/backups` before overwrite. `AGENT_WORKSPACE_BACKUP_DIR` can override the backup root for testing or advanced local use. Diff and dry-run modes do not create backups.

## Skill installation

Skills are installed directly into native agent skill folders using local filesystem copy from the validated repo `skills/` directories. No external package managers are used for install.

Global destinations:
- Codex: `${CODEX_HOME:-$HOME/.codex}/skills` (override with `CODEX_SKILLS_PATH` or `CODEX_HOME`)
- OpenCode: `$HOME/.config/opencode/skills` (override with `OPENCODE_SKILLS_PATH`)
- Claude: `$HOME/.claude/skills` (override with `CLAUDE_SKILLS_PATH`)
- Gemini: `$HOME/.gemini/skills` (override with `GEMINI_SKILLS_PATH`)
- Cursor: `$HOME/.cursor/skills` (override with `CURSOR_SKILLS_PATH`)

Cursor project installs use `<project>/.cursor/skills`. Cursor subagents are installed by `resources/default-workspace/scripts/install-cursor-workspace.sh` to `~/.cursor/agents` or `<project>/.cursor/agents`; project rules install to `<project>/.cursor/rules/*.mdc`. Cursor User Rules are version-controlled as `templates/cursor/user-rules.md` and can be shown or copied to clipboard via `--show-user-rules` / `--copy-user-rules`; they are not auto-written because Cursor does not document a stable file-backed write target. MCP examples are opt-in and must use env placeholders for auth-like values.
- Auggie: `$HOME/.augment/skills` (override with `AUGGIE_SKILLS_PATH`)

## Workspace Contract Validator

The app includes a read-only Workspace Contract Validator that checks an active workspace against the public app contract. It validates skills, agent metadata, and agents without executing scripts or modifying files.

### What it checks

| Check | Description |
|-------|-------------|
| Workspace root | Resolves and verifies `.agent-workspace/workspace.json` exists |
| Skills directory | `skills/` exists and contains root-level skills at `skills/<skill>/SKILL.md` |
| Skill metadata | Every `SKILL.md` has required `name` and `description` fields |
| Skill uniqueness | No duplicate skill names (deterministic failure) |
| Legacy skills | No legacy nested skills at `skills/<group>/<skill>/SKILL.md` (fails — public contract is root-level only; nested skills are ignored by skill discovery) |
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
- Install or sync from Brain Setup.
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
│   │   ├── WorkspaceView.tsx    Workspace operations cockpit and skills install selector
│   │   ├── LibraryView.tsx      Unified source browser/editor (Docs, Rules, Skills, Agents, Configs)
│   │   ├── RoutingView.tsx      Brain Setup copy-paste surface
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
