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
| Skills | `skills/`, `templates/skills/` | Canonical skill sources and generated harness adapters |
| Templates | `templates/` | Source templates for rules and config |
| Scripts | `scripts/` | CLI installers and helpers, optional |
| Runtime agents | `agents/`, `agent-specs/` | OpenCode agents and shared agent bodies |
| Ownership records | `.agent-workspace/` | Identity, managed-state digests, "leave as is" choices |

## Skills

Reusable agent instruction files. Canonical skills live under `skills/` (22 in the bundle, all for Codex, OpenCode, Claude, and Cursor). Generated adapters under `templates/skills/<harness>/<skill>/SKILL.md` are what gets installed, flat, to each harness's global skills folder. Skills follow their harness and are never gated by target toggles. See [SKILLS.md](SKILLS.md).

## Rules and the managed block

Rules define default behavior for coding agents. The source is `templates/global-agent-rules.md` plus a harness appendix. Installed rules files are shared: the app owns only the text between `BEGIN AGENT-WORKSPACE BASE` and `END AGENT-WORKSPACE BASE`, and everything outside is yours. Instructions below the block are your refinements and override the base. An edited block or an unmarked pre-existing file is a conflict you resolve with a diff, **Convert**, or **Leave as is**. See [AGENT_RULES.md](AGENT_RULES.md).

## Tool configuration

Config files hold tool settings such as permissions, models, and MCP servers. The app merges only allowlisted keys and preserves everything else: OpenCode via `templates/opencode.json`, `templates/tui.json`, and `templates/playwright-mcp.config.json`; Codex via `templates/codex/config.toml`. Codex `model` and `model_reasoning_effort` are written only when your config has none; after that they are yours. See [OPENCODE_CONFIG.md](OPENCODE_CONFIG.md) and [CODEX_CONFIG.md](CODEX_CONFIG.md).

## Targets and surfaces

A **surface** is one installable group (for example `claude_rules`, `open_code_config`, `cursor_mcp`, `workspace_bundle`). A **target** is a toggle that gates one or more surfaces: rules, agents, and config per harness, and `cursor_setup`. A target that is off is excluded from preview, apply, and status. Fresh settings enable every target except `codex_config`. Skills and the workspace bundle are never gated. Harness enablement (Settings) is separate: a disabled harness is hidden and cannot be written.

## Install review and transactions

Install is a two-step action. Preview computes a plan and the review shows every create, update, remove, and conflict; apply runs only after you confirm, and only for the plan you saw. Before the first write the app backs up the files it will replace and records a transaction. A failed apply rolls back by itself, and `z` or `:rollback` restores the last transaction of the session after a dry run and a confirm.

## Scripts

`scripts/` holds optional CLI installers and helpers. The app does not call the installers. They default to dry-run, back up before overwriting, and need Python 3 and Bash (macOS and Linux). The app itself runs only its own bundled Python helpers, never scripts from the workspace. See the [workspace README](../README.md).

Selecting a workspace folder is still a trust decision: do not run scripts from a folder you did not create.

## Backups

Before overwriting or removing a file, Install, uninstall, and Library saves copy it to the backup root, owner-only: `<root>/setup/<transaction id>/...` for installs, `<root>/docs/<id>-<timestamp>/` for Library saves. Previews and dry runs write nothing. Layout and locations: [USING_THE_APP.md](USING_THE_APP.md#backups).

## Brain Setup

A copy-paste instruction block for external AI assistants covering skill routing, security rules, and verification. It runs no agents and changes no targets or config.
