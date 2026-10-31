## Claude harness

- Shared subagents install from bundled Claude agent templates; do not add an architect subagent unless official docs and repository design require it. Subagents pin a model in their agent header; keep final synthesis and judgment in the main thread. The critic of an adversarial skill may use the strongest available model, since judgment is its whole job.
- Skills install to `~/.claude/skills`. Prefer built-in Claude Code commands where they are stronger: `/code-review` for review passes, `/simplify` for post-diff cleanup, `skill-creator` for skill authoring; workspace skills own routing and domain invariants.
- Use forked context and subagents for bounded exploration or specialist review only; pass explicit scope, tool boundaries, and expected evidence, and keep final synthesis in the parent context. Do not rely on mutating hooks by default.
- Persistent memory holds durable user/project facts; skills hold procedures; do not duplicate either in CLAUDE.md.
- Respect Claude settings, permissions, and MCP boundaries; keep subagent workflows in agents, not duplicated in rules.
