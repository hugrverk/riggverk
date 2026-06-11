# Using the App

A practical walkthrough of each app area.

## Workspace page

The landing page and operations terminal. Shows whether the runtime workspace at `~/.config/agent-workspace` is installed, missing, or needs repair.

- **install** / **repair** / **update resources** — copy bundled defaults into the canonical path (never overwrites existing files). **update resources** appears when the workspace is valid but newer bundled files are missing (for example prompt templates after an app upgrade).
- **refresh** — reload diagnostics and status
- **open folder** — open the installed workspace in Finder
- **VERIFY** — release-check and backup management when the workspace is valid

Harness pages (Codex, OpenCode, Cursor, Claude) provide detailed per-tool diff, sync, and install actions. The Workspace page provides a complementary unified **setup lifecycle** — preview, apply, repair, and rollback across managed surfaces. Use either path; they are not mutually exclusive.

## Harness pages (Codex, OpenCode, Cursor, Claude)

Per-tool diff/sync/install actions and skills install for that tool only. Open the harness from the top navigation after the workspace is installed.

## Library

Browse and edit workspace content in a three-panel layout:

1. **Source rail** (left) — Docs, Rules, Skills, Agents, Configs, Brain Setup
2. **Item sidebar** (middle) — browse items by section or filter
3. **Content pane** (right) — preview or edit selected content

### Docs

Curated docs grouped under Start, Guides, Reference, Prompt Templates, and Context. Prompt Templates ships as `docs/prompt-templates/*.md` after install, repair, or update resources. Use "open" for your system editor or edit in-app.

### Rules

View and edit `templates/global-agent-rules.md`. Synced to agent rule paths from harness pages.

### Skills

Browse bundled skills in Library. Install or sync from harness pages (per-tool preview and apply) or from the Workspace unified setup lifecycle (apply/repair across harnesses). These paths are complementary.

### Agents

View and edit `agents/*.md` prompt definitions.

### Configs

View and edit `templates/opencode.json` and related config sources.

## Brain Setup (Library)

Copy a durable instruction block for external assistants (skill routing, security, verification). Does not run agents or change sync targets.

## Settings

Appearance, global text size, and theme colors. Settings autosave.

## Tools

In-app utilities separate from harness sync:

- **Prompt Loops** — copy/paste prompt templates with skill-weaving for agent runs.
- **Repo Dashboard** — local git/gh snapshot of a checkout with three pages: Overview (summary, charts, recent activity, contributors), Work (active and done items from docs/gh), and Docs (searchable Markdown reader).

## Dry-run before sync

| Operation | Preview | Apply |
|-----------|---------|-------|
| Rules sync | Diff Rules | Sync Rules |
| OpenCode config sync | Diff Configs | Sync Configs |
| Codex config | Preview in setup lifecycle | Apply managed fields |
| Skills install | Dry-run Skills | Install Skills |

## Setup lifecycle (Workspace)

- **Preview** issues a short-lived token and fingerprint; **apply** and **repair** consume the token only after complete backend preflight and immediately before the first mutation.
- Failed preflight leaves the token valid for retry.
- Failed apply or repair with a transaction ID remains available for **rollback** when dry-run shows eligible artifacts.
- Explicit rollback persists per-artifact progress; transactions in `rolling_back` or `rollback_failed` can be resumed; already restored artifacts are skipped.
- Codex managed rollback preserves comments and unrelated formatting via the line-preserving merge script, or refuses safely on conflict.
- Symlinked parents and dangling symlinks in managed paths are rejected.

## Backups

Applying changes that overwrite diverged target files creates backups under the platform-resolved Agent Workspace backup root (for example `~/Library/Application Support/ai.agentworkspace.app/backups` on macOS).

## Release check

Run **release-check** from Workspace VERIFY when the installed workspace includes `scripts/release-check.sh` (the app repo checkout; bundled starter may not include it).

See [WORKFLOWS.md](WORKFLOWS.md) for common patterns.
