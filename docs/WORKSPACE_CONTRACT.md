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

Bundled resources are immutable installation input. The explicit **Install or Update** action:

- write only below the resolved workspace root
- previews artifact-level creates, updates, removals, and conflicts
- updates only allowlisted managed projections
- preserves unknown and diverged unowned files
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

- Codex: `$CODEX_HOME/skills` (typically `~/.codex/skills`)
- OpenCode: `~/.config/opencode/skills`
- Claude Code: `~/.claude/skills`
- Cursor: `~/.cursor/skills`

All 21 current bundled skills target Codex, OpenCode, Claude, and Cursor. Sync-all derives expected skills from the same compatibility metadata used by health checks.

## Skill ownership and cleanup

Installed skill files are user-owned after installation. Agent Workspace may:

- create missing managed copies
- report synced or diverged copies
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

Agent Workspace manages only allowlisted Codex config defaults in `~/.codex/config.toml`: `model`, `model_reasoning_effort`, `approval_policy`, `approvals_reviewer`, `sandbox_mode`, `apps._default.approvals_reviewer`, and `apps._default.default_tools_approval_mode`. The merge scripts read and write those scalar values only; user personality, MCP entries, unrelated tables, comments, and unsupported structures are preserved or cause a safe refusal with zero mutation.

App-shaped legacy top-level profile selectors (`profile = "safe"` / `"workspace-write"`) and legacy `[profiles.safe]` / `[profiles.workspace-write]` tables are removed only during migration when they still carry app-shipped values. Legacy profile handling is migration-only; Agent Workspace does not generally own or rewrite arbitrary Codex profiles. Same-line inline comments on managed scalar assignments are preserved; ambiguous managed lines refuse safely.

### Claude Code

Agent Workspace manages Claude rules, native subagents, and skills. Claude settings, authentication, trust state, caches, and user-scoped MCP credentials remain Claude-managed and are not read or written by Agent Workspace.

### Cursor

Cursor global agents, canonical skills, and the named Playwright MCP entry are managed by native Rust operations. User Rules and Auto Review remain manual IDE settings. Project `.cursor/*`, project agents, project MCP, `.cursorignore`, and `AGENTS.md` are not written by the global setup flow.

## Backups and writes

Writes use allowlisted targets and explicit arguments. Existing managed files are backed up before replacement. Config merges use staged files and post-write validation. Backup roots and target roots reject filesystem roots, drive roots, home roots, traversal, and symlink escapes.

The frontend supplies named actions and bounded identifiers, not shell commands or arbitrary destination paths.

## Managed installation

Surface status in the app is derived from artifact-level detection. OpenCode Config aggregates `opencode.json`, `tui.json`, and the Playwright MCP artifact; agents and skills surfaces aggregate every managed artifact for that harness.

Preview issues a bounded in-memory token scoped to workspace, pending surfaces, and fingerprint. Rapid identical previews receive distinct tokens. Token issuance fails closed when the registry cannot be locked. Apply consumes the token only after preflight succeeds and immediately before the first mutation. Tokens expire, are pruned deterministically by age, and are never logged or persisted to disk. App restart invalidates stale previews.

Filesystem-mutating installation and rollback commands acquire a process-wide non-blocking mutation guard. A second mutation returns `setup operation already in progress` without filesystem changes or misleading transaction evidence. Preview, health, discovery, planning, and rollback dry-run remain available.

Packaged source and runtime destination are resolved independently by `SetupRoots`; installation refuses to run if they resolve to the same root. Path safety is centralized in `path_safety.rs` (symlink and containment checks, including dangling symlinks via `symlink_metadata`). Bounded directory copy/remove without following symlinks lives in `safe_filesystem.rs`; callers pass an explicit allowlisted root, and copy/reject paths validate destination symlinks and parent chains before mutation.

Managed ownership is recorded in `.agent-workspace/managed-state.json` schema 2 with stable SHA-256 digests. First-run adoption and stale cleanup require an exact canonical or historical digest. Unknown files and modified historical copies remain conflicts and are never claimed or deleted.

OpenCode agent permissions are composed from `templates/opencode.policy.json` plus `templates/opencode/agents/*.role.json`. Restrictive roles use `composition.replace_sections` so inherited bash/edit capabilities are replaced, not shallow-merged. `scripts/validate_opencode_permissions.py` guards the semantic contract in release-check.

Transactions persist manifest status fail-closed, validate backups before mutation, reject symlink parent chains, and record per-artifact apply, validation, rollback, managed digest, and full digest state. The exact prior managed-state bytes or prior absence are part of the transaction and are restored on rollback. Managed state is published atomically before the transaction becomes completed.

Automatic rollback uses the workspace root validated at transaction start, not the process working directory. Before a new apply, interrupted prepared, applying, failed, rolling-back, or rollback-failed transactions for the same workspace are reconciled or the new apply is blocked. Explicit rollback sets per-artifact `in_flight` before mutation, persists progress after each artifact, and refuses to overwrite content changed after apply.

## Full uninstall

Full uninstall previews removable, preserved, and merge-managed artifacts before any mutation:

- **Removable** — installed files with proven app ownership (managed-state digest, historical ownership, or current bundled source match).
- **Preserved** — modified or unknown user files that do not match an app-owned proof.
- **Merge-managed** — user-owned config files where only allowlisted keys were merged; the file is never deleted wholesale.

Uninstall creates a rollback-capable backend transaction with per-file backups. Preview and rollback dry-run perform zero filesystem mutation. Actual rollback restores exact prior app-owned bytes from the transaction backup and refuses occupied or changed targets.

The frontend retains only the most recent uninstall transaction ID for the current app session. **Recover previous uninstall** remains visible after uninstall makes the workspace invalid, but recovery state is not persisted in AppSettings, localStorage, or a transaction registry. Closing or restarting the app loses the recovery affordance even though backend transaction evidence may remain on disk. Recovery requires a read-only dry-run before mutation and explicit confirmation to restore.

## Harness enablement

`AppSettings.enabled_harness_ids` is a persisted positive allowlist containing `codex`, `opencode`, `claude`, and `cursor`. New settings and older settings without the field enable all four. Unknown values are ignored, duplicates are removed, canonical order is preserved, and an empty list is valid.

Harness enablement is separate from `enabled_target_ids`. Disabling a harness hides its application surfaces, skips normal health and status path reads, and rejects new managed writes at backend command boundaries. It does not alter target preferences, existing harness files, managed ownership state, backups, or recovery transactions. Re-enabling restores UI and status checks but never installs automatically.

Workspace installation remains available with every harness disabled. Full uninstall remains global across proven app-owned artifacts, including disabled harnesses. Rollback restores the recorded transaction independently of current harness visibility.

## Security boundaries

The workspace must not contain credentials or private runtime state. Agent Workspace does not inspect `.env` files, private keys, auth stores, OAuth state, shell history, Claude trust state, or unrelated personal files.

No frontend-supplied shell strings, `sh -c`, unrestricted paths, or generic filesystem browsing are part of the contract.
