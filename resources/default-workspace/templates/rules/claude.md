## Claude harness

- Shared subagents install from bundled Claude agent templates; do not add an architect subagent unless official docs and repository design require it.
- Skills install to `~/.claude/skills` unless `CLAUDE_SKILLS_PATH` overrides.
- Respect Claude settings, permissions, and MCP boundaries; keep subagent workflows in agents, not duplicated in rules.
