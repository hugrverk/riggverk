# Agent Workspace App

Local macOS control panel for skills, rules, config, and workflow sync.

## Purpose

Thin GUI wrapper around the existing workspace scripts. Scripts remain the source of truth. The app does not reimplement script logic.

App-triggered script actions use each script's `--quiet` option for compact terminal output. Running the scripts manually without `--quiet` keeps the more verbose CLI/debug output.

## Views

Top-level views are:

- **Agents** — agent rule sync/status/log with side-panel repo status, rule actions, and rule target state. Includes a link to the standalone global agent rules template viewer. Does not include tool configs or skills.
- **Skills** — repo skill catalog, skill selection, multi-agent select, dry-run/install controls, and install output.
- **Configs** — joined two-column frame for tool config management. Left: OpenCode config template/viewer (~60%). Right: local config terminal/output (~40%). Includes header with status, diff/sync actions, and open button. Config actions do not navigate away — output stays in the right pane.
- **Health** — read-only release-check runner for `scripts/release-check.sh`, with local terminal output and backup history. Does not run automatically.
- **Docs** — workspace documentation browser only. No templates or configs.
- **Settings** — appearance, workspace path (type or pick folder; choosing updates the draft, Save persists it), target profiles/presets, and enabled targets separated into rule targets and config targets. Shows workspace diagnostics (validity and missing markers) near the workspace path input. Includes a read-only bundled default workspace preview with resource categories and known file paths. Includes a read-only workspace creation dry-run plan that evaluates whether the current workspace path draft is a good target for initialization. When the plan reports a safe status (missing or empty directory), a "create workspace" button appears to copy bundled default files into the target — no overwrite, no script execution.

### Agent Rules Template

A standalone read-only view for `templates/global-agent-rules.md`, accessible via the "global rules" button at the bottom of the Agents side panel. Renders the template using the existing markdown viewer with an "open in editor" button. Not a top-level nav tab.

## Prerequisites

- Node.js 20+
- npm 10+
- Rust (stable toolchain via rustup)
- macOS (uses `/usr/bin/open` for doc actions and `bash` for scripts)

## Local dev

```bash
cd apps/ux-workspace-app
npm install
npm run tauri dev
```

## Build

```bash
cd apps/ux-workspace-app
npm install
npm run tauri build
```

The built `.app` bundle will be in `src-tauri/target/release/bundle/macos/`.

## Workspace

The app operates on a workspace folder — a user-owned data directory containing configuration, docs, skills, templates, and scripts. The workspace folder is not the app source checkout.

Workspace validation uses `.ux-workspace/workspace.json` and required workspace markers (scripts, templates, README, skills directory). The `apps/ux-workspace-app` directory is no longer required inside the selected workspace.

This repository is the public app source repo. User workspace content lives in separate user-owned workspace folders outside this checkout.

Some internal package, crate, marker, settings, and bundle identifiers still use `ux-workspace` names during transition. Those identifiers are intentionally not renamed in this slice.

See [docs/WORKSPACE_CONTRACT.md](../../docs/WORKSPACE_CONTRACT.md) for the full workspace contract.

The app source includes a generic starter workspace under `apps/ux-workspace-app/resources/default-workspace/` with bundled default templates, scripts, docs, starter skills, and a workspace marker. These resources are bundled into the macOS app bundle as Tauri resources and are available in the installed app. They are also available in dev/source checkout mode.

Bundled defaults are read-only source material previewed in Settings. They can be applied to create a new workspace via the "create workspace" button, which copies bundled default files into a safe empty or missing target directory. Create does not overwrite existing files, does not run scripts, and only accepts targets that pass the planner safety checks.

### Workspace path

The workspace root is resolved in order of precedence:

1. **Settings**: `workspace_path` in app settings (if set to a non-empty string).
2. **Environment**: `UX_WORKSPACE_PATH` environment variable.
3. **Default**: built-in fallback path (`~/Projects/ux-workspace`).

Set a custom workspace path in the Settings view (type manually or use **choose folder** to pick via a native directory picker), or override temporarily with the environment variable during dev. Settings shows workspace diagnostics (validity and missing markers) so invalid workspace paths are visible immediately.

A custom workspace path only changes the working directory for existing allowlisted commands (`git_pull`, `bootstrap_*`, `verify_state`, `sync_agent_rules`, etc.) — it does not add or change any allowed commands.

## Settings

Settings are stored as JSON at `~/Library/Application Support/ai.openworkspace.ux-workspace/settings.json` (macOS) and persist across app restarts.

### Available settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `appearance` | `"dark"` `"light"` `"system"` | `"dark"` | Theme mode. `system` follows the OS colour scheme via `prefers-color-scheme`. |
| `workspace_path` | `string` or `null` | `null` | Custom workspace root path. When `null` or missing, falls back to `UX_WORKSPACE_PATH` env or built-in default. Whitespace-only values are saved as `null`. |
| `enabled_target_ids` | `string[]` | `["codex_rules","opencode_rules","auggie_rules","opencode_config"]` | Which agent and config targets are enabled for status checks and sync. Rule targets (codex_rules, opencode_rules, auggie_rules, claude_rules, gemini_rules) and config targets (opencode_config) are filtered by kind in the UI. Claude and Gemini rule targets are available but not enabled by default — enable them via target profiles or manual checkboxes. Quick-select via target profiles (OpenCode, All rules, All supported). Profiles update the enabled target selection in the settings draft; Save is still required to persist. Profiles do not run sync or write target files. |

The settings file is created at the macOS application support path under the current user's `HOME` (`~/Library/Application Support/ai.openworkspace.ux-workspace/settings.json`). If `HOME` is unavailable, settings cannot be saved and an error is returned. Loading falls back to defaults when the file is missing or invalid.

### Target profiles

Settings includes compact target profile buttons for quick target selection:

| Profile | Enabled targets |
|---------|----------------|
| OpenCode | opencode_rules, opencode_config |
| All rules | codex_rules, opencode_rules, auggie_rules, claude_rules, gemini_rules |
| All supported | codex_rules, opencode_rules, auggie_rules, claude_rules, gemini_rules, opencode_config |

Applying a profile updates the local settings draft target selection. The user must click Save to persist. Profiles are metadata only — they do not run sync or write target files. Manual checkboxes remain available and show a "custom" label when the current selection does not match any of the defined profiles.

### Settings security

Settings are validated before save: `appearance` is enum-constrained to `dark`/`light`/`system`, `workspace_path` is trimmed and normalized. Settings do not expose the app to arbitrary command execution — all backend actions remain allowlisted. The workspace path only affects the working directory of existing allowlisted commands and cannot introduce new commands or shell execution.

The workspace creation dry-run plan (`plan_create_workspace`) is a read-only evaluation that checks whether the configured workspace path is safe and viable for initialization. It does not create directories, copy files, execute scripts, or write any user data. When the plan reports a safe status (`missing_directory` or `empty_existing_directory`), the `create_workspace_from_defaults` command copies only allowlisted bundled default files into the target. This command never overwrites existing files, never runs scripts, and never writes outside the target directory.

## Security model

- Frontend requests only named actions. No arbitrary commands, paths, or arguments pass from frontend to backend.
- Backend maps named actions to fixed commands via `std::process::Command` with explicit program and args.
- No shell string concatenation. No `sh -c`. No Tauri shell plugin.
- Sync targets are defined through an internal agent target registry (`agent_targets.rs`). This does not permit arbitrary file sync or arbitrary commands.
- Config sync targets are managed through an internal allowlisted config target registry (also in `agent_targets.rs`). Config scripts are mapped by enum, not by frontend-supplied paths.
- Supported targets: Codex rules (`.codex/AGENTS.md`), OpenCode rules (`.config/opencode/AGENTS.md`), Auggie rules (`.augment/rules/global.md`), Claude rules (`.claude/CLAUDE.md`), Gemini rules (`.gemini/GEMINI.md`), OpenCode config (`.config/opencode/opencode.json`).
- Allowed actions:

### Status
- `get_status` — repo path, branch, dirty state, latest commit, sync status for five agent rule targets and OpenCode config, plus separated `enabled_rule_target_ids` and `enabled_config_target_ids`

### Agents
- Main terminal/log output for the most recent agent action.
- Right-side control panel with repo status (repo path, commit, branch, dirty state, rule sync count).
- Action groups: repo (pull, verify) and rules (diff, sync).
- Verify compares enabled rule targets only. Config drift is handled in the Configs view.
- Agent rule targets list with per-target sync status. Config targets are tracked separately in the Configs view.
- Bootstrap actions remain available as backend commands but are not part of the primary app UI.
- Script stdout/stderr is displayed exactly as returned by the backend; the frontend does not filter or parse terminal output.

### Skills
- Available repo skills list with selection controls.
- Native agent multi-select: toggle codex, opencode, claude, gemini, auggie independently. At least one agent must be selected.
- Scope selector: `global` or `project`.
- Dry-run and install selected actions call the existing `install_skills` backend command.
- Project target validation is enforced in the backend and script. Project installs require a non-empty target path that looks like a real project checkout.

### Skill installation

Skills are installed directly into native agent skill folders using local filesystem copy from the validated repo `skills/` directories. No external package managers are used for install.

Global destinations:
- Codex: `${CODEX_HOME:-$HOME/.codex}/skills` (override with `CODEX_SKILLS_PATH` or `CODEX_HOME`)
- OpenCode: `$HOME/.config/opencode/skills` (override with `OPENCODE_SKILLS_PATH`)
- Claude: `$HOME/.claude/skills` (override with `CLAUDE_SKILLS_PATH`)
- Gemini: `$HOME/.gemini/skills` (override with `GEMINI_SKILLS_PATH`)
- Auggie: `$HOME/.augment/skills` (override with `AUGGIE_SKILLS_PATH`)

Project destinations:
- Codex: `<project>/.codex/skills`
- OpenCode: `<project>/.opencode/skills`
- Claude: `<project>/.claude/skills`
- Gemini: `<project>/.gemini/skills`
- Auggie: `<project>/.augment/skills`

`.agents/skills` is not managed by this app. The app does not install to, scan, migrate, delete, or summarize `.agents/skills`. App-triggered bootstrap skips skills entirely — skills installation is owned by the Skills view. Manual `scripts/bootstrap.sh` may still run skills unless `--skip-skills` is passed.

Project targets are canonicalized and must contain at least one supported project marker: `.git`, `package.json`, `Cargo.toml`, `composer.json`, `pyproject.toml`, `AGENTS.md`, `.opencode`, `.codex`, `wp-content`, or `wordpress/wp-content`. Broad parent targets such as `/`, `/Users`, `$HOME`, `$HOME/Projects`, and the system temp root are rejected.

Output modes:
- `--quiet` prints compact per-agent summary rows (planned/installed counts, skill names for small sets). Source and destination paths are omitted on success.
- Verbose CLI mode (no `--quiet`) prints detailed per-skill progress with source and destination paths.

### CLI agent selection (scripts/install-skills.sh)

The script supports repeated `--agent` flags for direct multi-agent selection:

```
./scripts/install-skills.sh --agent opencode --agent auggie --global
```

Backward-compatible aliases `both` (codex + opencode) and `all` (codex + opencode + auggie) remain supported:

```
./scripts/install-skills.sh --agent both --global
./scripts/install-skills.sh --agent all --global
```
- On failure, quiet mode prints the failing agent, skill name, source path, and destination path so copy errors remain diagnosable.

### Configs
- Joined two-column frame: OpenCode config template/viewer on the left, local config terminal on the right.
- Header shows config target name and live sync status (synced/diverged/missing).
- Actions: diff (read-only) and sync (apply) via the allowlisted config target registry.
- Config actions write output to the right-pane terminal and do not navigate away.
- `open` button opens `templates/opencode.json` in the system editor.
- Config targets are defined in an internal allowlisted registry (`agent_targets.rs`). Currently only OpenCode config is managed.
- Future config targets should be added via registry entry + allowlisted script handling. No arbitrary config paths are accepted.

### Health
- Runs `scripts/release-check.sh` through the allowlisted `release_check` action.
- The check is read-only: it does not run apply commands, install skills, or write user config folders.
- Output stays in the Health terminal and does not reuse Agents, Configs, or Skills terminal state.
- Manual GUI smoke remains separate; see [docs/RELEASE.md](../../docs/RELEASE.md). For app release smoke, see [docs/APP_RELEASE_SMOKE.md](../../docs/APP_RELEASE_SMOKE.md).
- Shows read-only backup history from the script backup directory. Lists recent backup runs without reading file contents. Can open the backup folder in Finder. The backup folder is never created by viewing Health. Backup creation remains script-owned during `--apply` overwrite.
- Selecting a backup run shows read-only backup details: target id, filename, backup file size, and current target status (missing/matches/differs/unknown). The app does not show file contents or textual diffs. The app does not restore backups. Current target status is metadata-only, computed by comparing file sizes and byte equality without exposing contents.
- Includes a read-only workspace validation panel that checks the configured workspace path against required markers (scripts, templates, directories) without running scripts or reading file contents. Shows missing markers, enabled rule/config target counts, and backup root status. Works for invalid workspace paths without executing anything.

### Actions
- `git_pull` — `git pull --ff-only`
- `verify_state` — file comparison between `templates/global-agent-rules.md` and enabled rule target paths only. If no rule targets are enabled, returns `no enabled rule targets` with success.
- `diff_agent_rules` — read-only diff via `bash scripts/install-agent-rules.sh --quiet --diff` with explicit flags for enabled rule targets only. No files are written.
- `sync_agent_rules` — `bash scripts/install-agent-rules.sh --quiet --apply` with explicit flags for enabled rule targets only. If no rule targets are enabled, returns `no enabled rule targets` with success. Existing diverged targets are backed up before overwrite.
- `diff_configs` — read-only diff for all enabled config targets via the allowlisted config target registry.
- `sync_configs` — apply for all enabled config targets via the allowlisted config target registry. Existing diverged targets are backed up before overwrite.
- `release_check` — read-only release verification via `bash scripts/release-check.sh` with no frontend-supplied args.
- `bootstrap_*` — bootstrap preview/diff/apply actions remain available on the backend for CLI use but are not part of the primary app UI. They pass `--skip-skills` and respect enabled rule target settings.

### Agent rule sync (scripts/install-agent-rules.sh)

`scripts/install-agent-rules.sh` syncs `templates/global-agent-rules.md` to agent-specific paths:

| Flag | Target path (with env override) |
|------|-------------------------------|
| `--codex` | `${CODEX_AGENTS_PATH:-$HOME/.codex/AGENTS.md}` |
| `--opencode` | `${OPENCODE_AGENTS_PATH:-$HOME/.config/opencode/AGENTS.md}` |
| `--auggie` | `${AUGGIE_GLOBAL_PATH:-$HOME/.augment/rules/global.md}` |
| `--claude` | `${CLAUDE_RULES_PATH:-$HOME/.claude/CLAUDE.md}` |
| `--gemini` | `${GEMINI_RULES_PATH:-$HOME/.gemini/GEMINI.md}` |

Options: `--apply` (write files), `--diff` (show diffs), `--all` (select all targets — default).

The script also supports `--quiet` for app-friendly output. Quiet mode changes reporting only: compact headers and target rows replace verbose source/path/status blocks. It does not change target selection, write behavior, diff behavior, or safety checks.

On apply, existing diverged rule targets are backed up under `~/Library/Application Support/ai.openworkspace.ux-workspace/backups` before overwrite. `UX_WORKSPACE_BACKUP_DIR` can override the backup root for testing or advanced local use. Diff and dry-run modes do not create backups.

Claude and Gemini support is file sync only: no CLI execution, no model configuration, no secrets, no arbitrary command execution.

### Bootstrap and enabled targets

App-triggered bootstrap actions (`preview`, `diff`, `apply`) respect `enabled_target_ids` settings. They pass explicit rule target flags (e.g. `--codex`, `--opencode`) to `scripts/bootstrap.sh`, or `--skip-rules` when no rule targets are enabled. Disabled targets (Claude/Gemini by default) are not written to disk by app-triggered bootstrap.

App-triggered bootstrap always passes `--skip-skills`. Skills installation is owned by the Skills view, which calls `install_skills` directly. This keeps app-triggered bootstrap fast and avoids redundant skill installations.

Direct CLI use of `scripts/bootstrap.sh` does not pass `--skip-skills` by default. Running `scripts/bootstrap.sh --apply` from the terminal still runs the full bootstrap including skills unless the user explicitly passes `--skip-skills`.

Quiet mode (`--quiet`) suppresses child step output on success for compact app display. On failure, quiet mode prints the captured child stdout and stderr so errors remain diagnosable.

`scripts/bootstrap.sh`, `scripts/install-skills.sh`, `scripts/install-agent-rules.sh`, and `scripts/install-opencode-config.sh` support `--quiet` for compact app output. The app passes `--quiet` for script actions, while manual CLI runs without `--quiet` preserve verbose command-oriented output for debugging. The output mode does not affect sync semantics, bootstrap semantics, install behavior, enabled-target behavior, or filesystem writes.

Apply actions for rules and OpenCode config print backup paths when an existing diverged target is overwritten. The app displays that script output directly.

### Docs
- Curated workspace documentation browser grouped by section (Start, Reference, Operating Model, Private / Operator, Development).
- Only known doc ids from the curated registry are shown — not every `.md` file in `docs/`.
- Docs are read from the validated active workspace. Missing optional docs are skipped.
- `list_docs` returns curated doc summaries with section metadata.
- `read_doc` renders the selected Markdown file.
- `open_doc` opens the selected file in the system editor.
- The Global Agent Rules template remains separate in the Agents view.
- Templates and configs remain in their own views.

Unknown actions return an error. No command is executed for unknown actions.

The UI information architecture groups existing surfaces only. No backend command behavior, script behavior, settings semantics, sync semantics, bootstrap semantics, or install semantics are changed by the app layout.

## Architecture

```
apps/ux-workspace-app/
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
│   │   ├── status.ts     Status count and class-name helpers
│   │   └── timing.ts     Small timing helpers
│   ├── views/
│   │   ├── AgentRulesView.tsx Global agent rules template view
│   │   ├── AgentsView.tsx Agents status, actions, and terminal view
│   │   ├── ConfigsView.tsx Config management view
│   │   ├── DocsView.tsx  Workspace docs browser
│   │   ├── HealthView.tsx Release-check view
│   │   ├── SettingsView.tsx Settings view
│   │   └── SkillsView.tsx Skill catalog and install view
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
        │   ├── content.rs  Docs/templates/config content commands
        │   ├── process.rs  Command result and process helpers
        │   ├── settings_commands.rs Settings and target commands
        │   ├── skills.rs   Skill listing/install commands
        │   ├── status.rs   Workspace status command
        │   └── workspace.rs Workspace path validation helpers
        ├── agent_targets.rs Agent sync target registry
        └── settings.rs     Persistent app settings (JSON)
```
