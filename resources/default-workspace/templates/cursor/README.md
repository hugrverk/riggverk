# Cursor Setup

Global Cursor setup for agents, managed skills, and Playwright MCP. Auto Review, sandbox behavior, and general permissions remain IDE-managed in Cursor Settings.

## Primary workflow

Use the Agent Workspace **Cursor** page. Setup runs through native Rust operations on all supported desktop platforms:

- diff setup — preview agents, managed skills, MCP merge, and any pending legacy permission cleanup
- apply setup — sync managed surfaces with backup-before-write
- validate — confirm managed surfaces are synced and legacy cleanup is complete

The machine-readable contract is `global-profile.json` and `manifest.json` (`setup_runtime: native`).

## What the setup writes

| Surface | Path |
| --- | --- |
| Agents | `~/.cursor/agents` |
| Skills | `~/.cursor/skills` (managed skills installed from the app Skills panel) |
| MCP | `~/.cursor/mcp.json` (merges the `playwright` server only) |

During apply, if `~/.cursor/permissions.json` still contains the legacy Agent Workspace-owned `playwright:*` mcpAllowlist entry, setup removes that exact entry only. It does not install a replacement permissions template.

Existing target files are backed up before changes.

## Auto Review

Select **Auto Review** manually in `Cursor Settings > Agents > Run Mode`.

Agent Workspace does not inspect or write undocumented Cursor runtime state and therefore does not claim that Auto Review is active. The Cursor page reports only the files it can verify.

## What it does not write

- Project `.cursor/mcp.json`, `.cursor/rules`, `.cursor/agents`, or `.cursor/skills`
- `.cursorignore` or `AGENTS.md`
- Cursor run-mode state, sandbox profiles, or a managed permissions template

## Other assets

- `user-rules.md` — copy manually into Cursor Settings > Rules > User Rules
- `rules/*.mdc` — reference project-rule templates only; not installed by the app setup
- `mcp/` — Playwright MCP template used by setup merge
