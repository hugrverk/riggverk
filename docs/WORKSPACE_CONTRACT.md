# Workspace Contract

## What a workspace folder is

A workspace folder is a user-owned data directory containing configuration, documentation, skills, templates, and scripts that can be synced to agent tool folders. It is identified by `.agent-workspace/workspace.json` and a set of required workspace markers.

Workspace contents are user-writable and can be git-versioned. The workspace folder does not need to contain the Agent Workspace app source code. The app operates on a workspace folder, not the other way around.

## Current required markers

Workspace validation checks for these markers inside the workspace root.
Markers are split into two categories: generic runtime markers (required for every
workspace) and bundled default resources (shipped with the app, not strictly required).

### Generic runtime markers (always required)

| Marker | Kind | Purpose |
|--------|------|---------|
| `.agent-workspace/workspace.json` | file | Workspace identity marker |
| `scripts/bootstrap.sh` | file | Full bootstrap script |
| `scripts/install-agent-rules.sh` | file | Agent rules sync script |
| `scripts/install-opencode-config.sh` | file | OpenCode config sync script |
| `scripts/install-codex-config.sh` | file | Codex config sync script |
| `scripts/install-skills.sh` | file | Skill install script |
| `scripts/install-cursor-workspace.sh` | file | Cursor subagent and project-rule setup script |
| `templates/global-agent-rules.md` | file | Agent rules template |
| `templates/opencode.json` | file | OpenCode config template |
| `templates/codex/config.toml` | file | Codex config template |
| `templates/cursor/agents/` | directory | Cursor subagent adapter templates |
| `templates/cursor/rules/` | directory | Cursor project rule templates dir (must contain at least one `.mdc` file) |
| `templates/cursor/manifest.json` | file | Cursor profile manifest |
| `templates/cursor/mcp/mcp.example.json` | file | Cursor MCP example using env placeholders |
| `README.md` | file | Workspace readme |
| `skills/` | directory | Skill definitions |

Cursor project rules are split into focused `.mdc` files. At least one rule must be always-applied, and not all rules should be always-applied.

All generic markers must be present for a workspace to pass validation. A folder
missing any marker is rejected.

### Bundled default workspace resources (app-shipped, not runtime-required)

The following files are shipped with the app as bundled starter content but are
**not** required for generic workspace validity:

| Resource | Purpose |
|----------|---------|
 | `templates/cursor/README.md` | Cursor setup source note (bundled default doc) |
| `templates/cursor/rules/core-safety.mdc` | Always-applied Cursor core safety project rule |
| `templates/tui.json` | OpenCode TUI config template |
| `templates/opencode.base.json` | OpenCode config base (non-permission settings) |
| `templates/opencode.policy.json` | OpenCode permission policy (compact format) |
| `scripts/generate-opencode-config.py` | OpenCode config snapshot generator (workspace-relative) |
| `agents/` directory + 6 agent files | OpenCode agent definitions |

These files are included when creating a new workspace from defaults but are
not validated against arbitrary existing workspaces.

## What a workspace is not

- The workspace folder is not the app source checkout. The app source lives in the repository root and is separate from any workspace folder.
- The workspace is not a generic sync target. All backend actions remain allowlisted and only operate on known-marker paths within the validated workspace root.
- The workspace does not contain secrets, private keys, or credential-bearing data. `.env` files and similar are outside the workspace contract.

## User ownership

All workspace contents (docs, skills, templates, scripts) are user-owned and user-editable. The app reads and displays these files; it does not hide or encrypt them. Users can version their workspace with git like any normal directory.

The app supports editing curated workspace docs through an allowlisted doc registry and editing custom context docs under `docs/context/`. Only known doc ids and valid custom slugs can be written, and only within the validated workspace root. Existing content is backed up before overwrite when changed. Custom docs are app-managed by strict slug format (`^[a-z0-9][a-z0-9-]*$`), stored at `docs/context/<slug>.md`. No subdirectories or recursion. Custom doc title is persisted as a Markdown H1 in the document content; when no H1 is present, the title falls back to the slug-derived name. `save_doc` rejects missing custom docs — `create_doc` owns creation.

The app supports editing allowlisted config templates. OpenCode config sources are editable through the Library Configs editor and writes stay inside the workspace source templates, not installed target config paths. Cursor setup is script-backed setup, so it remains available to sync/status flows but is not editable as a config template or README pseudo-config. Save is separate from sync — sync applies enabled config/setup targets via allowlisted scripts.

The app supports editing `templates/global-agent-rules.md` through the allowlisted `save_agent_template` command. The command resolves the template path internally under the validated workspace root and accepts no frontend-supplied paths. Save writes only the workspace source template; it does not sync installed rule targets. Installed agent rule files (e.g., `~/.codex/AGENTS.md`) are updated only by the separate sync/apply action.

Cursor support is script-backed and scoped: skills install to Cursor skill folders, focused subagents install to Cursor agent folders, and project rules install to `.cursor/rules/*.mdc` inside an explicit project target. Cursor User Rules are version-controlled as `templates/cursor/user-rules.md` (a Cursor-only template separate from the cross-tool `templates/global-agent-rules.md`). The app must not auto-write a file-backed Cursor User Rules path; Cursor User Rules are settings-managed unless official docs document otherwise. The versioned file supports `--show-user-rules` and `--copy-user-rules` for manual setup. MCP examples and sandbox/profile templates are opt-in only and must use environment interpolation for auth-like values. The app does not auto-write undocumented Cursor sandbox paths.

## Transition state

The workspace marker directory `.agent-workspace/` and the `AGENT_WORKSPACE_PATH` / `AGENT_WORKSPACE_BACKUP_DIR` environment variables are established parts of the workspace contract.

This repository is the public Agent Workspace app source. Private workspace repositories can store user-owned docs, skills, templates, and config without containing app source code. Workspace create is implemented for safe empty or missing targets using bundled defaults. Repair flows for existing workspaces copy only missing bundled files and never overwrite user edits.

## Script location

Currently, workspace scripts (bootstrap, install, sync) live inside the workspace folder. The app executes them via allowlisted arguments. In a future model these scripts could be:

- Bundled with the app (generic versions).
- Upgraded in-place by the app from bundled defaults.
- Kept entirely in the workspace (user-customized copies).

Script-backed actions will remain allowlisted regardless of where the scripts live.

## Bundled default workspace resources

The app source carries a generic starter workspace under `resources/default-workspace/`. This tree includes a workspace marker, a starter README, docs, templates, agents, real install/sync scripts, Cursor setup assets, and 24 starter skills.

These resources are bundled as Tauri app resources and are available at runtime in both the built `.app` bundle and dev/source checkout mode. They are resolved via the Tauri resource directory in built apps, with a source-tree fallback for dev mode.

A newly created default workspace includes real sync and install scripts plus five focused Cursor adapter templates under `templates/cursor/agents/`. Rule sync targets: Codex, OpenCode, Claude, Auggie. Skill install targets (app: global only): Codex, OpenCode, Claude, Auggie, Cursor. Config/setup sync targets: OpenCode config + agents, and Cursor global subagents. All app writes are explicit apply/install actions to global/home paths and are allowlisted. Backups are created before overwriting diverged target files. The app does not drive project checkout sync or install. Bundled CLI scripts may still accept `--project --target` when run manually; those flags are CLI-only and outside app workflow.

These resources are not automatically copied into the active workspace. A repair flow (`plan_workspace_repair` / `apply_workspace_repair`) copies only missing bundled files into an existing workspace. Repair never overwrites user edits, never executes scripts, and rejects unsafe paths.

The default workspace content is read-only source material. It does not contain user data, secrets, or private preferences. User workspaces remain user-owned and are separate from the bundled defaults.

The app can display a read-only summary of bundled default resources in the Workspace tab, showing known file paths and existence status without executing scripts or copying files. The app can also run a read-only workspace creation dry-run plan that evaluates whether a given path is safe and viable for initialization using the bundled defaults — no files or directories are created.

When the plan reports a safe target (`missing_directory` or `empty_existing_directory`), the app can create a new workspace by copying only allowlisted bundled default files into the target directory. Create does not overwrite existing files, does not execute scripts, does not write outside the target directory, and rejects unsafe, non-empty, valid-existing, and missing-parent targets. Created workspaces remain user-owned — the app does not take ownership or enforce schema beyond the initial copy.

## Skill layout

Canonical skill files live at `skills/<skill>/SKILL.md` — one directory per skill, directly under `skills/`.

Nested layouts such as `skills/<group>/<skill>/SKILL.md` are not part of the public workspace contract. Skill discovery ignores nested skills entirely, and the workspace contract validator reports them as a failure when they are present. All skills, including private workspace skills, must follow the root-level layout.

This is generic app behavior, not specific to any particular workspace or group.

## Validation

Workspace validation is read-only. It checks for required markers and reports their presence. It does not execute scripts, read file contents beyond marker existence checks, or write to the filesystem. Diagnostics are visible in the app Workspace view; the backend command `get_workspace_diagnostics` reports marker-level results without running any scripts.

The workspace path is resolved in this order:

1. `workspace_path` in app settings (if non-empty).
2. `AGENT_WORKSPACE_PATH` environment variable.
3. Built-in default path.

Validation passes when all markers exist at the resolved canonical path. It fails with a descriptive error when any marker is missing or when the path cannot be resolved.
