# Agent Workspace App

Local macOS control panel for skills, rules, config, and workflow sync.

## Purpose

Thin GUI wrapper around the existing workspace scripts. Scripts remain the source of truth. The app does not reimplement script logic.

App-triggered script actions use each script's `--quiet` option for compact terminal output. Running the scripts manually without `--quiet` keeps the more verbose CLI/debug output.

## Views

The app has four top-level views:

- **Workspace** — operations cockpit and app landing page. Shows workspace validity, resolved path, readiness metrics (markers, rule targets, config targets, starter resource counts), and a dynamic workspace system map. Supports path input (type, choose folder, use default), read-only dry-run create that evaluates whether the current path is safe for initialization, create workspace action for safe targets (copies bundled starter files, no overwrite, no scripts). Operations section provides: git pull, diff/sync rules, diff/sync configs, skills install (with expandable skill selector for individual skill toggles, agent toggles, scope/target selection, dry-run and install actions), release-check, and backup management. Integrated terminal output panel. All operation actions report through a single terminal pane.
- **Library** — unified source file browser and editor. Switches between source types: Docs, Rules, Skills, Agents, Configs. Docs provides curated workspace documentation browser and editor with section groups, search, and custom context doc creation. Rules provides global agent rules template preview/edit with per-target status. Skills provides read-only skill preview with Markdown rendering and metadata display (category, risk, targets, related skills). Agents provides agent source file list with edit/open for each, plus metadata display (role, risk, targets, default skills, runtime-sensitivity warnings). Configs provides config template preview/edit per target with metadata. Library handles source editing; operations (sync, install) happen in Workspace.
- **Settings** — appearance (dark/light/system), target profiles/presets, and enabled targets separated into rule targets and config targets with real toggle buttons. Changes are stored in a local draft and marked with an unsaved-changes indicator (`*` in nav tab, "modified — save to persist" in the header). Targets do not take effect until saved. Workspace path is managed in the Workspace tab. Navigating away from unsaved Settings prompts for confirmation; returning to Settings preserves the draft until Save or Reset.
- **Routing** — operator guidance view with edit support. Displays routing profiles from an optional `routing/profiles.json` sidecar file in the workspace. Each profile recommends tool/model/skill/agent combinations for specific task types. Profiles are purely informational operator guidance — they do not affect agent runtime behavior, do not run agents, and do not change OpenCode/Codex/Claude/Gemini/Auggie configuration. Missing `routing/profiles.json` is handled gracefully. Profile references to skills or agent files not present in the workspace are surfaced as non-blocking validation warnings. Skill metadata (category, risk, targets) is displayed as compact chips next to each referenced skill when available. Target compatibility and risk mismatch warnings are surfaced from skill metadata. A resource compatibility overview table shows skills, agents, profiles, and warning counts per target tool. A "copy metadata block" action copies operator metadata for clipboard use without generating a full prompt. **Routing profiles can now be edited and saved directly from the app.** An edit JSON mode provides a full text editor for `routing/profiles.json`. A template insert control helps add new profile stubs (generic-codex-review, generic-opencode-implementation, frontend-ui, security-review) without manual JSON construction. Save validates JSON before writing, rejects oversized content (>256 KB), backs up the existing file before overwrite, and only writes to the fixed `routing/profiles.json` path under the validated workspace root — no arbitrary file paths are accepted. **Unsaved routing edits are protected by a top-level navigation guard.** Navigating away from Routing with unsaved JSON changes prompts for confirmation, and the Routing nav tab shows a dirty indicator (orange dot). **The editor includes format and validate buttons** for JSON ergonomics. Format pretty-prints valid JSON; validate checks structure locally without writing. Missing `routing/profiles.json` initializes the editor with an empty profiles draft (`{"profiles": []}`) for quick start. Duplicate profile ids are blocked during template insertion. Routing is safe to omit.

### Routing profiles

`routing/profiles.json` is an optional workspace sidecar file. Each profile includes:
- `id`, `title`, `description` — profile identity
- `target_tool` — recommended coding tool (e.g. `opencode`, `codex`)
- `recommended_model` — recommended model
- `db_migration` — whether the profile assumes DB changes (`YES`/`NO`)
- `risk` — operator risk level (`low`/`medium`/`high`)
- `skills` — recommended skill names matching workspace skill sources
- `agent_profile` — optional recommended agent source file (e.g. `security-auditor.md`)
- `notes` — free-form operator guidance notes

The file can be edited and saved from the Routing view:
- **Preview mode** shows the profile matrix, details, and validation warnings (read-only operator guidance).
- **Edit JSON mode** provides a raw JSON textarea editor with save/reset/format/validate controls.
- **Format JSON** parses and pretty-prints the current draft (`JSON.stringify(value, null, 2)`). Invalid JSON shows an error without mutating the draft.
- **Validate JSON** parses the draft locally and reports structure validity without writing. Does not call the backend.
- **Template insertion** — compact buttons (generic-codex-review, generic-opencode-implementation, frontend-ui, security-review) append a new profile object to the `profiles` array when the JSON is valid. Duplicate profile ids are rejected with a clear error. Template buttons are disabled when the JSON is not parseable.
- **Missing file handling** — when `routing/profiles.json` is missing and edit mode opens, the editor initializes with `{"profiles": []}`. No file is written until the user saves.
- **Save validation** — JSON is validated against the profile schema before writing. Invalid JSON is rejected with a backend error. Content is capped at 256 KB. The existing file is backed up under the standard backup root before overwrite when content changes. Unchanged content returns "unchanged" without writing.
- **Dirty state protection** — unsaved edits show a dirty indicator on the Routing nav tab. Navigating away from Routing with unsaved JSON prompts for confirmation.
- **No arbitrary paths** — the frontend never supplies a file path. The backend always writes to the fixed `routing/profiles.json` under the validated workspace root.

The file is operator guidance only. It does not:
- Run agents or trigger tool actions
- Change OpenCode config behavior
- Modify skill install destinations or sync semantics
- Affect enabled target selection or settings

Profiles may reference skills or agent files that are not present in the current workspace. Missing references are displayed as non-blocking validation warnings in the UI. A "copy metadata block" button copies a plain-text operator summary (target tool, model, DB/migration, risk, skills, agent profile, routing profile id) without generating a full prompt.

Validation warnings are surfaced for common configuration mistakes:
- Duplicate profile ids
- Invalid `risk` values (must be `low`, `medium`, or `high`)
- Invalid `db_migration` values (must be `NO`, `YES`, or `POSSIBLE`)
- Unknown `target_tool` values (must be `codex`, `opencode`, `claude`, `gemini`, or `auggie`)
- OpenCode-targeted profiles using GPT model names instead of OpenCode model ids (e.g. `opencode-go/deepseek-v4-pro`)
- Codex-targeted profiles using OpenCode model ids

### Agent Rules Template

The global agent rules template (`templates/global-agent-rules.md`) is rendered inline in the Library view under the Rules source type, with preview/edit mode toggle, a textarea editor with save/reset controls, a dirty state indicator, and an "open" button to open the template in the system editor. Save writes only the workspace source template via the allowlisted `save_agent_template` command; it does not sync installed rule targets. Sync is a separate action triggered by the diff/sync buttons in the Workspace operations section.

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
- Available repo skills listed in Library view under the Skills source type with text search filtering and read-only Markdown preview.
- Skill install selection and controls moved to Workspace Operations: expandable skill selector with individual toggles, select all/clear, agent toggles, scope/target selection, dry-run, and install actions.
- Native agent multi-select: toggle codex, opencode, claude, gemini, auggie independently. At least one agent must be selected.
- All install logic reuses the existing `install_skills` backend command.
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
- Config template source editing is in Library view under the Configs source type with target selector, preview/edit mode, and save/reset controls.
- Config operations (diff/sync) are in the Workspace Operations section.
- Configs are registry-driven via `agent_targets::config_sync_targets()`.
- Currently supported config target: OpenCode config (`opencode_config`).
- `save_config_template` validates JSON for the opencode_config target. Unknown targets and malformed JSON are rejected.
- Config template save writes only the workspace source template (`templates/opencode.json`), not the installed target path.
- Save is separate from sync: save edits the template; sync applies changes to the installed config target.

### Release Check and Backups
- Release check runs `scripts/release-check.sh` through the allowlisted `release_check` action from the Workspace Operations section.
- The check is read-only: it does not run apply commands, install skills, or write user config folders.
- Backup history is visible in the Workspace Operations section: refresh backup list, open backups folder.
- Workspace validation and diagnostics are managed in the Workspace view.

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

## Resource Intelligence v1

Resource Intelligence enriches the GUI's understanding of skills and agents with safe metadata. It improves Library/Routing visibility while keeping the app a narrow local workspace management GUI — not an orchestration layer.

### What it does

- **Describes resources** with category, risk, target compatibility, and related-skill references.
- **Validates references** between routing profiles and the resources they cite.
- **Shows compatibility** between skills, agents, and target tools.
- **Helps the operator choose better** without automating execution.

### What it does NOT do

- Run agents or trigger tool actions.
- Route automatically or generate prompts automatically.
- Mutate runtime configs, OpenCode config, or agent permission blocks.
- Install or sync from Routing.
- Add MCP, background workers, memory, task queues, chat, or agent execution.
- Add arbitrary filesystem browsing or new dependencies.

### Skill metadata (backed by `skills/*/SKILL.md`)

Skills can now carry optional metadata in their frontmatter. Fields:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Required. Skill name (existing). |
| `description` | string | Required. Short description (existing). |
| `category` | string | Optional. E.g. `frontend`, `security`, `diagnosis`, `planning`. |
| `risk` | string | Optional. `low`, `medium`, or `high`. |
| `targets` | string | Optional. Comma-separated list of compatible tools: `codex, opencode, claude, auggie`. |
| `related` | string | Optional. Comma-separated list of related skill names. |

Skills without these fields continue to work normally. Missing metadata produces no noise. Metadata is displayed as compact chips in the Library skill sidebar rows and as a details section in the skill preview pane.

### Agent metadata (backed by `metadata/agents.json`)

Agent metadata is stored in a read-only sidecar file (`metadata/agents.json`) to avoid modifying OpenCode runtime-sensitive frontmatter. Each agent entry includes:

- `role` — agent function (primary, investigation, review, documentation, verification)
- `summary` — short description
- `targets` — compatible tools (currently all `opencode`)
- `risk` — `low`, `medium`, or `high`
- `default_skills` — skills commonly used with this agent
- `safe_to_edit_runtime` — whether the agent file can be safely edited (`false` for OpenCode agents)
- `notes` — operator guidance

The metadata sidecar is loaded read-only. Missing or invalid metadata falls back gracefully. A "runtime-sensitive" warning appears next to agents whose frontmatter affects OpenCode behavior.

### Routing metadata consumption

The Routing view now consumes skill and agent metadata for richer validation:

- **Target compatibility warnings**: When a routing profile targets a tool not present in a referenced skill's `targets` field, a non-blocking warning is shown.
- **Agent target compatibility warnings**: When a routing profile targets a tool not present in the referenced agent's metadata `targets` field, a non-blocking warning is shown.
- **Risk mismatch warnings**: When a profile has `risk: "low"` but references a `risk: "high"` skill, a non-blocking warning is shown.
- **Agent risk mismatch warnings**: When a profile has `risk: "low"` but references a `risk: "high"` agent (per metadata), a non-blocking warning is shown.
- **Skill metadata display**: Each skill listed in a routing profile detail shows its category, risk, and targets as compact chips (when available from skill metadata).
- **Agent metadata display**: When a selected routing profile references an agent with metadata, the agent's role, risk, targets, and runtime-sensitivity warning are shown as compact chips.

All warnings remain non-blocking. Existing profiles still work. Metadata is not auto-generated. Public starter profiles should not produce avoidable warnings.

### Compatibility overview

A compact read-only table in the Routing view shows resource counts per target tool:

| Target | Skills | Agents | Profiles | Ready |
|--------|--------|--------|----------|-------|
| opencode | *n* | *n* | *n* | *n*/n |
| codex | *n* | *n* | *n* | *n*/n |
| ... | ... | ... | ... | ... |

No install buttons, sync buttons, execution, or target settings changes.

### Safety constraints verified

- No changes to `default_agent`, OpenCode runtime permissions, or agent permission blocks.
- No changes to `scripts/install-skills.sh`, `scripts/install-opencode-config.sh`, or sync semantics.
- No changes to install destinations or script behavior.
- No new dependencies.
- No arbitrary frontend-supplied file paths.
- Metadata files are read-only unless explicitly edited through existing safe editors.

## Workspace Contract Validator

The app includes a read-only Workspace Contract Validator that checks an active workspace against the public app contract. It validates skills, routing, agent metadata, and agents without executing scripts or modifying files.

### What it checks

| Check | Description |
|-------|-------------|
| Workspace root | Resolves and verifies `.ux-workspace/workspace.json` exists |
| Skills directory | `skills/` exists and contains root-level skills at `skills/<skill>/SKILL.md` |
| Skill metadata | Every `SKILL.md` has required `name` and `description` fields |
| Skill uniqueness | No duplicate skill names (deterministic failure) |
| Legacy skills | No legacy nested skills at `skills/engineering/*/SKILL.md` (fails — public contract is root-level only) |
| Routing file | `routing/profiles.json` is optional; validates JSON, size, and structure when present |
| Routing notes | All notes fields are string arrays (fails on type mismatch) |
| Skill references | Every skill referenced in routing profiles exists in the workspace |
| Agent references | Every agent_profile in routing references a known agent file present in the workspace |
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

### Current skill layout

The public app contract requires root-level skills:
```
skills/<skill>/SKILL.md
```

Examples:
```
skills/diagnose/SKILL.md
skills/security-review/SKILL.md
skills/frontend-design/SKILL.md
```

### Legacy skills are invalid

Nested skill layouts like `skills/engineering/<skill>/SKILL.md` are legacy and fail contract validation. The current public contract is root-level skills only. Legacy skills must be moved to the root level.

### Routing and metadata sidecars

`routing/profiles.json` and `metadata/agents.json` are optional workspace sidecar files. When present, they are validated for correctness:
- Valid JSON within size limits (256 KB for routing, 128 KB for metadata)
- Notes fields must be string arrays
- Referenced skills, agents, and default_skills must resolve to existing workspace resources

Missing optional files produce warnings (`warn` status), not errors (`fail` status). The workspace remains valid without these optional sidecars.

### UI surface

The contract panel is in the Workspace view under the INVENTORY section (CONTRACT row). It shows:
- Overall status: `valid` or `failed`
- Counts of pass/warn/fail checks
- Expandable list of individual check results with status badges and details
- A **refresh** button to re-run validation

Routing-specific contract failures are also surfaced in the Routing view's warnings section with a link back to the Workspace Contract panel for full validation.

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
  │   │   ├── WorkspaceView.tsx    Workspace operations cockpit and skills install selector
  │   │   ├── LibraryView.tsx      Unified source browser/editor (Docs, Rules, Skills, Agents, Configs)
  │   │   ├── RoutingView.tsx      Routing profiles orchestrator (preview, edit, matrix)
  │   │   ├── routing/
  │   │   │   ├── routingTemplates.ts  Profile templates, starter skill/agent validation
  │   │   │   ├── routingHelpers.ts    risk/status helpers, metadata block formatter
  │   │   │   ├── routingCompatibility.ts  Deterministic compatibility row builder
  │   │   │   ├── RoutingMatrix.tsx    Profile compatibility matrix component
  │   │   │   └── RoutingCompatibilityOverview.tsx  Per-target resource counts and readiness
  │   │   └── SettingsView.tsx     Settings view
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
        │   ├── routing.rs  Routing profile commands
        │   ├── settings_commands.rs Settings and target commands
        │   ├── skills.rs   Skill listing/install commands
        │   ├── status.rs   Workspace status command
        │   └── workspace.rs Workspace path validation helpers
        ├── agent_targets.rs Agent sync target registry
        └── settings.rs     Persistent app settings (JSON)
```
