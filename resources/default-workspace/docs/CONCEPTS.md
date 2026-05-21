# Concepts

## Workspace

A workspace is a user-owned directory containing docs, skills, templates, and scripts. The app identifies a workspace by the presence of `.agent-workspace/workspace.json` and a set of required files.

The workspace is plain-text, user-editable, and can be versioned with Git. The app operates on a workspace but does not modify it without explicit action.

## Mental model summary

| Concept | Location | Purpose |
|---------|----------|---------|
| Docs | `docs/` | Workspace documentation and guides |
| Skills | `skills/` | Reusable agent instruction files |
| Templates | `templates/` | Source templates for rules and config |
| Scripts | `scripts/` | Sync, install, and bootstrap operations |
| Shared runtime agents | `agents/` | OpenCode runtime agent prompts (six bundled agents) |

## Skills

Skills are reusable agent instruction files. Each skill lives in its own directory under `skills/` with a `SKILL.md` file. Skills define specialized behaviors for coding agents (e.g., frontend design, security review, debugging).

The app installs skills globally (system-wide). CLI scripts may support per-project installs. The bundled workspace includes 24 starter skills.

See [SKILLS.md](SKILLS.md) for the full skill directory contract.

## Agent Rules

Agent rules define default behavior for coding agents: communication style, modification boundaries, security rules, and verification requirements. The source template is `templates/global-agent-rules.md`.

Rules are synced to tool-specific global rule paths. Each agent tool (OpenCode, Codex, Claude, Auggie) stores rules at a different filesystem path. The `install-agent-rules.sh` script maps rules to each tool.

See [AGENT_RULES.md](AGENT_RULES.md).

## Tool Configuration

Tool configuration files define tool-specific settings such as permissions, model preferences, and runtime behavior. The workspace manages OpenCode configuration via `templates/opencode.json`.

See [OPENCODE_CONFIG.md](OPENCODE_CONFIG.md).

## Scripts

Four required scripts handle sync, install, and bootstrap operations:

- `bootstrap.sh` — run all sync and install steps together
- `install-skills.sh` — install skills to agent tool directories
- `install-agent-rules.sh` — sync agent rules to tool paths
- `install-opencode-config.sh` — sync OpenCode config and agents

All scripts support `--help`. Install operations support `--dry-run`; rule/config sync operations support `--diff` and `--apply`. Safe preview is the default.

Selecting a workspace is a trust decision. The app exposes allowlisted actions only, but these scripts are read from and run inside the selected workspace when you trigger sync, install, or release actions. No scripts run automatically on launch, and workspace creation copies starter files without executing scripts.

## Sync operation pattern

1. **Dry-run** — preview what would happen (no files written)
2. **Diff** — show differences between template and target
3. **Apply** — write template to target (backups created before overwrite)

## Targets

A target is an installed agent tool the workspace can sync to. Each target has a type (rules or config) and a filesystem path. The app manages which targets are enabled for sync.

## Backups

When apply mode overwrites an existing diverged file, a backup is created first. Backups live under `~/Library/Application Support/ai.agentworkspace.app/backups`. Dry-run and diff modes never create backups.

## Brain Setup

Brain Setup is a copy-paste instruction surface for external AI assistants. It teaches skill routing discipline, model/tool recommendation habits, security rules, and verification expectations. It does not run agents, change enabled sync targets, or mutate OpenCode/Codex/Claude/Auggie config.

Use Settings to choose which rule and config targets are enabled for diff/sync.
