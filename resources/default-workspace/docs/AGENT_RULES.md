# Agent Rules

## Source template

The source template for agent behavior rules is `templates/global-agent-rules.md`. This file defines:

- Communication style and language preferences
- Security boundaries (no secrets, no credential-bearing data)
- Working model (small diffs, boring solutions, bounded scope)
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
| Gemini | `~/.gemini/GEMINI.md` |

Paths can be overridden via environment variables.

## Sync workflow

1. Review the template at `templates/global-agent-rules.md`
2. Run `--diff` to see differences between the template and each target
3. Run `--apply` to write the template to enabled targets

Backups are created before overwriting diverged targets.

## Customization

The template is user-editable. Modify it to match your workflow, then sync to your tools.
