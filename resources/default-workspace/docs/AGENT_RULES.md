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
| Auggie | `~/.augment/rules/global.md` |
| Claude | `~/.claude/CLAUDE.md` |

Cursor project rules are separate from this global rules sync. CLI-only: `scripts/install-cursor-workspace.sh --project --target /path/to/project` installs `.cursor/rules/*.mdc` into a project checkout. The app does not expose project sync.

Cursor User Rules are version-controlled separately in `templates/cursor/user-rules.md`. This file adds Cursor-specific operating mode defaults (parent Agent as primary implementation architect, subagent guidance) that must not appear in the cross-tool `templates/global-agent-rules.md`. Use `./scripts/install-cursor-workspace.sh --show-user-rules` to view or `--copy-user-rules` to copy to clipboard for pasting into Cursor Settings > Rules > User Rules. Cursor User Rules are not synced as a file-backed target; the script does not write to undocumented Cursor internal storage.

Paths can be overridden via environment variables.

## Shared runtime agents (separate from rules)

Bundled runtime agent prompts live in `agents/*.md` (six agents). They are **not** the same as global rules in `templates/global-agent-rules.md`.

| Tool | Default agents directory | Sync script |
|------|------------------------|-------------|
| OpenCode | `~/.config/opencode/agents/*.md` | `scripts/install-runtime-agents.sh --opencode` |
| Claude Code | `~/.claude/agents/*.md` | `scripts/install-runtime-agents.sh --claude` |
| Augment | `~/.augment/agents/*.md` | `scripts/install-runtime-agents.sh --auggie` |

Codex custom agents use **TOML** files under `~/.codex/agents/` (see Codex docs), not this shared `.md` set. The app syncs Codex **rules** and **config** only.

Cursor adapter agents are a separate five-file set under `templates/cursor/agents/`. The primary Cursor workflow applies the global Playwright profile via `scripts/install-cursor-workspace.sh --apply-global-profile` to `~/.cursor/agents`, `~/.cursor/skills`, `~/.cursor/mcp.json`, and `~/.cursor/permissions.json` (MCP merge + `playwright:*` allowlist; no project writes; shell stays restricted).

## Sync workflow

1. Review the template at `templates/global-agent-rules.md`
2. Run `--diff` to see differences between the template and each target
3. Run `--apply` to write the template to enabled targets

Backups are created before overwriting diverged targets.

## Customization

The template is user-editable. Modify it to match your workflow, then sync to your tools.
