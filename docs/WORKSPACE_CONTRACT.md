# Workspace Contract

## Scope

A workspace is a user-owned runtime data directory containing docs, skills, templates, agents, metadata, and allowlisted scripts. It is separate from the Agent Workspace source repository.

The canonical bundled workspace source lives under `resources/default-workspace/`. The installed workspace normally lives at `~/.config/agent-workspace`; `AGENT_WORKSPACE_PATH` may override it for development and tests.

## Required runtime markers

A valid workspace contains:

- `.agent-workspace/workspace.json`
- `README.md`
- `skills/`
- `templates/global-agent-rules.md`
- `templates/opencode.json`
- `templates/codex/config.toml`
- `templates/cursor/manifest.json`
- `templates/cursor/agents/`
- `templates/cursor/rules/`
- `templates/cursor/mcp/mcp.example.json`
- `scripts/bootstrap.sh`
- `scripts/install-agent-rules.sh`
- `scripts/install-runtime-agents.sh`
- `scripts/install-opencode-config.sh`
- `scripts/install-codex-config.sh`
- `scripts/install-skills.sh`
- `scripts/install-cursor-workspace.sh`

Validation is read-only. It does not run scripts, install files, or inspect credential-bearing state.

## Bundled resources

The default workspace currently contains 21 bundled skills, shared semantic agent bodies, harness-native agent adapters, composed rule targets, config templates, runtime scripts, and operator documentation.

Bundled resources are copied only by explicit install, repair, or update-resources actions. These actions:

- write only below the resolved workspace root
- copy missing or zero-byte bundled files
- never overwrite non-empty user edits
- never execute copied scripts
- reject unsafe paths and symlink escapes

## Skill source layout

The source workspace supports exactly these layouts:

```text
skills/<skill>/SKILL.md
skills/<group>/<skill>/SKILL.md
```

One optional group level is supported for source organization. Kretsverket skills use `skills/kretsverket/<skill>/SKILL.md`.

Any deeper `SKILL.md` is invalid. Validators scan descendants only to detect illegal nesting; they do not recursively discover arbitrary skill trees. Symlinked skill roots, groups, skill directories, and nested descendants are rejected.

Skill names from frontmatter must be globally unique across root-level and grouped sources.

## Installed skill layout

Source grouping never changes harness installation layout. Every supported skill installs flat:

```text
<harness-skill-root>/<skill-name>/SKILL.md
```

Global destinations:

- Codex: `~/.agents/skills`
- OpenCode: `~/.config/opencode/skills`
- Claude Code: `~/.claude/skills`
- Cursor: `~/.cursor/skills`

All 21 current bundled skills target Codex, OpenCode, Claude, and Cursor. Sync-all derives expected skills from the same compatibility metadata used by health checks.

## Skill ownership and cleanup

Installed skill files are user-owned after installation. Agent Workspace may:

- create missing managed copies
- report synced or diverged copies
- repair missing copies
- remove only known deprecated copies that still match an Agent Workspace reference snapshot

Diverged deprecated copies and unknown skills are preserved.

Deprecated removal creates a transaction backup before deletion. Rollback validates the transaction, resolves the current destination from the harness registry, rejects destination mismatch and occupied targets, stages restores, and preserves the backup transaction.

## Rules

`templates/global-agent-rules.md` is the editable shared core. Harness appendices live under `templates/rules/`. Generated composed rules live under `templates/sync/`.

Installed rule targets:

- Codex: `~/.codex/AGENTS.md`
- OpenCode: `~/.config/opencode/AGENTS.md`
- Claude Code: `~/.claude/CLAUDE.md`

Rule writes are explicit, allowlisted, backed up when replacing diverged files, and separate from editing workspace source templates.

## Agents

Shared semantic instructions live under `agent-specs/`. `scripts/generate-agent-adapters.py` creates harness-native adapters.

Harness ownership:

- OpenCode: Markdown agents under `agents/`
- Claude Code: native Markdown subagents under `templates/claude/agents/`
- Codex: TOML agents under `templates/codex/agents/`
- Cursor: native Markdown agents under `templates/cursor/agents/`

Claude Code receives five native subagents: repo-scout, inspector, sentinel, scribe, and verifier. Claude-specific tool and permission metadata belongs in Claude headers, not shared semantic bodies.

Cursor receives six global agents: repo-scout, inspector, security-reviewer, verifier, browser-qa, and release-checker.

Generated outputs must match their source bodies and native metadata. Repository checks fail on stale adapters.

## Config ownership

### OpenCode

Agent Workspace owns only allowlisted managed keys and the named Playwright MCP entry. Unknown keys, user provider blocks, and other MCP entries are preserved.

The editable sources are:

- `templates/opencode.base.json`
- `templates/opencode.policy.json`

`templates/opencode.json` is generated and read-only in the Library editor.

### Codex

Agent Workspace manages a narrow set of documented top-level and profile fields in `~/.codex/config.toml`. User model selection, unrelated profiles, MCP entries, comments, and unsupported structures are preserved or cause a manual-review refusal.

### Claude Code

Agent Workspace manages Claude rules, native subagents, and skills. Claude settings, authentication, trust state, caches, and user-scoped MCP credentials remain Claude-managed and are not read or written by Agent Workspace.

### Cursor

Cursor global agents, canonical skills, and the named Playwright MCP entry are managed by native Rust operations. User Rules and Auto Review remain manual IDE settings. Project `.cursor/*`, project agents, project MCP, `.cursorignore`, and `AGENTS.md` are not written by the global setup flow.

## Backups and writes

Writes use allowlisted targets and explicit arguments. Existing managed files are backed up before replacement. Config merges use staged files and post-write validation. Backup roots and target roots reject filesystem roots, drive roots, home roots, traversal, and symlink escapes.

The frontend supplies named actions and bounded identifiers, not shell commands or arbitrary destination paths.

## Unified setup lifecycle

Surface status in the app is derived from artifact-level detection. OpenCode Config aggregates `opencode.json`, `tui.json`, and the Playwright MCP artifact; agents and skills surfaces aggregate every managed artifact for that harness.

Preview issues a bounded in-memory preview token scoped to workspace, pending surfaces, fingerprint, and purpose (apply or repair). Rapid identical previews receive distinct tokens. Token issuance fails closed when the registry cannot be locked. Apply and repair consume the token only after preflight succeeds and immediately before the first mutation. Tokens expire, are pruned deterministically by age, and are never logged or persisted to disk. App restart invalidates stale previews.

Filesystem-mutating setup commands (apply, repair, explicit rollback execution, deprecated skill removal and its rollback) acquire a process-wide non-blocking mutation guard. A second mutation returns `setup operation already in progress` without filesystem changes or misleading transaction evidence. Preview, health, diff, discovery, planning, and rollback dry-run remain available.

Path safety is centralized in `path_safety.rs` (symlink and containment checks, including dangling symlinks via `symlink_metadata`). Bounded directory copy/remove without following symlinks lives in `safe_filesystem.rs`. Deprecated skill cleanup uses both; it does not duplicate weaker local symlink helpers.

Transactions persist manifest status fail-closed, validate backups before mutation, reject symlink parent chains, record per-artifact apply/validation/rollback state and post-apply digests, and refuse explicit rollback when managed content changed after apply. Automatic rollback uses the workspace root validated at transaction start—not the process working directory. Explicit rollback sets per-artifact `in_flight` before each filesystem mutation, persists progress after each artifact, and reconciles interrupted `in_flight` artifacts by comparing current state to post-apply and backup digests before retrying. Transactions in `rolling_back` or `rollback_failed` resume; already `restored` artifacts are skipped; when no eligible artifacts remain the transaction finalizes to `rolled_back` or `rollback_failed` without spurious filesystem writes. Rollback dry-run reports already restored, still-required, and conflicted artifacts with zero manifest writes. Codex managed merge and rollback use the line-preserving Python merge owner: same-line inline comments on managed scalar assignments are preserved, or the patch refuses with zero mutation on conflict or malformed TOML. Repair is create-only per artifact and does not run surface scripts that would update diverged siblings. Failed repair with a transaction ID remains eligible for explicit rollback retry when dry-run reports remaining artifacts.

## Repair

Workspace repair and update-resources restore missing bundled source files only. Harness repair installs missing managed resources but does not silently overwrite diverged user files or delete unknown resources.

## Security boundaries

The workspace must not contain credentials or private runtime state. Agent Workspace does not inspect `.env` files, private keys, auth stores, OAuth state, shell history, Claude trust state, or unrelated personal files.

No frontend-supplied shell strings, `sh -c`, unrestricted paths, or generic filesystem browsing are part of the contract.
