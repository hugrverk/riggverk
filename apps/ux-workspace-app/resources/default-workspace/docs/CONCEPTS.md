# Concepts

## Workspace

A workspace is a user-owned directory containing docs, skills, templates, and scripts. It is identified by `.ux-workspace/workspace.json` and a set of required files. The app validates a workspace by checking for these markers.

Workspace contents are user-editable and can be git-versioned.

## Skills

Skills are reusable agent instruction files. Each skill lives in its own directory under `skills/` and must contain a `SKILL.md` file. Skills can be installed globally (system-wide) or per-project by the app or the install script.

See [SKILLS.md](SKILLS.md) for the full skill directory contract.

## Agent Rules

Agent rules define default behavior for coding agents: how they communicate, what they can modify, security boundaries, and verification requirements. The source template lives at `templates/global-agent-rules.md`.

Rules are synced to tool-specific global rule paths. Each agent tool (e.g., Codex, OpenCode, Auggie) stores its rules at a different filesystem path. The install-agent-rules script handles this mapping.

See [AGENT_RULES.md](AGENT_RULES.md).

## Tool Configuration

Tool configuration files define tool-specific settings such as permissions, model preferences, and runtime behavior. The workspace currently manages OpenCode configuration via `templates/opencode.json`.

Tool config sync follows the same dry-run/diff/apply pattern as agent rules.

See [OPENCODE_CONFIG.md](OPENCODE_CONFIG.md).

## Scripts

Workspace scripts handle sync, install, and bootstrap operations. The four required scripts are:

- `bootstrap.sh` — run all sync and install steps together
- `install-skills.sh` — install skills to agent tool folders
- `install-agent-rules.sh` — sync agent rules to tool paths
- `install-opencode-config.sh` — sync OpenCode config

Scripts support `--help`, `--dry-run`, `--diff`, and `--apply` modes.

## Targets

A target is an installed agent tool that the workspace can sync to. Targets have a type (rules or config) and a filesystem path. The app manages which targets are enabled for sync.

## Sync

Sync is the process of copying a workspace template to a target path. The pattern is:

1. **Dry-run** — preview what would happen (no files written)
2. **Diff** — show differences between template and target (files not written)
3. **Apply** — write template to target (backups created before overwrite)

## Dry-run

Dry-run mode shows planned operations without writing files. Use it before applying changes to verify what would be modified.

## Backups

When apply mode overwrites an existing diverged target file, a backup is created before the overwrite. Backups are stored under the app's application support directory. Backups are created only during apply; diff and dry-run modes do not create backups.
