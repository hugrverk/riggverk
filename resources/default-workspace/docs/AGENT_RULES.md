# Agent Rules and Native Agents

## Shared rules source

`templates/global-agent-rules.md` is the editable shared rules core. It defines communication, security, bounded implementation, skill routing, verification, git behavior, and reporting.

Harness-specific appendices live under `templates/rules/`. In the app source repository, `scripts/generate-agent-rules.py` composes the installed rule sources under `templates/sync/`; the generators are not shipped in the installed workspace.

Installed rule targets:

| Harness | Default path |
| --- | --- |
| Codex | `$CODEX_HOME/AGENTS.md` (default `~/.codex/AGENTS.md`) |
| OpenCode | `~/.config/opencode/AGENTS.md` |
| Claude Code | `~/.claude/CLAUDE.md` |
| GitHub Copilot | `~/.copilot/copilot-instructions.md` |
| Pi | `~/.pi/agent/AGENTS.md` |
| Kilo Code | `$XDG_CONFIG_HOME/kilo/AGENTS.md` (default `~/.config/kilo/AGENTS.md`) |

Copilot, Pi, and Kilo are the opt-in light tier: their rules targets (`copilot_rules`, `pi_rules`, `kilo_rules`) act once the harness is enabled in Settings.

Cursor User Rules are version-controlled separately in `templates/cursor/user-rules.md` and copied manually into Cursor Settings. Riggverk does not write undocumented Cursor rule state.

## The managed block

Installed rules files are shared with you. The app owns only the base between these marker lines (at column 0, outside code fences, one pair per file):

```text
<!-- BEGIN AGENT-WORKSPACE BASE ... -->
...base...
<!-- END AGENT-WORKSPACE BASE -->
```

Everything before or after the block is yours and is kept byte-for-byte. Put your refinements below the END marker; they override the base where they conflict (the base says so in its Priority section). Do not edit inside the block.

| File state | What Install does |
| --- | --- |
| absent | creates the file with the block |
| block equals the bundled base | nothing |
| block equals an earlier shipped base | updates the block; your text stays |
| block edited by you | conflict `base_block_edited`; file untouched |
| no markers, equals an earlier base or empty | wraps it in the block after a full backup |
| no markers, anything else | conflict `legacy_diverged`; file untouched |
| duplicate, unpaired, or reordered markers; not UTF-8; over 4 MB | conflict `malformed_markers`; nothing written |
| Pi: `AGENTS.override.md` next to the file | conflict `masked_by_override`; left as is |
| Pi: no `AGENTS.md`, but `CLAUDE.md` in the same folder | conflict `peer_context_file`; nothing created |

Resolving a conflict on the harness page: `d` shows the diff, `v` (**Convert**) writes the current base as the block and moves the sections you changed (or added) below the END marker, previewed and backed up, and `m` (**Leave as is**) records that you manage the file; the app then reports "base updates available, you manage this file" and does not write it until you convert. `:rules` does the same from the command line. A rollback of a block update restores only the previous block, so text you added afterwards stays.

Codex reads `AGENTS.override.md` instead of `AGENTS.md` when it is non-empty, which silently drops the base. The Codex runtime pane warns about it.

Pi loads one context file per folder: `AGENTS.override.md`, else `AGENTS.md`, else `CLAUDE.md`. An `AGENTS.override.md` hides the block, and a new `AGENTS.md` would hide your `CLAUDE.md`, so the app refuses both and leaves the other file alone; remove, rename, or merge it first. Convert and Leave as is are not offered for these two. The folders the app creates for Pi's file are owner-only.

Kilo loads one global rules file: its own `AGENTS.md`, else `~/.claude/CLAUDE.md`. Once the managed file exists, Kilo stops reading `~/.claude/CLAUDE.md`, so anything you want Kilo to keep from there belongs below the END marker. The review of a new Kilo file and the Kilo page say so.

VS Code can load both `~/.claude/CLAUDE.md` and `~/.copilot/copilot-instructions.md` in Copilot sessions, so with Claude's rules managed the shared base may appear twice there. The Copilot CLI reads only `~/.copilot`.

## Shared semantic agent bodies

Shared role instructions live under `agent-specs/`.

`scripts/generate-agent-adapters.py` combines each shared body with harness-native metadata. Generated files must not be edited independently.

## Harness-native adapters

### OpenCode

OpenCode Markdown agents live under `agents/` and install to `~/.config/opencode/agents/`.

OpenCode includes:

- architect — primary implementation orchestrator with bounded bash and approved subagent delegation
- repo-scout — read-only repository mapping
- inspector — read-only post-implementation review
- sentinel — read-only security review
- scribe — documentation-only edits (`README.md`, `docs/**`, and related doc files)
- verifier — non-destructive verification commands only

OpenCode permissions are generated from `templates/opencode.policy.json` plus `templates/opencode/agents/*.role.json`. Edit the role sources and policy, not generated `agents/*.md` headers.

### Claude Code

Claude-native Markdown subagents live under `templates/claude/agents/` and install to `~/.claude/agents/`.

Claude Code includes:

- repo-scout
- inspector
- sentinel
- scribe
- verifier

Claude-specific tools, permission mode, and turn limits belong in Claude headers. Claude settings, authentication, trust state, and MCP credentials remain Claude-managed.

### Codex

Codex custom agents are TOML files under `templates/codex/agents/` and install to `~/.codex/agents/`.

Codex includes:

- repo_scout
- inspector
- security_reviewer
- verifier

### Cursor

Cursor agents live under `templates/cursor/agents/` and install through native Rust setup to `~/.cursor/agents/`.

Cursor includes:

- repo-scout
- inspector
- security-reviewer
- verifier
- browser-qa
- release-checker

Cursor global setup also manages the canonical skill catalog and the named Playwright MCP entry. User Rules, Auto Review, general permissions, and project `.cursor/*` remain manual or project-owned.

GitHub Copilot, Pi, and Kilo (the opt-in light tier) get the named Playwright MCP entry in their own MCP file as well: `~/.copilot/mcp-config.json`, `~/.pi/agent/mcp.json`, and `kilo.jsonc` (else `kilo.json`) in Kilo's config folder. Targets `copilot_mcp` and `pi_mcp` are on by default; `kilo_mcp` is off until you switch it on, because Kilo's main config file may hold provider keys. The app edits strict JSON only and changes only that entry: a file with comments or a trailing comma, or an entry named `playwright` that is yours, is left as is.

## Changing the shared rules and agents

Rules and agents installed by the app come from the app's bundle. To change them for everyone, edit them in the app source repository:

1. Edit `templates/global-agent-rules.md`, a rules appendix, or a body under `agent-specs/`.
2. Run the relevant generator with `--write`, then with `--check` (`generate-agent-rules.py`, `generate-agent-adapters.py`).
3. Rebuild the app and install from the harness pages (`u`, review, `y`).

The Library shows these copies read-only. Editing a copy in the installed workspace outside the app changes only that copy and freezes it against updates. For a personal tweak to a rules file, write it below the managed block instead, in your editor or in the Library (Rules, your rules files).

Existing files that Install would overwrite are backed up first. Unknown and unrelated harness files are preserved.
