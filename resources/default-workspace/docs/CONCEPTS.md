# Concepts

## Workspace

A user-owned directory of docs, skills, templates, and scripts, identified by `.agent-workspace/workspace.json` and a set of required files (see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#missing-markers)). It is plain text, user-editable, and can be versioned with Git.

The app creates it from its bundled copy and never writes it without a confirmed install or an explicit save. It does not run the workspace's scripts.

## Bundle versus workspace

The app ships a read-only bundled copy of this workspace. Everything the app installs comes from the bundle, never from the runtime workspace:

- **Install to the workspace**: bundle -> `~/.config/agent-workspace`.
- **Install to a harness**: bundle -> `~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.cursor`.

So editing a file in the workspace changes what the Library shows, not what Claude, Codex, OpenCode, or Cursor receive. It also means the app can no longer prove it owns that file, so it becomes a conflict on later updates and is left alone. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#conflicts).

## Mental model

| Concept | Location | Purpose |
|---------|----------|---------|
| Docs | `docs/` | Guides and reference |
| Skills | `skills/` | Canonical skill sources, installed unchanged into the folders the enabled harnesses read |
| Templates | `templates/` | Source templates for rules and config |
| Scripts | `scripts/` | Python helpers the app runs from its bundled copy |
| Runtime agents | `agents/`, `agent-specs/` | OpenCode agents and shared agent bodies |
| Ownership records | `.agent-workspace/` | Identity, managed-state digests, "leave as is" choices |

## Skills

Reusable agent instruction files. Canonical skills live under `skills/` (25 in the bundle, all for Codex, OpenCode, Claude, and Cursor, and shared with the opt-in Copilot, Pi, and Kilo). The same `SKILL.md` is installed, flat, into the global skills folders the enabled harnesses read (`~/.claude/skills`, `~/.agents/skills`); notes meant for one harness sit at the end of the file under `## Harness notes`. Skills are one surface for all harnesses and are never gated by target toggles. See [SKILLS.md](SKILLS.md).

## Rules and the managed block

Rules define default behavior for coding agents. The source is `templates/global-agent-rules.md` plus a harness appendix. Installed rules files are shared: the app owns only the text between `BEGIN AGENT-WORKSPACE BASE` and `END AGENT-WORKSPACE BASE`, and everything outside is yours. Instructions below the block are your refinements and override the base. An edited block or an unmarked pre-existing file is a conflict you resolve with a diff, **Convert**, or **Leave as is**. See [AGENT_RULES.md](AGENT_RULES.md).

## Tool configuration

Config files hold tool settings such as permissions, models, and MCP servers. The app merges only allowlisted keys and preserves everything else: OpenCode via `templates/opencode.json`, `templates/tui.json`, and `templates/playwright-mcp.config.json`; Codex via `templates/codex/config.toml`. Codex `model` and `model_reasoning_effort` are written only when your config has none; after that they are yours. See [OPENCODE_CONFIG.md](OPENCODE_CONFIG.md) and [CODEX_CONFIG.md](CODEX_CONFIG.md).

## Targets and surfaces

A **surface** is one installable group (for example `claude_rules`, `open_code_config`, `cursor_mcp`, `skills`, `workspace_bundle`). A **target** is a toggle that gates one or more surfaces: rules, agents, and config per harness, and `cursor_setup`. A target that is off is excluded from preview, apply, and status. Fresh settings enable every target except `codex_config` (the light harnesses' `copilot_rules`, `pi_rules`, and `kilo_rules` are on, and act once their harness is). Skills and the workspace bundle are never gated. Harness enablement (Settings) is separate: a disabled harness is hidden and cannot be written. Codex, OpenCode, Claude, and Cursor are on by default; Copilot, Pi, and Kilo (a rules file and the shared skills) are off until you turn them on.

## Install review and transactions

Install is a two-step action. Preview computes a plan and the review shows every create, update, remove, and conflict; apply runs only after you confirm, and only for the plan you saw. Before the first write the app backs up the files it will replace and records a transaction. A failed apply rolls back by itself, and `z` or `:rollback` restores the last transaction of the session after a dry run and a confirm.

## Scripts

`scripts/` holds the Python helpers (OpenCode generator, Codex config merges). The app runs only its own bundled copies, never scripts from the workspace. See the [workspace README](../README.md).

Selecting a workspace folder is still a trust decision: do not run scripts from a folder you did not create.

## Backups

Before overwriting or removing a file, Install, uninstall, and Library saves copy it to the backup root, owner-only: `<root>/setup/<transaction id>/...` for installs, `<root>/docs/<id>-<timestamp>/` for Library saves. Previews and dry runs write nothing. Layout and locations: [USING_THE_APP.md](USING_THE_APP.md#backups).
