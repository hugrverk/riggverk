# Using the App

A practical walkthrough of each app tab and its operations.

## Workspace Tab

The main operations hub. Shows workspace status, diagnostics, and action controls.

### Workspace Setup panel

Visible when no valid workspace is selected. You can:

1. **Choose a folder** or type a path manually
2. **Dry-run create** — evaluate if the path is safe for workspace initialization
3. **Create workspace** — copy starter files into the target (appears only when dry-run passes)

The app never writes files automatically. Create workspace copies files only — no scripts execute, no Git init, no network calls.

### Operations Cockpit

Available when a valid workspace is active. Three action lanes:

- **SYNC**: Pull workspace status, diff rules (preview changes), sync rules (apply), diff configs, sync configs, run release check
- **SKILLS**: Select skills, choose agents and scope, dry-run install, apply install
- **VERIFY**: Run workspace contract validation, view backup count, open backups folder

### Inventory panel (collapsible)

Shows workspace structure: marker status, file categories, system map (rules/config state per tool), diagnostics, and contract validation results.

### After creating a workspace

- Open the **Library tab** to browse docs
- Visit the **Routing tab** to enable sync targets
- Run a dry-run sync before applying anything
- Optional: initialize Git (see GIT_VERSIONING.md)

## Library Tab

Browse, read, and edit workspace content in a three-panel layout:

1. **Source rail** (left) — switch between Docs, Rules, Skills, Agents, Configs
2. **Item sidebar** (middle) — browse items grouped by section or filter
3. **Content pane** (right) — preview or edit selected content

### Docs

Curated docs are organized by section:
- **Start** — README, Start Here, Concepts
- **Guides** — Using the App, Git Versioning, Workflows
- **Reference** — Skills, Agent Rules, OpenCode Config, Troubleshooting
- **Context** — custom docs you create (under `docs/context/`)

Use "open" to edit a doc in your system editor, or switch to edit mode in-app.

### Rules

View and edit `templates/global-agent-rules.md`. This template is synced to agent tool rule paths during sync operations.

### Skills

Browse the 22 starter skills. Each shows its name and description. Use "open" to view the full `SKILL.md` content in your editor.

### Agents

View and edit agent prompt definitions (`agents/*.md`). Each agent shows its mode (primary or subagent), risk level, and target tool mapping.

### Configs

View and edit `templates/opencode.json`. The JSON is formatted for readability.

## Routing Tab

Manage sync routing profiles. Profiles define which targets are enabled for different scenarios. Switch between profiles to change which agent tools receive syncs.

## Settings Tab

- **Appearance**: Dark, light, or system theme. Accent color picker with hex input.
- **Targets**: Enable or disable individual rule and config targets per tool.
- **Profiles**: Apply target profiles to quickly switch between setups.

## Dry-run before sync

Always dry-run before applying. The pattern applies everywhere:

| Operation | Preview | Apply |
|-----------|---------|-------|
| Rules sync | Diff Rules | Sync Rules |
| Config sync | Diff Configs | Sync Configs |
| Skills install | Dry-run Skills | Install Skills |
| Create workspace | Dry-run Create | Create Workspace |

## Backups

The app creates backups when applying changes that would overwrite existing files. Backups are stored under `~/Library/Application Support/ai.agentworkspace.app/backups`.

## Release check

Run "release-check" in the Workspace VERIFY lane to validate the workspace:
- All required files present
- Scripts are valid and pass syntax checks
- No private names or secrets in the bundle
- Agent definitions are non-empty with correct modes

See [WORKFLOWS.md](WORKFLOWS.md) for common workflow patterns.
