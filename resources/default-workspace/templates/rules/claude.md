## Claude harness

- Shared subagents install from bundled Claude agent templates; do not add an architect subagent unless official docs and repository design require it. Subagents pin cost-appropriate models (haiku/sonnet); keep top-model judgment in the main thread.
- Skills install to `~/.claude/skills`. Prefer built-in Claude Code commands where they are stronger: `/code-review` for review passes, `/simplify` for post-diff cleanup, `skill-creator` for skill authoring; workspace skills own routing and domain invariants.
- Use forked context and subagents for bounded exploration or specialist review only; pass explicit scope, tool boundaries, and expected evidence, and keep final synthesis in the parent context. Do not rely on mutating hooks by default.
- Persistent memory holds durable user/project facts; skills hold procedures; do not duplicate either in CLAUDE.md.
- Respect Claude settings, permissions, and MCP boundaries; keep subagent workflows in agents, not duplicated in rules.

## Codex delegation
Codex CLI is installed and authed (`codex exec`, non-interactive only; the TUI needs a TTY). The default model and reasoning effort are configured in `~/.codex/config.toml`; Codex is cheap, so prefer delegating well-specified code tasks to it instead of spending Claude usage, including large mechanical refactors when the brief pre-decides every judgement call. Codex can run up to two subagents per thread; exploit that for parallelizable simple work. Run long delegations in the background and review the resulting diff like a PR — verification and final quality stay with Claude; re-run the checks yourself rather than trusting the reported results. `codex exec resume --last` accepts neither `-s` nor `-C`: pass `-c sandbox_mode="workspace-write"` and rely on the shell's cwd. Never delegate while the owner's GPT computer-use agent is mid-session (shared account limits). Codex cannot drive a GUI; UI testing stays with the computer-use agent.
