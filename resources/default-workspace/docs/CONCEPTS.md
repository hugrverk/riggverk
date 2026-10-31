# Concepts

## Workspace

The app's data folder, `~/.config/riggverk`. It holds the app's state in `.riggverk/` (ownership records and your choices) and your personal docs in `docs/context/`, and it holds no copy of the bundle. It is plain text and its personal docs can be versioned with Git (see [GIT_VERSIONING.md](GIT_VERSIONING.md)).

The app creates it on the first write that needs it (state, or a personal doc) and never writes it without a confirmed install or an explicit save. It does not run scripts from it.

## Bundle versus workspace

The app ships a read-only bundle of docs, skills, templates, and scripts. Everything the app installs, shows, and checks comes from the bundle, never from the data folder:

- **Install to a harness**: bundle -> `~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.cursor`.
- **Library and health checks**: read the bundle inside the app, so every user sees the current text.

There is no install to the data folder. Earlier releases copied the bundle there; the app no longer reads or updates those copies and removes them only through the reviewed update of the workspace folder (Update all on the Overview, or `:update workspace`): a copy goes only when its bytes prove it is the app's, with a backup, and `z` restores it. An edited copy or any other file the app cannot prove is its own stays in place and is listed as a manual step, not a conflict. See [USING_THE_APP.md](USING_THE_APP.md#overview).

The Library shows bundled files read-only; your own notes go in personal docs (`docs/context/`), which the bundle never ships. Editing a file in the data folder outside the app changes neither what the Library shows nor what Claude, Codex, OpenCode, or Cursor receive.

## Mental model

The first five rows are paths in the bundle; the last two are in your data folder.

| Concept | Location | Purpose |
|---------|----------|---------|
| Docs | `docs/` | Guides and reference |
| Skills | `skills/` | Canonical skill sources, installed unchanged into the folders the enabled harnesses read |
| Templates | `templates/` | Source templates for rules and config |
| Scripts | `scripts/` | Python helpers the app runs from its bundled copy |
| Runtime agents | `agents/`, `agent-specs/` | OpenCode agents and shared agent bodies |
| Ownership records | `.riggverk/` | Managed-state digests, "leave as is" and "keep mine" choices |
| Personal docs | `docs/context/` | Your own text, written in the Library |

## Skills

Reusable agent instruction files. Canonical skills live under `skills/` (for Codex, OpenCode, Claude, and Cursor, and shared with the opt-in Copilot, Pi, and Kilo). The same `SKILL.md` is installed, flat, into the global skills folders the enabled harnesses read (`~/.claude/skills`, `~/.agents/skills`); notes meant for one harness sit at the end of the file under `## Harness notes`. Skills are one surface for all harnesses and are never gated by target toggles. See [SKILLS.md](SKILLS.md).

## Rules and the managed block

Rules define default behavior for coding agents. The source is `templates/global-agent-rules.md` plus a harness appendix. Installed rules files are shared: the app owns only the text between `BEGIN RIGGVERK BASE` and `END RIGGVERK BASE`, and everything outside is yours. Instructions below the block are your refinements and override the base. An edited block or an unmarked pre-existing file is a conflict you resolve with a diff, **Convert**, or **Leave as is**. See [AGENT_RULES.md](AGENT_RULES.md).

## Tool configuration

Config files hold tool settings such as permissions, models, and MCP servers. The app merges only allowlisted keys and preserves everything else: OpenCode via `templates/opencode.json`, `templates/tui.json`, and `templates/playwright-mcp.config.json`; Codex via `templates/codex/config.toml`. Riggverk sets no model; your agent's own default applies. Existing Codex `model` and `model_reasoning_effort` values stay yours. See [OPENCODE_CONFIG.md](OPENCODE_CONFIG.md) and [CODEX_CONFIG.md](CODEX_CONFIG.md).

## Targets and surfaces

A **surface** is one installable group (for example `claude_rules`, `open_code_config`, `cursor_mcp`, `skills`, `workspace_bundle`). A **target** is a toggle that gates one or more surfaces: rules, agents, and config per harness, and `cursor_setup`. A target that is off is excluded from preview, apply, and status. Fresh settings enable every target except `codex_config`, `claude_config` and `kilo_mcp` (the light harnesses' `copilot_rules`, `pi_rules`, `kilo_rules`, `copilot_mcp`, and `pi_mcp` are on, and act once their harness is). Skills and the workspace folder are never gated. Harness enablement (Settings) is separate: a disabled harness is hidden and cannot be written. Codex, OpenCode, Claude, and Cursor are on by default; Copilot, Pi, and Kilo (a rules file, a Playwright MCP entry, and the shared skills) are off until you turn them on.

## Install review and transactions

Install is a two-step action. Preview computes a plan and the review shows every create, update, remove, and conflict; apply runs only after you confirm, and only for the plan you saw. Before the first write the app backs up the files it will replace and records a transaction. A failed apply rolls back by itself, and `z` or `:rollback` restores the last transaction of the session after a dry run and a confirm.

## Scripts

`scripts/` holds the Python helpers (OpenCode generator, Codex config merges). The app runs only its own bundled copies, never scripts from the data folder. See the [bundle README](../README.md).

Do not run scripts from a folder you did not create, including an old copy left in your data folder.

## Backups

Before overwriting or removing a file, Install, uninstall, and Library saves copy it to the backup root, owner-only: `<root>/setup/<transaction id>/...` for installs, `<root>/docs/custom_<slug>-<timestamp>/` for Library saves of personal docs, `<root>/docs/rules-<surface>-<timestamp>/` for Library saves of rules refinements. Previews and dry runs write nothing. Layout and locations: [USING_THE_APP.md](USING_THE_APP.md#backups).
