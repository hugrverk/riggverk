# Agent Workspace App

Local macOS control panel for skills, rules, config, and workflow sync.

## Purpose

Thin GUI wrapper around the existing workspace scripts. Scripts remain the source of truth. The app does not reimplement script logic.

App-triggered script actions use each script's `--quiet` option for compact terminal output. Running the scripts manually without `--quiet` keeps the more verbose CLI/debug output.

## Views

Top-level views are:

- **Workspace** — app landing cockpit. Shows workspace validity, resolved path, readiness metrics (markers, rule targets, config targets, starter resource counts), and a dynamic workspace system map. Supports path input (type, choose folder, use default), read-only dry-run create that evaluates whether the current path is safe for initialization, create workspace action for safe targets (copies bundled starter files, no overwrite, no scripts), and read-only bundled starter preview with resource categories and file paths.
- **Rules** — global agent rules template preview, edit, and save, rule target status with per-target sync state, diff/sync actions, repo status, and integrated terminal output. Rule targets are registry-driven. Save edits the workspace source template only. Sync applies the template to installed rule targets — these are separate actions. Does not include tool configs or skills.
- **Skills** — repo skill catalog with filterable skill browser (text search and optional area chips), in-app skill preview with Markdown rendering (read-only, registry-allowlisted), multi-agent select, dry-run/install controls, install plan summary with disabled-state warnings, and install output.
- **Configs** — joined two-column frame for config template management. Top: compact config target selector showing each target's label, sync status, and source path. Left: selected config template preview/edit with metadata rows (source template path, installed target path), mode tabs (preview/edit), and save/reset controls. Right: local config terminal/output (~40%). Config targets are registry-driven via `agent_targets::config_sync_targets()`. Includes header with per-target status, diff/sync actions, and open button. Config template save validates JSON and writes only the workspace source template — save is separate from sync. Config actions do not navigate away — output stays in the right pane. The target selector is visible even when only one config target exists, keeping the UI shape ready for additional targets. Currently supported config target: OpenCode config (`opencode_config`). Future config targets should be added via the registry + allowlisted script handling; no arbitrary config paths are accepted.
- **Health** — read-only release-check runner for `scripts/release-check.sh`, with local terminal output and backup history. Does not run automatically. Shows a compact workspace validity note when no valid workspace is selected. Backup list is metadata-only — no restore, delete, or file-open actions. Selecting a backup run shows read-only file-level metadata (target id, filename, size, current status) without exposing file contents.
- **Docs** — workspace documentation browser and editor for curated and custom context docs. No templates or configs.
- **Settings** — appearance (dark/light/system), target profiles/presets, and enabled targets separated into rule targets and config targets with real toggle buttons. Changes are stored in a local draft and marked with an unsaved-changes indicator (`*` in nav tab, "modified — save to persist" in the header). Targets do not take effect until saved. Includes a compact note that workspace path is managed in the Workspace tab. Navigating away from unsaved Settings prompts for confirmation; returning to Settings preserves the draft until Save or Reset.

### Agent Rules Template

The global agent rules template (`templates/global-agent-rules.md`) is rendered inline in the Rules view with preview/edit mode toggle, a textarea editor with save/reset controls, a dirty state indicator, and an "open" button to open the template in the system editor. Save writes only the workspace source template via the allowlisted `save_agent_template` command; it does not sync installed rule targets. Sync is a separate action triggered by the diff/sync buttons in the rules sidebar. The template loads automatically when the Rules tab is active.

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

Bundled defaults are read-only source material previewed in the Workspace tab. They can be applied to create a new workspace via the "create workspace" button, which copies bundled default files into a safe empty or missing target directory. Create does not overwrite existing files, does not run scripts, and only accepts targets that pass the planner safety checks.

### Workspace path

The workspace root is resolved in order of precedence:

1. **Settings**: `workspace_path` in app settings (if set to a non-empty string).
2. **Environment**: `UX_WORKSPACE_PATH` environment variable.
3. **Default**: built-in fallback path (`~/Projects/ux-workspace`).

Set a custom workspace path in the Workspace tab (type manually or use **choose folder** to pick via a native directory picker), or override temporarily with the environment variable during dev. The Workspace tab shows diagnostics (validity and missing markers) so invalid workspace paths are visible immediately.

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

Applying a profile updates the local settings draft target selection. The user must click Save to persist. The nav tab shows `*` and the Settings header shows "modified — save to persist" when the draft differs from saved settings. Profiles are metadata only — they do not run sync or write target files. Manual target toggles use real `<button>` elements with `aria-pressed` for keyboard accessibility; the current selection is visible via a filled check-dot indicator beyond color alone. A "custom selection" label appears when the current selection does not match any defined profile.

### Settings security

Settings are validated before save: `appearance` is enum-constrained to `dark`/`light`/`system`, `workspace_path` is trimmed and normalized. Settings do not expose the app to arbitrary command execution — all backend actions remain allowlisted. The workspace path only affects the working directory of existing allowlisted commands and cannot introduce new commands or shell execution.

The workspace creation dry-run plan (`plan_create_workspace`) is a read-only evaluation that checks whether the configured workspace path is safe and viable for initialization. It does not create directories, copy files, execute scripts, or write any user data. When the plan reports a safe status (`missing_directory` or `empty_existing_directory`), the `create_workspace_from_defaults` command copies only allowlisted bundled default files into the target. This command never overwrites existing files, never runs scripts, and never writes outside the target directory.

### Docs security

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
- Supported targets: Codex rules (`.codex/AGENTS.md`), OpenCode rules (`.config/opencode/AGENTS.md`), Auggie rules (`.augment/rules/global.md`), Claude rules (`.claude/CLAUDE.md`), Gemini rules (`.gemini/GEMINI.md`), OpenCode config (`.config/opencode/opencode.json`).
- Allowed actions:

### Status
- `get_status` — repo path, branch, dirty state, latest commit, sync status for five agent rule targets and all registered config targets (via `config_statuses` map keyed by target id), plus separated `enabled_rule_target_ids` and `enabled_config_target_ids`

### Rules
- Global agent rules template with preview/edit/save/reset via the allowlisted `save_agent_template` command, plus an "open" button.
- `save_agent_template` resolves the template path internally as `templates/global-agent-rules.md` under the validated workspace root and accepts no frontend-supplied paths.
- Save writes only the workspace source template; it does not sync installed rule targets. Sync is a separate action.
- Terminal/log output for the most recent rule action.
- Right-side control panel with repo status (repo path, commit, branch, dirty state, rule sync count).
- Action groups: repo (pull, verify) and rules (diff, sync).
- Verify compares enabled rule targets only. Config drift is handled in the Configs view.
- Rule targets list with per-target sync status. Config targets are tracked separately in the Configs view.
- Bootstrap actions remain available as backend commands but are not part of the primary app UI.
- Script stdout/stderr is displayed exactly as returned by the backend; the frontend does not filter or parse terminal output.

### Skills
- Available repo skills list with text search filtering (name, id, area, description) and optional per-area chips when multiple areas exist.
- In-app skill preview with Markdown rendering (read-only, registry-allowlisted lookup — no arbitrary file paths accepted).
- Skill selection (toggle button) is independent from preview selection (row button).
- Install plan summary showing selected skills count, agent count in preferred order, scope, and project target.
- Native agent multi-select: toggle codex, opencode, claude, gemini, auggie independently. At least one agent must be selected.
- Scope selector: `global` or `project`.
- Dry-run and install selected actions call the existing `install_skills` backend command.
- Project target validation is enforced in the backend and script. Project installs require a non-empty target path that looks like a real project checkout.
- Five install targets remain unchanged; no new install destinations added.

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

`--all` installs all available workspace skills. It is a skill scope flag, not an agent alias.

- On failure, quiet mode prints the failing agent, skill name, source path, and destination path so copy errors remain diagnosable.

### Configs
- Configs is registry-driven via `agent_targets::config_sync_targets()`.
- Config target selector shows all registered config targets with label, sync status, and source path. The selector is visible even when only one config target exists.
- Joined two-column frame: selected config template editor on the left, local config terminal on the right.
- Header shows config target name and live sync status (synced/diverged/missing).
- Metadata rows show source template path and installed target path for the selected target.
- Currently supported config target: OpenCode config (`opencode_config`).
- Actions: diff (read-only) and sync (apply) via the allowlisted config target registry.
- Config actions write output to the right-pane terminal and do not navigate away.
- `open` button opens the selected config template in the system editor.
- Preview/edit mode toggle: preview shows formatted JSON; edit shows a textarea editor with save and reset controls.
- `save_config_template` validates JSON for the opencode_config target. Unknown targets and malformed JSON are rejected.
- Config template save writes only the workspace source template (`templates/opencode.json`), not the installed target path.
- Save is separate from sync: save edits the template; sync applies changes to the installed config target.
- Config targets are defined in an internal allowlisted registry. Currently only OpenCode config is managed.
- Future config targets should be added via registry entry + allowlisted script handling. No arbitrary config paths are accepted.

### Health
- Runs `scripts/release-check.sh` through the allowlisted `release_check` action.
- The check is read-only: it does not run apply commands, install skills, or write user config folders.
    - Output stays in the Health terminal and does not reuse Rules, Configs, or Skills terminal state.
- Manual GUI smoke remains separate; see [docs/RELEASE.md](../../docs/RELEASE.md). For app release smoke, see [docs/APP_RELEASE_SMOKE.md](../../docs/APP_RELEASE_SMOKE.md).
- Shows read-only backup history from the script backup directory. Lists recent backup runs without reading file contents. Can open the backup folder in Finder. The backup folder is never created by viewing Health. Backup creation remains script-owned during `--apply` overwrite.
- Selecting a backup run shows read-only backup details: target id, filename, backup file size, and current target status (missing/matches/differs/unknown). The app does not show file contents or textual diffs. The app does not restore backups. Current target status is metadata-only, computed by comparing file sizes and byte equality without exposing contents.
- Workspace validation and diagnostics are managed in the Workspace tab.

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
- Curated workspace documentation browser and editor grouped by section (Start, Reference, Operating Model, Private / Operator, Development, Context).
- Two-pane cockpit layout: left nav with sectioned doc buttons, right Markdown preview or edit pane.
- Compact command strip with text search (filters by title, id, path, section) and doc count summary.
- Active doc persists across view switches when the doc remains available.
- Doc rows are real `<button>` elements with visible focus and active state indicators.
- Only known doc ids from the curated registry and user context docs (`docs/context/`) are shown — not every `.md` file in `docs/`.
- Users can create custom context docs under `docs/context/` via the "+ new" button. Custom doc filenames are strict slugs (`^[a-z0-9][a-z0-9-]*$`), stored at `docs/context/<slug>.md`. No subdirectories, no recursion. The title is persisted as a Markdown H1 (`# Title`) in the document content; when absent, the title falls back to the slug-derived name.
- Docs are read from the validated active workspace. Missing optional docs are skipped.
- `list_docs` returns curated doc summaries plus custom context docs with section metadata.
- `read_doc` renders the selected Markdown file for both curated and custom doc ids.
- `save_doc` writes the selected allowlisted doc only. Unknown doc ids and invalid custom slugs are rejected. No arbitrary file paths are accepted.
- `create_doc` creates a new custom doc under `docs/context/`. Rejects existing files and invalid slugs.
- Existing content is backed up before overwrite when the content has changed. Unchanged content does not write.
- `open_doc` opens the selected file in the system editor for both curated and custom docs.
- Preview/edit mode toggle: preview renders Markdown; edit shows a plain textarea with save and reset controls.
- Dirty state indicator shows when the draft differs from the saved file.
- Custom docs show a "context" badge in the nav list and "context" source tag in the preview header.
- The Global Agent Rules template is rendered inline in the Rules view.
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
│   │   ├── editorGuards.ts  Dirty editor guard helpers
│   │   ├── settingsDraft.ts  Settings defaults and comparison
│   │   ├── status.ts     Status count and class-name helpers
│   │   ├── timing.ts     Small timing helpers
│   │   └── useBackups.ts  Backup state hook
│   ├── views/
│   │   ├── RulesView.tsx Rules template preview, edit, save, status, actions, terminals, and targets
│   │   ├── ConfigsView.tsx Config template editor and management view
│   │   ├── DocsView.tsx  Workspace docs browser and editor
│   │   ├── HealthView.tsx Release-check view
│   │   ├── SettingsView.tsx Settings view
│   │   ├── SkillsView.tsx  Skill catalog and install view
│   │   └── WorkspaceView.tsx Workspace setup view
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
