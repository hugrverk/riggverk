# Cursor Setup

Global Cursor setup for agents, optional skills, Playwright MCP, and compatibility permissions. Cursor Auto Review and sandbox behavior remain IDE-managed.

## Primary workflow

Use `scripts/install-cursor-workspace.sh`:

- `--diff-global-profile` — preview the installed Cursor setup
- `--apply-global-profile` — apply agents, starter skills, Playwright MCP, and compatibility permissions
- `--validate-global-profile` — validate templates and installed setup state

The machine-readable setup is `global-profile.json`.

## What the setup writes

| Surface | Path |
| --- | --- |
| Agents | `~/.cursor/agents` |
| Skills | `~/.cursor/skills` (recommended starter skills; the app Skills panel remains the normal selectable installer) |
| MCP | `~/.cursor/mcp.json` (merges the `playwright` server only) |
| Permissions | `~/.cursor/permissions.json` (merges the current Playwright compatibility entry only) |

Existing target files are backed up before changes.

## Auto Review

Select **Auto Review** manually in `Cursor Settings > Agents > Run Mode`.

Agent Workspace does not inspect or write undocumented Cursor runtime state and therefore does not claim that Auto Review is active. The Cursor page reports only the files it can verify.

## What it does not write

- Project `.cursor/mcp.json`, `.cursor/rules`, `.cursor/agents`, or `.cursor/skills`
- `.cursorignore` or `AGENTS.md`
- Cursor run-mode state or undocumented Cursor internal storage

## Other assets

- `user-rules.md` — copy manually into Cursor Settings > Rules > User Rules
- `rules/*.mdc` — reference project-rule templates only; not installed by the app setup
- `mcp/` — Playwright MCP template used by setup merge
- `sandbox/` — deprecated compatibility/debug templates only; not exposed in the normal app workflow

Scripts remain the source of truth for sync behavior on macOS and Linux. Windows uses the native adapter for the same supported setup actions.
