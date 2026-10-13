# Agent Workspace

Local Tauri control panel for managing a shared coding-agent workspace across Codex, OpenCode, Claude Code, and Cursor. Keyboard-first terminal-style UI; every write is reviewed before it happens.

The repository contains the application and its canonical bundled workspace. Installed workspaces and harness files are downstream user-owned data.

## Repository layout

- `src/` - React and Vite frontend (shell, keyboard layer, pages, Library, Prompt Builder, Repo Dashboard).
- `src-tauri/` - trusted filesystem operations, native integrations, validation, backups, and Tauri commands.
- `resources/default-workspace/` - canonical bundled workspace content (the only source for installs).
- `scripts/` - repository checks, generators, contract guards, and release verification.
- `docs/` - workspace contract, security model, release and smoke checklists.

The installed runtime workspace lives at `~/.config/agent-workspace` unless a custom workspace is chosen in Settings or `AGENT_WORKSPACE_PATH` overrides it.

## Development

Requirements:

- Node.js 22 (CI version; Vite 8 needs 20.19+ or 22.12+) and npm 10+
- stable Rust toolchain (CI pins 1.97.1)
- Python 3 and Bash for the generators, merge scripts, and release check

```bash
npm install
npm run tauri dev     # the app
npm run dev           # browser only: Vite on :1420, no Tauri backend
npm run tauri build
```

Browser-only visual QA: open `http://localhost:1420/?mock=<scenario>` while `npm run dev` runs. `main.tsx` swaps in `src/dev/mockBackend.ts` (dev builds only). Scenarios: `default`, `conflict`, `fresh`, `error`, `empty`; `&theme=light|dark|system` sets the appearance.

Release verification:

```bash
./scripts/release-check.sh
```

Do not claim a release check passed unless it was run and completed successfully. See `docs/RELEASE.md`.

## Workspace ownership

1. The source repository.
2. Bundled defaults under `resources/default-workspace/` (packaged read-only with the app).
3. The installed user-owned runtime workspace.
4. Harness-native files under each tool's documented home directory.

**Install or Update** is the one write workflow. Press `u` on the Workspace page (for the workspace bundle or the harness under the cursor) or on a harness page (that harness). The app computes a plan, shows every create, update, remove, and conflict row, and writes nothing until you press `y`. `p` previews without an apply path; `n` or Escape cancels. A backup and a rollback-capable transaction are recorded before the first write; `z` (or `:rollback`) restores the last transaction after a dry run and a confirm.

Both the runtime workspace and every harness file are installed from the packaged bundle, never from the runtime workspace. Editing a bundled file in the runtime workspace freezes that file from future updates (it becomes a conflict) and does not change what harnesses receive. See `docs/WORKSPACE_CONTRACT.md` for the contract.

## Skills

The bundled semantic catalog contains exactly 23 canonical skills (17 general, 1 WordPress, 5 Kretsverket). `retro` is user-invoked only.

```text
skills/<skill>/SKILL.md
skills/<group>/<skill>/SKILL.md
```

One optional group level is supported; deeper nesting is invalid. Harness adapters are generated from the canonical catalog plus compact overlays (`templates/skills/<harness>/<skill>/SKILL.md`, `metadata/skill-adapters.json`). Run `python3 scripts/generate-skill-adapters.py --write` after changing canonical skills or overlays; never edit generated adapters by hand.

Installed layout is flat and single-file: `<harness-skill-root>/<skill-name>/SKILL.md`. Global destinations: Codex `$CODEX_HOME/skills` (typically `~/.codex/skills`), OpenCode `~/.config/opencode/skills`, Claude Code `~/.claude/skills`, Cursor `~/.cursor/skills`.

All skills support all four harnesses. Skills surfaces are not gated by target toggles. Deprecated Agent Workspace skills are matched against bundled reference snapshots: identical managed copies are removed after backup, diverged and unknown copies are preserved.

## Rules

Rules files are merge-managed. Install writes the shared base (`templates/global-agent-rules.md` plus a harness appendix, composed under `templates/sync/`) between `BEGIN AGENT-WORKSPACE BASE` and `END AGENT-WORKSPACE BASE` markers; everything outside the markers is yours and is kept byte-for-byte. Add refinements below the block; they override the base.

Targets: Codex `$CODEX_HOME/AGENTS.md` (default `~/.codex/AGENTS.md`), OpenCode `~/.config/opencode/AGENTS.md`, Claude Code `~/.claude/CLAUDE.md`. Cursor User Rules stay a manual copy of `templates/cursor/user-rules.md`.

An edited block or a pre-existing file without markers is a conflict: Install leaves it alone. Resolve it with a diff, **Convert** (current base becomes the managed block, your changed sections move below it; previewed and backed up), or **Leave as is**. Harness pages expose these as `d` diff, `v` convert, `m` leave as is, and `:rules`. Details and the full plan table are in `docs/WORKSPACE_CONTRACT.md`.

## Agents

Shared semantic bodies live under `agent-specs/`; `scripts/generate-agent-adapters.py` composes the harness-native adapters:

- OpenCode: six Markdown agents under `agents/` (`architect` is the primary agent; plus repo-scout, inspector, sentinel, scribe, verifier).
- Claude Code: five subagents under `templates/claude/agents/` (repo-scout, inspector, sentinel, scribe, verifier).
- Codex: TOML agents under `templates/codex/agents/` (four).
- Cursor: six agents under `templates/cursor/agents/` (repo-scout, inspector, security-reviewer, verifier, browser-qa, release-checker).

Generated adapters must stay current with their sources; repository checks fail on drift.

## Harness ownership

- **OpenCode**: composed rules, native agents, skill adapters, managed config keys, `tui.json`, and the named Playwright MCP entry. User provider blocks, unrelated MCP entries, and unknown keys are preserved.
- **Codex**: rules, TOML agents, skill adapters, and allowlisted config defaults in `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). `approval_policy`, `approvals_reviewer`, `sandbox_mode`, and `apps._default.*` follow the template. `model` and `model_reasoning_effort` are create-only: written (`gpt-6.1-sol`, `xhigh`) only when the file has no value, then yours. The `codex_config` target is off by default. A non-empty `AGENTS.override.md` makes Codex ignore `AGENTS.md`; Codex health warns about it. Legacy app-shaped profile selectors and tables are removed during migration only. Copies under the old `~/.agents/skills` location are detected for migration to `$CODEX_HOME/skills`; diverged copies stay conflicts.
- **Claude Code**: rules, subagents, and skill adapters. Claude settings, authentication, trust state, caches, and user-scoped MCP credentials stay Claude-managed and are not read or written.
- **Cursor**: six global agents, skill adapters, and the named Playwright MCP entry in `~/.cursor/mcp.json`, via native Rust operations. User Rules and Auto Review stay manual. Project `.cursor/*`, project agents, project MCP, `.cursorignore`, and `AGENTS.md` are never written.

## Application surfaces

Tabs in order (press `1`-`9`; disabled harnesses are hidden and the rest renumber): workspace, codex, opencode, cursor, claude, library, repo, prompts, settings. `?` lists every key and command; `:` opens the command line.

- Workspace - harness list with install state, surfaces, installed-state matrix, release-check, uninstall with preview, session-scoped **Recover previous uninstall**, backups folder, output.
- Codex, OpenCode, Cursor, Claude - target toggles (Space, autosaved), surfaces, runtime health, install review. OpenCode adds the model override.
- Library - an items list and one document pane (rendered, or its source while editing) for docs, rules, skills, runtime agents, configs, and Brain Setup. Saves write the runtime workspace only (`:w`, `:q`).
- Repo Dashboard - local-git-first repository and docs insight with bounded `git fetch --prune` and optional `gh` enrichment. Open trusted repositories only.
- Prompt Builder - deterministic copy-ready prompt templates (Prompt, Goal Prompt, Batch Prompt) with optional repository context.
- Settings - harnesses, appearance, text size, motion, landing page, colors, workspace.

Full uninstall removes proven app-owned files, preserves modified and unknown files, leaves merge-managed configs and rules files in place, and records a rollback-capable transaction. **Recover previous uninstall** exists only for the current app session.

### Settings

Stored in `settings.json` under the app support dir; autosaved.

| Setting | Default | Description |
| --- | --- | --- |
| `enabled_harness_ids` | `["codex", "opencode", "claude", "cursor"]` | Positive allowlist for visible and writable harnesses. Disabling hides the harness UI and blocks new managed writes without deleting files or target preferences. |
| `enabled_target_ids` | `["codex_rules", "opencode_rules", "claude_rules", "opencode_agents", "claude_agents", "codex_agents", "opencode_config", "cursor_setup"]` | Targets Install is allowed to write. Toggle with Space on harness pages. A target that is off is skipped by preview, apply, and status. |
| `workspace_path` | unset (`~/.config/agent-workspace`) | Custom workspace folder chosen in Settings (`c` choose, `R` reset to default). It must pass the workspace markers. Generator scripts the app runs always come from the bundled read-only copy, not from this folder. |
| `appearance` | `"dark"` | `"dark"`, `"light"`, or `"system"`. |
| `app_font_size` | `"medium"` | `"small"`, `"medium"`, `"large"`, `"extra-large"`. |
| `motion` | `"full"` | `"full"`, `"subtle"`, or `"off"`. `"off"` stops animations and transitions; the OS reduced-motion preference always counts as `"off"`. Older files with `reduce_motion: true` load as `"off"`; the legacy `reduce_motion` flag is still written beside it. |
| `landing_view` | `"start"` | View shown on start: `"start"`, `"repo-dashboard"`, `"prompts"`, `"library"`. |

Target toggles gate these surfaces: rules, agents, and config per harness, and Cursor agents plus MCP (`cursor_setup`). `codex_config` is the only target off by default because it rewrites the Codex approval and sandbox posture. Settings files from before target gating are migrated once: every default stays on, and any target you had enabled or whose surface is already managed stays on, so nothing already installed is dropped. Skills and the workspace bundle are never gated.

Harness enablement is an explicit preference, not tool detection. Re-enabling restores UI, health checks, and target selections but does not install. Full uninstall still covers proven app-owned files of disabled harnesses.

### Environment variables

| Variable | Scope | Effect |
| --- | --- | --- |
| `AGENT_WORKSPACE_PATH` | app, dev/test | Overrides the workspace path. Takes precedence over Settings. |
| `AGENT_WORKSPACE_BACKUP_DIR` | app, scripts | Overrides the backup root. Must not be `/`, the home directory, or a drive root. |
| `CODEX_HOME` | app, scripts | Codex home for config, rules, agents, and skills (default `~/.codex`). |
| `CODEX_SKILLS_PATH`, `CLAUDE_SKILLS_PATH`, `OPENCODE_SKILLS_PATH`, `CURSOR_SKILLS_PATH`, `CURSOR_AGENTS_PATH`, `CURSOR_MCP_CONFIG_PATH` | app | Skill, agent, and MCP path overrides for isolation and tests. |
| `PLAYWRIGHT_MCP_CONFIG_PATH`, `PLAYWRIGHT_BROWSERS_PATH` | app, scripts | Playwright MCP config file and browser cache. Do not set `PLAYWRIGHT_BROWSERS_PATH=0`. |
| `XDG_CONFIG_HOME` | app, scripts (Linux) | Moves the app support and backup dirs. |
| `CODEX_CONFIG_PATH`, `CODEX_AGENTS_PATH`, `OPENCODE_AGENTS_PATH`, `CLAUDE_RULES_PATH`, `*_AGENTS_DIR` | scripts only | Target overrides for the CLI scripts; the app ignores them. |

Overrides are honored in release builds too. Use them with a temporary `HOME` when testing.

## Security model

- Frontend actions invoke named backend commands only; no frontend-supplied shell strings, no `sh -c`, no Tauri shell plugin.
- Install destinations are allowlisted and path-contained; managed paths reject symlinks.
- Existing files that Install or a Library save would overwrite are backed up first, owner-only (0700 dirs, 0600 files on Unix).
- Config and rules merges preserve user-owned content or refuse unsafe writes with zero mutation.
- Credential-bearing files and unrelated personal files are outside the workspace contract.
- Python generators and merge scripts run from the bundled copy, never from the workspace. The user-triggered release check is the exception: it runs `scripts/release-check.sh` from the workspace if you put one there, after a confirmation that names the folder.
- Repo Dashboard runs `git fetch --prune` and `gh` against the repository you select, with your own git and `gh` credentials. Git runs with fsmonitor and hooks disabled. Open trusted repositories only.

See `docs/SECURITY_MODEL.md` for the full boundaries.

## Verification

CI runs the POSIX installer and release checks on Ubuntu and macOS. Windows CI runs frontend and native Rust app checks; the Bash scripts are not supported there (see `docs/RELEASE.md`).

```bash
python3 scripts/generate-agent-adapters.py --check
python3 scripts/generate-skill-adapters.py --check
python3 scripts/generate-agent-rules.py --check
python3 scripts/generate-default-opencode-config.py --check
python3 scripts/check-skill-routing.py
python3 scripts/check-default-workspace-copy-list.py
python3 scripts/check-readme-docs-drift.py
npm run typecheck
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
./scripts/release-check.sh
```

`release-check.sh` runs the apply smokes in temporary `HOME` directories; it never touches the real home. UI, dialogs, filesystem actions, and native harness setup still need the manual Tauri smoke in `docs/APP_RELEASE_SMOKE.md`.

See [NOTICE.md](./NOTICE.md) for third-party license information.
