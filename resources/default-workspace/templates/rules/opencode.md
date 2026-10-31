## OpenCode harness

- Primary agent is `architect`; delegate investigation, review, security, documentation, and verification to shared subagents via the task tool.
- Skills install in flat layout to a folder OpenCode reads (`~/.claude/skills` or `~/.agents/skills`, whichever the enabled harnesses need); sync the full skill catalog.
- Config, permissions, watcher ignores, and MCP entries follow the bundled OpenCode template and app-managed keys only.
- Respect permission prompts and denials (OpenCode has no OS sandbox); commands with mutation, network access, or dependency changes need explicit justification.

## OpenCode command output

This overrides the byte-cap rule above for allow-listed commands: the architect runs allow-listed verification and status commands (the repo's own build, test, lint, and typecheck commands, `git status --short`, `git diff --stat`, `ls`) plain, with no pipes, redirects, or wrappers, because shell wrapping triggers permission prompts. The byte-cap rule applies to every command outside the allow-list.
