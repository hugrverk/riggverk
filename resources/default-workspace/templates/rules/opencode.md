## OpenCode harness

- Primary agent is `architect`; delegate investigation, review, security, documentation, and verification to shared subagents via the task tool.
- Skills install to the bundled OpenCode global skills path in flat layout; sync the full skill catalog.
- Config, permissions, watcher ignores, and MCP entries follow the bundled OpenCode template and app-managed keys only.
- Respect permission prompts and sandbox boundaries; commands with mutation, network access, or dependency changes need explicit justification.

## OpenCode command output

This overrides the byte-cap rule above for allow-listed commands: the architect runs allow-listed verification and status commands (`npm run build`, `npm run test`, `npm run lint`, `npm run typecheck`, `npm run verify`, `git status --short`, `git diff --stat`, `ls`) plain, with no pipes, redirects, or wrappers, because shell wrapping triggers permission prompts. The byte-cap rule applies to every command outside the allow-list.
