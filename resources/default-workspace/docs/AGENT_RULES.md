# Agent Rules

## Source template

The source template for agent behavior rules is `templates/global-agent-rules.md`. This file defines:

- Communication style and language preferences
- Security boundaries (no secrets, no credential-bearing data)
- Working model (small diffs, boring solutions, bounded scope)
- Skill routing (task-specific skill selection with concrete routing bullets)
- Task flow (inspect, plan, implement, verify, report)
- Verification requirements (never claim done without evidence)
- Git conventions
- Final report format

## Sync destinations

When synced, the template is written to tool-specific global rule paths:

| Tool | Default path |
|------|-------------|
| Codex | `~/.codex/AGENTS.md` |
| OpenCode | `~/.config/opencode/AGENTS.md` |
| Claude | `~/.claude/CLAUDE.md` |

Cursor global profile sync is separate from this global rules sync. The app writes only global Cursor profile files under `~/.cursor/` and never writes project `.cursor/*`, `.cursorignore`, or `AGENTS.md`.

Cursor User Rules are version-controlled separately in `templates/cursor/user-rules.md`. Copy them manually into Cursor Settings > Rules > User Rules when needed. Cursor User Rules are not synced as a file-backed target; the script does not write to undocumented Cursor internal storage.

Paths can be overridden via environment variables.

## Shared runtime agents (separate from rules)

Bundled runtime agent prompts live in `agents/*.md` (six agents). They are **not** the same as global rules in `templates/global-agent-rules.md`.

| Tool | Default agents directory | Sync script |
|------|------------------------|-------------|
| OpenCode | `~/.config/opencode/agents/*.md` | `scripts/install-runtime-agents.sh --opencode` |
| Claude Code | `~/.claude/agents/*.md` | `scripts/install-runtime-agents.sh --claude` |

Codex custom agents use **TOML** files under `~/.codex/agents/` (see Codex docs), not this shared `.md` set. The app syncs Codex **rules**; Codex config is manual-review only.

Cursor adapter agents are a separate five-file set under `templates/cursor/agents/`. The primary Cursor workflow applies the global Playwright profile via `scripts/install-cursor-workspace.sh --apply-global-profile` to `~/.cursor/agents`, `~/.cursor/skills`, `~/.cursor/mcp.json`, and `~/.cursor/permissions.json` (MCP merge + `playwright:*` allowlist; no project writes; shell stays restricted).

## Sync workflow

1. Review the template at `templates/global-agent-rules.md`
2. Run `--diff` to see differences between the template and each target
3. Run `--apply` to write the template to enabled targets

Backups are created before overwriting diverged targets.

## Customization

The template is user-editable. Modify it to match your workflow, then sync to your tools.
