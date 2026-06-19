# Using the App

A practical walkthrough of each app area.

## Workspace page

The landing page and operations terminal. Shows the managed installation state for the runtime workspace at `~/.config/agent-workspace`.

- **Install or Update** — previews and applies allowlisted workspace and harness artifact changes.
- **Installed** — Installed State Map summarizing workspace, Codex, OpenCode, Claude, and Cursor surface states. Refreshes after managed actions complete. Read-only status summary, not a second installation control.
- **refresh** — reload diagnostics and status
- **open folder** — open the installed workspace in Finder
- **VERIFY** — release-check and backup management when the workspace is valid
- **Uninstall** — **preview uninstall** classifies removable app-owned files, preserved modified files, and merge-managed configs left in place; **uninstall everything** applies removal after confirmation and records a rollback-capable transaction.
- **Recover previous uninstall** — shown for the current app session only after a full uninstall. Run **preview recovery** (read-only dry-run), then **restore workspace** with explicit confirmation. Recovery is not available after app restart.

Harness pages (Codex, OpenCode, Cursor, Claude) show the same installation model scoped to that harness. Each normal screen has one installation card.

## Harness pages (Codex, OpenCode, Cursor, Claude)

Per-tool installation status and runtime health. Open the harness from the top navigation after the workspace is installed.

## Library

Browse and edit workspace content in a three-panel layout:

1. **Source rail** (left) — Docs, Rules, Skills, Agents, Configs, Brain Setup
2. **Item sidebar** (middle) — browse items by section or filter
3. **Content pane** (right) — preview or edit selected content

### Docs

Curated docs grouped under Start, Guides, Reference, Prompt Templates, and Context. Prompt Templates ship as `docs/prompt-templates/*.md` after installation. Use "open" for your system editor or edit in-app.

### Rules

View and edit `templates/global-agent-rules.md`. Synced to agent rule paths from harness pages.

### Skills

Browse bundled skills in Library. Install or update them through the managed installation card.

### Agents

View and edit `agents/*.md` prompt definitions.

### Configs

View and edit `templates/opencode.json` and related config sources.

## Brain Setup (Library)

Copy a durable instruction block for external assistants (skill routing, security, verification). Does not run agents or change sync targets.

## Settings

**Harnesses** controls which tools appear and may receive new managed writes: Codex, OpenCode, Claude, and Cursor are enabled by default. Disabling a harness hides its navigation, status, and harness-specific Library content while preserving existing files and fine-grained target selections. Re-enabling restores the UI but does not install automatically. This is an explicit preference, not automatic tool detection.

Appearance, global text size, theme colors, **Motion** (reduce pulse, scan, and flash animations), and **Landing page** (workspace, repo dashboard, prompt builder, or library). Settings autosave. Changing appearance clears background and foreground overrides. Full uninstall still covers proven app-owned files from disabled harnesses, and rollback follows the recorded transaction independently of current harness visibility.

## Tools

In-app utilities separate from harness sync:

- **Prompt Builder** — copy/paste prompt templates with skill-weaving for agent runs.
- **Repo Dashboard** — local git/gh snapshot of a checkout with three pages: Overview (summary, charts, recent activity, contributors), Work (active and done items from docs/gh), and Docs (searchable Markdown reader).

## Install or Update

- Preview issues a short-lived token and artifact fingerprint; apply consumes it only after complete backend preflight and immediately before the first mutation.
- Conflict review lists preserved files that require manual resolution; safe unrelated operations remain available.
- Failed apply with a transaction ID remains available for rollback when dry-run shows eligible artifacts.
- Explicit rollback persists per-artifact `in_flight` before each restore, then `restored` or `failed` after validation; interrupted rollbacks reconcile without double-restoring completed artifacts.
- Transactions in `rolling_back` or `rollback_failed` can be resumed; already `restored` artifacts are skipped; when none remain eligible the transaction finalizes without further filesystem changes.
- Rollback dry-run lists already restored, still-required, and conflicted artifacts and performs zero manifest writes.
- Codex managed apply and rollback preserve same-line inline comments on managed scalar fields via the line-preserving merge script, or refuse safely with zero mutation on conflict.
- Symlinked parents and dangling symlinks in managed paths are rejected.

## Backups

Applying changes that overwrite diverged target files creates backups under the platform-resolved Agent Workspace backup root (for example `~/Library/Application Support/ai.agentworkspace.app/backups` on macOS).

## Release check

Run **release-check** from Workspace VERIFY when the installed workspace includes `scripts/release-check.sh` (the app repo checkout; bundled starter may not include it).

See [WORKFLOWS.md](WORKFLOWS.md) for common patterns.
