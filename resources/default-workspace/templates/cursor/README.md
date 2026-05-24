# Cursor Profile

Global-only Cursor profile sync for autonomous Playwright MCP browser QA with restricted shell/terminal permissions.

## Primary workflow

Use `scripts/install-cursor-workspace.sh`:

- `--diff-global-profile` — dry-run global profile (agents, skills, MCP, permissions)
- `--apply-global-profile` — apply to `~/.cursor/agents`, `~/.cursor/skills`, `~/.cursor/mcp.json`, `~/.cursor/permissions.json`
- `--validate-global-profile` — validate templates and installed global state

The machine-readable profile is `global-profile.json`. Permissions template: `permissions/global-playwright.json` (`mcpAllowlist: ["playwright:*"]`, no broad `terminalAllowlist`).

## What the global profile writes

| Surface | Path |
| --- | --- |
| Agents | `~/.cursor/agents` |
| Skills | `~/.cursor/skills` (recommended pinned skills) |
| MCP | `~/.cursor/mcp.json` (merges `playwright` server only) |
| Permissions | `~/.cursor/permissions.json` (merges `mcpAllowlist` only) |

## What it does not write

- Project `.cursor/mcp.json`, `.cursor/rules`, `.cursor/agents`, `.cursor/skills`
- `.cursorignore`, `AGENTS.md`
- Undocumented Cursor internal storage

## Other assets

- `user-rules.md` — copy manually into Cursor Settings → Rules → User Rules
- `rules/*.mdc` — reference project-rule templates only; not installed by the app or global profile
- `mcp/` — Playwright MCP template used by global profile merge
- `sandbox/` — legacy debug/copy templates only (not primary UX)

Scripts remain the source of truth for sync behavior.
