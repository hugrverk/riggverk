# Agent Rules and Native Agents

## Shared rules source

`templates/global-agent-rules.md` is the editable shared rules core. It defines communication, security, bounded implementation, skill routing, verification, git behavior, and reporting.

Harness-specific appendices live under `templates/rules/`. `scripts/generate-agent-rules.py` composes the installed rule sources under `templates/sync/`.

Installed rule targets:

| Harness | Default path |
| --- | --- |
| Codex | `~/.codex/AGENTS.md` |
| OpenCode | `~/.config/opencode/AGENTS.md` |
| Claude Code | `~/.claude/CLAUDE.md` |

Cursor User Rules are version-controlled separately in `templates/cursor/user-rules.md` and copied manually into Cursor Settings. Agent Workspace does not write undocumented Cursor rule state.

## Shared semantic agent bodies

Shared role instructions live under `agent-specs/`.

`scripts/generate-agent-adapters.py` combines each shared body with harness-native metadata. Generated files must not be edited independently.

## Harness-native adapters

### OpenCode

OpenCode Markdown agents live under `agents/` and install to `~/.config/opencode/agents/`.

OpenCode includes:

- architect
- repo-scout
- inspector
- sentinel
- scribe
- verifier

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

## Sync workflow

1. Edit shared rules or semantic agent bodies.
2. Run the relevant generator with `--write` when generated files change.
3. Run the generator again with `--check`.
4. Review target diffs.
5. Apply the selected harness sync action.
6. Verify the installed status.

Existing diverged managed files are backed up before replacement. Unknown and unrelated harness files are preserved.
