# Agent Workspace

Local Tauri control panel for managing a shared coding-agent workspace across Codex, OpenCode, Claude Code, and Cursor.

The repository contains the application and its canonical bundled workspace. Installed workspaces and harness files are downstream user-owned data.

## Repository layout

- `src/` - React and Vite frontend.
- `src-tauri/` - trusted filesystem operations, native integrations, validation, backups, and Tauri commands.
- `resources/default-workspace/` - canonical bundled workspace content.
- `scripts/` - repository checks, generators, contract guards, and release verification.
- `docs/` - architecture, workspace contract, security, release, and operator documentation.

The installed runtime workspace normally lives at `~/.config/agent-workspace`. `AGENT_WORKSPACE_PATH` may override it for development and tests.

## Development

Requirements:

- Node.js 20+
- npm 10+
- stable Rust toolchain

Run locally:

```bash
npm install
npm run tauri dev
```

Build:

```bash
npm run tauri build
```

Release verification:

```bash
./scripts/release-check.sh
```

Do not claim a release check passed unless it was run and completed successfully.

## Workspace ownership

Agent Workspace distinguishes between:

1. The source repository.
2. Bundled defaults under `resources/default-workspace/`.
3. The installed user-owned runtime workspace.
4. Harness-native files under each tool's documented home directories.

The app exposes one explicit **Install or Update** workflow. It previews artifact-level creates, updates, removals, and conflicts before mutation. Packaged resources are immutable input; runtime workspace and harness files are user-owned destinations.

See `docs/WORKSPACE_CONTRACT.md` for the complete contract.

## Skills

The bundled catalog contains exactly 21 skills.

Source layouts:

```text
skills/<skill>/SKILL.md
skills/<group>/<skill>/SKILL.md
```

One optional group level is supported for source organization. Deeper skill nesting is invalid.

Installed layout remains flat:

```text
<harness-skill-root>/<skill-name>/SKILL.md
```

Global destinations:

- Codex: `$CODEX_HOME/skills` (typically `~/.codex/skills`)
- OpenCode: `~/.config/opencode/skills`
- Claude Code: `~/.claude/skills`
- Cursor: `~/.cursor/skills`

All current bundled skills support all four harnesses. There are no skill profiles or persistent per-harness skill selections.

Deprecated Agent Workspace skills are classified against bundled reference snapshots. Identical managed copies may be removed after backup; diverged and unknown copies are preserved.

## Rules

`resources/default-workspace/templates/global-agent-rules.md` is the editable shared core.

Harness-specific appendices live under `resources/default-workspace/templates/rules/`. Generated composed targets live under `resources/default-workspace/templates/sync/`.

Installed targets:

- Codex: `~/.codex/AGENTS.md`
- OpenCode: `~/.config/opencode/AGENTS.md`
- Claude Code: `~/.claude/CLAUDE.md`

Rule writes are separate from editing bundled source templates.

## Agents

Shared semantic bodies live under `resources/default-workspace/agent-specs/`.

`scripts/generate-agent-adapters.py` composes harness-native adapters:

- OpenCode Markdown agents under `resources/default-workspace/agents/`
- Claude Code subagents under `resources/default-workspace/templates/claude/agents/`
- Codex TOML agents under `resources/default-workspace/templates/codex/agents/`
- Cursor agents under `resources/default-workspace/templates/cursor/agents/`

OpenCode uses `architect` as its primary local agent and `repo-scout` as the repository exploration subagent.

Claude Code receives five native subagents: repo-scout, inspector, sentinel, scribe, and verifier. Claude-specific tool and permission metadata belongs in Claude headers.

Cursor receives six global agents: repo-scout, inspector, security-reviewer, verifier, browser-qa, and release-checker.

Generated adapters must remain current with their shared body and harness metadata sources.

## Harness ownership

### OpenCode

Agent Workspace manages composed rules, native agents, the canonical skill catalog, selected config keys, and the named Playwright MCP entry.

User provider blocks, unrelated MCP entries, and unknown config keys are preserved.

### Codex

Agent Workspace manages rules, native TOML agents, the canonical skill catalog, and only the allowlisted top-level Codex config fields `approval_policy` and `sandbox_mode`. Legacy app-shaped profile selectors and profile tables are removed during migration only.

Copies under the previous `~/.agents/skills` app location are detected for migration to `$CODEX_HOME/skills`. Diverged copies remain conflicts and are not removed automatically.

### Claude Code

Agent Workspace manages rules, native subagents, and the canonical skill catalog.

Claude settings, authentication, trust state, caches, and user-scoped MCP credentials remain Claude-managed. The app does not inspect or write those surfaces.

### Cursor

Cursor global setup is owned by native Rust operations. Agent Workspace manages six global agents, the canonical skill catalog, and the named Playwright MCP entry.

Cursor User Rules and Auto Review remain manual IDE settings. Project `.cursor/*`, project agents, project MCP, `.cursorignore`, and `AGENTS.md` are not written by the global setup flow.

## Application surfaces

- Workspace - canonical path, unified Install or Update status, Installed State Map, full uninstall with preview, session-scoped **Recover previous uninstall**, advanced verification, backups, and release verification.
- Codex - managed installation status plus rules, agents, config, and skills health.
- OpenCode - managed installation status plus runtime health.
- Claude - managed installation status plus explicit manual settings/MCP boundaries.
- Cursor - managed installation status plus native runtime health and manual IDE steps.
- Library - docs, rules, skills, agents, configs, and Copy Brain.
- Prompt Builder - deterministic copy-ready prompt templates and optional repository context.
- Repo Dashboard - local-git-first repository and docs insight with optional bounded `gh` enrichment.
- Settings - enabled harnesses, appearance, text size, theme tokens, reduce motion, landing page, workspace metadata, and enabled target toggles.

Full uninstall removes proven app-owned files, preserves modified and unknown user files, leaves merge-managed configs in place, and records a rollback-capable transaction. **Recover previous uninstall** is available only for the current app session; restarting the app does not rediscover recovery automatically.

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `enabled_harness_ids` | `["codex", "opencode", "claude", "cursor"]` | Positive allowlist for visible and writable harnesses. Disabling hides harness UI and blocks new managed writes without deleting existing files or target preferences. |
| `enabled_target_ids` | `["codex_rules", "opencode_rules", "opencode_config"]` | Which sync targets are active. Edit from harness pages. |
| `app_font_size` | `"medium"` | UI font scale. Values: `"small"`, `"medium"`, `"large"`, `"extra-large"`. |
| `reduce_motion` | `false` | When `true`, disables pulse, scan, and flash animation classes. |
| `landing_view` | `"start"` | View shown on app start. Values: `"start"`, `"repo-dashboard"`, `"prompts"`, `"library"`. |

Sync targets excluded from defaults:
- `codex_config` — managed-field merge; user-owned TOML preserved.
- `claude_rules`, `claude_agents`, `codex_agents`, `opencode_agents`, `cursor_setup` — must be toggled on explicitly.

Harness enablement is an explicit preference, not automatic tool detection. Re-enabling restores UI, health checks, and prior target selections but does not install automatically. Full uninstall still considers proven app-owned artifacts from disabled harnesses, and rollback remains transaction-based regardless of current visibility.

## Security model

- Frontend actions invoke named backend commands only.
- No frontend-supplied shell commands.
- No `sh -c` or Tauri shell plugin.
- Filesystem destinations are allowlisted and path-contained.
- Existing managed files are backed up before replacement.
- Config merges preserve unknown user-owned content or refuse unsafe writes.
- Skill and workspace scans reject symlinks and unsafe nesting.
- Credential-bearing files and unrelated personal files are outside the workspace contract.
- Command output is bounded and must not expose private configuration.

See `docs/SECURITY_MODEL.md` for detailed boundaries.

## Verification

Primary checks include:

```bash
python3 scripts/generate-agent-adapters.py --check
python3 scripts/generate-agent-rules.py --check
python3 scripts/generate-default-opencode-config.py --check
python3 scripts/check-skill-routing.py
python3 scripts/check-default-workspace-copy-list.py
npm run typecheck
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
./scripts/release-check.sh
```

UI, dialogs, filesystem actions, and native harness setup also require manual Tauri smoke testing when automated checks cannot prove behavior.

See [NOTICE.md](./NOTICE.md) for third-party license information.
