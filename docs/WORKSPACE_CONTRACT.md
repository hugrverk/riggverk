# Workspace Contract

## What a workspace folder is

A workspace folder is a user-owned data directory containing configuration, documentation, skills, templates, and scripts that can be synced to agent tool folders. It is identified by `.ux-workspace/workspace.json` and a set of required workspace markers.

Workspace contents are user-writable and can be git-versioned. The workspace folder does not need to contain the ux-workspace-app source code. The app operates on a workspace folder, not the other way around.

## Current required markers

Workspace validation checks for these markers inside the workspace root:

| Marker | Kind | Purpose |
|--------|------|---------|
| `.ux-workspace/workspace.json` | file | Workspace identity marker |
| `scripts/bootstrap.sh` | file | Full bootstrap script |
| `scripts/install-agent-rules.sh` | file | Agent rules sync script |
| `scripts/install-opencode-config.sh` | file | OpenCode config sync script |
| `scripts/install-skills.sh` | file | Skill install script |
| `templates/global-agent-rules.md` | file | Agent rules template |
| `templates/opencode.json` | file | OpenCode config template |
| `README.md` | file | Workspace readme |
| `skills/` | directory | Skill definitions |

All markers must be present for a workspace to pass validation. A folder missing any marker is rejected.

## What a workspace is not

- The workspace folder is not the app source checkout. The app source lives in `apps/ux-workspace-app/`, which is no longer required inside the workspace folder.
- The workspace is not a generic sync target. All backend actions remain allowlisted and only operate on known-marker paths within the validated workspace root.
- The workspace does not contain secrets, private keys, or credential-bearing data. `.env` files and similar are outside the workspace contract.

## User ownership

All workspace contents (docs, skills, templates, scripts) are user-owned and user-editable. The app reads and displays these files; it does not hide or encrypt them. Users can version their workspace with git like any normal directory.

The app supports editing curated workspace docs through an allowlisted doc registry and editing custom context docs under `docs/context/`. Only known doc ids and valid custom slugs can be written, and only within the validated workspace root. Existing content is backed up before overwrite when changed. Custom docs are app-managed by strict slug format (`^[a-z0-9][a-z0-9-]*$`), stored at `docs/context/<slug>.md`. No subdirectories or recursion. Custom doc title is persisted as a Markdown H1 in the document content; when no H1 is present, the title falls back to the slug-derived name. `save_doc` rejects missing custom docs — `create_doc` owns creation.

The app supports editing config templates through the selected config target's source template path. Config template save validates JSON for known config targets and writes only the workspace source template file, not the installed target config path. Save is separate from sync — sync applies changes to the installed config target via allowlisted scripts.

## Transition state

This repository currently contains both:

- The ux-workspace-app source code (`apps/ux-workspace-app/`).
- Private workspace data (docs, skills, templates, scripts, config).

This is a transitional arrangement. The `ux-workspace` naming (marker directory, workspace_type, app source directory) is the current transitional naming — the final public app name is "Agent Workspace". Internal identifiers are not renamed in this slice; only public-facing copy is clarified.

Over time the two concerns will be separated:

- A public app repository will bundle generic starter workspace resources (default scripts, templates, a README, 22 starter skills, and a workspace marker).
- Private workspace repositories will store user-owned docs, skills, templates, and config without containing app source code.
- Create, import, and upgrade flows for workspaces are future work.

## Script location

Currently, workspace scripts (bootstrap, install, sync) live inside the workspace folder. The app executes them via allowlisted arguments. In a future model these scripts could be:

- Bundled with the app (generic versions).
- Upgraded in-place by the app from bundled defaults.
- Kept entirely in the workspace (user-customized copies).

Script-backed actions will remain allowlisted regardless of where the scripts live.

## Bundled default workspace resources

The app source carries a generic starter workspace under `apps/ux-workspace-app/resources/default-workspace/`. This tree includes a workspace marker, a starter README, docs, templates, real install/sync scripts, and 22 starter skills.

These resources are bundled as Tauri app resources and are available at runtime in both the built `.app` bundle and dev/source checkout mode. They are resolved via the Tauri resource directory in built apps, with a source-tree fallback for dev mode.

A newly created default workspace includes real sync and install scripts. Rule sync targets: Codex, OpenCode, Claude, Gemini, Auggie. Skill install targets: Codex, OpenCode, Claude, Gemini, Auggie. Config sync target: OpenCode config. All writes are explicit apply/install actions and are allowlisted. Backups are created before overwriting diverged target files. Project skill install requires a real project marker and rejects broad parent directories.

These resources are not automatically copied into the active workspace. Future import and upgrade flows may use them as source material when setting up new workspaces or resetting an existing workspace to defaults.

The default workspace content is read-only source material. It does not contain user data, secrets, or private preferences. User workspaces remain user-owned and are separate from the bundled defaults.

The app can display a read-only summary of bundled default resources in Settings, showing known file paths and existence status without executing scripts or copying files. The app can also run a read-only workspace creation dry-run plan that evaluates whether a given path is safe and viable for future initialization using the bundled defaults — no files or directories are created.

When the plan reports a safe target (`missing_directory` or `empty_existing_directory`), the app can create a new workspace by copying only allowlisted bundled default files into the target directory. Create does not overwrite existing files, does not execute scripts, does not write outside the target directory, and rejects unsafe, non-empty, valid-existing, and missing-parent targets. Created workspaces remain user-owned — the app does not take ownership or enforce schema beyond the initial copy.

## Validation

Workspace validation is read-only. It checks for required markers and reports their presence. It does not execute scripts, read file contents beyond marker existence checks, or write to the filesystem. Diagnostics are visible in the app Settings and Health views; the backend command `get_workspace_diagnostics` reports marker-level results without running any scripts.

The workspace path is resolved in this order:

1. `workspace_path` in app settings (if non-empty).
2. `UX_WORKSPACE_PATH` environment variable.
3. Built-in default path.

Validation passes when all markers exist at the resolved canonical path. It fails with a descriptive error when any marker is missing or when the path cannot be resolved.
