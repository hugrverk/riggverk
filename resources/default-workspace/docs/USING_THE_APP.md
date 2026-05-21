# Using the App

A practical walkthrough of each app area.

## Workspace page

The landing page and operations terminal. Shows whether the runtime workspace at `~/.config/agent-workspace` is installed, missing, or needs repair.

- **install** / **repair** — copy bundled defaults into the canonical path (never overwrites existing files)
- **refresh** — reload diagnostics and status
- **open folder** — open the installed workspace in Finder
- **VERIFY** — release-check and backup management when the workspace is valid

Sync, diff, and install actions for each agent tool live on that tool's harness page (Codex, OpenCode, Cursor, Claude, Augment), not on Workspace.

## Harness pages (Codex, OpenCode, Cursor, Claude, Augment)

Per-tool diff/sync/install actions and skills install for that tool only. Open the harness from the top navigation after the workspace is installed.

## Library

Browse and edit workspace content in a three-panel layout:

1. **Source rail** (left) — Docs, Rules, Skills, Agents, Configs, Brain Setup
2. **Item sidebar** (middle) — browse items by section or filter
3. **Content pane** (right) — preview or edit selected content

### Docs

Curated docs grouped under Start, Guides, Reference, and Context. Use "open" for your system editor or edit in-app.

### Rules

View and edit `templates/global-agent-rules.md`. Synced to agent rule paths from harness pages.

### Skills

Browse starter skills. Install from harness pages, not from Workspace.

### Agents

View and edit `agents/*.md` prompt definitions.

### Configs

View and edit `templates/opencode.json` and related config sources.

## Brain Setup (Library)

Copy a durable instruction block for external assistants (skill routing, security, verification). Does not run agents or change sync targets.

## Settings

Appearance and theme colors. Target profiles and per-tool sync toggles are on harness pages; Save persists enabled targets.

## Dry-run before sync

| Operation | Preview | Apply |
|-----------|---------|-------|
| Rules sync | Diff Rules | Sync Rules |
| Config sync | Diff Configs | Sync Configs |
| Skills install | Dry-run Skills | Install Skills |

## Backups

Applying changes that overwrite diverged target files creates backups under `~/Library/Application Support/ai.agentworkspace.app/backups`.

## Release check

Run **release-check** from Workspace VERIFY when the installed workspace includes `scripts/release-check.sh` (the app repo checkout; bundled starter may not include it).

See [WORKFLOWS.md](WORKFLOWS.md) for common patterns.
