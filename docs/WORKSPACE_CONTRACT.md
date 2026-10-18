# Workspace Contract

## Scope

A workspace is a user-owned runtime data directory containing docs, skills, templates, agents, metadata, and helper scripts. It is separate from the Riggverk source repository.

The canonical bundled workspace source lives under `resources/default-workspace/`. The installed workspace normally lives at `~/.config/agent-workspace`. The path resolves in this order: `AGENT_WORKSPACE_PATH` (development and tests), a valid custom path saved in Settings, the default.

Requirements on the machine: Python 3 (Codex and OpenCode merge and generator helpers). Missing `python3` surfaces as an error when a helper runs.

Install reads the bundled copy, never the runtime workspace. The runtime workspace is a user-owned copy that the app displays and the Library edits; editing it does not change what harnesses receive.

## Required runtime markers

A valid workspace contains:

- `.agent-workspace/workspace.json`
- `README.md`
- `skills/` (directory)
- `templates/global-agent-rules.md`
- `templates/opencode.json`
- `templates/codex/config.toml`
- `templates/cursor/agents/` (directory)
- `templates/cursor/rules/` (directory holding at least one `*.mdc` file)

Validation is read-only. It does not run workspace scripts, install files, or inspect credential-bearing state. Health checks that need the OpenCode generator run the bundled copy, not a script from the workspace.

## Bundled resources

The default workspace currently contains 25 canonical semantic skills, shared semantic agent bodies, harness-native agent adapters, composed rule targets, config templates, runtime scripts, and operator documentation.

Bundled resources are immutable installation input. The explicit **Install or Update** action (`u`, review, `y`):

- writes the workspace bundle below the resolved workspace root and harness artifacts below the user's home (or `$CODEX_HOME`)
- previews artifact-level creates, updates, removals, and conflicts, and writes only after confirmation
- skips surfaces whose target toggle or harness is off
- updates only allowlisted managed projections
- preserves unknown and diverged unowned files
- never executes workspace copies of scripts
- rejects unsafe paths and symlink escapes

### Conflicts

A file that exists but is not provably app-owned and unmodified is a conflict: Install skips it and reports it as preserved. Editing a bundled workspace file (for example in the Library) therefore freezes that file against future updates. To accept an update, move or delete your copy and run Install again; to keep your version, do nothing. Deleting `.agent-workspace/managed-state.json` removes the ownership proof and turns every previously managed file into a conflict, so do not delete it. It describes this machine's installs and should not be copied to another machine or committed. Rules files have their own conflict handling (below).

### Target toggles

`enabled_target_ids` selects which target surfaces Install may touch: rules, agents, and config per harness, plus Cursor agents and MCP (`cursor_setup`). Defaults enable every target except `codex_config`; the light tier adds `copilot_rules`, `pi_rules` and `kilo_rules`, which only matter once their harness is enabled. Skills and the workspace bundle are never gated. Settings files that predate gating are migrated once: defaults, plus every target already enabled or already holding managed records, so no installed surface is dropped. Later additions to the defaults follow a versioned, additive table (`TARGETS_ADDED_IN` in `settings.rs`, marker `target_defaults_version`): a file gains the targets that were added after its version and keeps every toggle it has, so a target you switched off stays off.

### Custom workspace

Settings can point the app at another folder (`c` choose, `R` reset to the default path). A chosen folder is used only when it passes the markers above. `AGENT_WORKSPACE_PATH` overrides it. Install into a custom folder behaves as into the default one, and the generator scripts the app runs still come from the bundled read-only copy.

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

Source grouping never changes harness installation layout. Every supported skill installs flat, as a whole directory: its `SKILL.md` and every supporting file next to it, at the same relative paths as in the bundle:

```text
<skills-folder>/<skill-name>/SKILL.md
<skills-folder>/<skill-name>/<supporting file>            (HUNTING.md, LICENSE, ...)
<skills-folder>/<skill-name>/assets/report-template.html  (nested files keep their directories)
```

Skills are one global surface (`skills`) for all harnesses, installed into the folders the enabled harnesses read. Each harness reads:

- Claude Code: `~/.claude/skills`
- Codex: `~/.agents/skills`, and `$CODEX_HOME/skills` (deprecated; `.system` below it is Codex's own)
- OpenCode: `~/.claude/skills`, `~/.agents/skills`, `~/.config/opencode/skills`
- Cursor: `~/.cursor/skills`, `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`
- GitHub Copilot (the CLI; checked against 1.0.98): `~/.copilot/skills` and `~/.agents/skills`. It does not read `~/.claude/skills`. VS Code's Copilot also reads `~/.claude/skills`, so with both folders installed it lists each skill twice.
- Pi (checked against 1.3.0): the `skills` folder of its agent dir (`~/.pi/agent/skills`) and `~/.agents/skills`. It does not read `~/.claude/skills`.
- Kilo Code (checked against 7.8.12): `~/.claude/skills` and `~/.agents/skills` by default, and `~/.kilo/skills`. `KILO_DISABLE_EXTERNAL_SKILLS=true` drops the first two, `KILO_DISABLE_CLAUDE_CODE_SKILLS=true` only `~/.claude/skills`.

`~/.copilot/skills`, `~/.pi/agent/skills` and `~/.kilo/skills` belong to those harnesses and the app never installs into them; they are only read, to show which copy a harness loads. They are fixed paths: `COPILOT_HOME` and `PI_CODING_AGENT_DIR`, which move the real folders, are not followed (the health says so when one is set in the app's environment).

The app installs into the fewest folders every enabled harness reads (`skill_roots::install_roots`): `~/.claude/skills` when Claude Code is enabled; `~/.agents/skills` when Codex is enabled; for OpenCode, Cursor or Kilo, `~/.agents/skills` when neither of those two is wanted; and `~/.agents/skills` for Copilot or Pi, which read no other shared folder. With a customised `CODEX_HOME` (or `CODEX_SKILLS_PATH`) Codex's copy is `$CODEX_HOME/skills` instead, and when OpenCode, Cursor or Kilo is enabled with Codex but without Claude Code, `~/.claude/skills` is added for them rather than `~/.agents/skills`, so Codex never reads an installed copy outside its isolated home. That isolation wins over Copilot and Pi: with Codex enabled and a customised home they are unserved (`skill_roots::unserved`), no skills are installed for them, and their health row says so. `CLAUDE_SKILLS_PATH` (inside the home folder) moves the Claude folder. The set is recomputed from the enabled harnesses on every plan, the settings must be readable for the skills surface to be planned at all, and with no harness enabled nothing is planned or removed.

The light harnesses (Copilot, Pi, Kilo) are off by default, also for settings files written before they existed; enabling one adds a tab and, at most, one install folder (`~/.agents/skills`, shared with Codex, OpenCode and Cursor). For every subset of the seven harnesses and both Codex homes the roots satisfy: each enabled harness reads an installed root unless it is unserved; Codex reads exactly one, and in a customised home only its own; nothing is installed that no enabled harness needs; and no new install folder exists, so the worst-case upgrade transaction is unchanged. A skill name found in several folders a harness reads is resolved by that harness: Copilot lets `~/.copilot/skills` win over `~/.agents/skills` without saying so, Pi lets its agent folder win and reports a collision, and Kilo ranks `~/.claude/skills` below `~/.agents/skills` below `~/.kilo/skills` (the last wins, with a log line). The effective-load view shows which copy each loads. MCP is not managed for the light tier yet; the descriptor `metadata/light-harnesses.json` (embedded in the app, never read from the runtime workspace) holds each one's label, CLI program and rules file (see Rules).

A folder that is no longer wanted (a harness switched off, or the folders older versions filled: `~/.config/opencode/skills`, `~/.cursor/skills`, `$CODEX_HOME/skills`, `~/.agents/skills`) loses the app's own copies through the same reviewed plan: each file is removed only when it is proven app-owned, with a backup, in the same transaction that installs the skills in their new folder (removals come last, so a failure restores the old state). Edited copies stay as conflicts, and files you added, your own skills and every dot directory (`$CODEX_HOME/skills/.system` included) are never touched.

All 25 current bundled skills target Codex, OpenCode, Claude, and Cursor. Sync-all derives expected skills from the same compatibility metadata used by health checks.

## Skill sources

Canonical skill files under `skills/` are the single source for every harness. Managed setup copies each `SKILL.md` byte for byte into every skills folder it installs into; there are no generated per-harness adapters. Harness-specific text lives at the end of the file under `## Harness notes` (`### Claude Code`, `### Codex`, `### OpenCode`, `### Cursor`, in that order). Claude-only frontmatter keys and Claude's `!` command injection are allowed only together with the Claude Code notes, and `scripts/check-skill-routing.py` enforces the structure in the source repository. That script lives in the source repository's `scripts/`, not in the installed workspace; skills added to a runtime workspace are not discovered for install. A skill without a canonical file is unavailable; production setup has no other source. Destination folders are unchanged. What changed is the unit of ownership: every file of a skill, `SKILL.md` and supporting files alike, is one managed artifact (`SkillFile`: skill root, skill name, relative path), copied byte for byte from the skill's directory in the bundle. There is no artifact for a directory, so Riggverk never owns a skill folder as a whole.

Supporting files are the regular files below the skill directory: no symlinks, no dot entries, at most four path components, at most 64 files and 2 MiB per skill, at most 1 MiB per file, and no nested `SKILL.md`. A bundled skill that breaks a bound is a packaging error and installs nothing. File modes are not copied: an executable source installs as an ordinary readable file, and the skills run their scripts through `node <path>`.

## Skill ownership and cleanup

Installed skill files are user-owned after installation. Riggverk may:

- create missing managed copies
- report synced or diverged copies
- remove only known deprecated copies that still match a Riggverk reference snapshot
- update or remove a copy that is byte-for-byte a version the app shipped, even when `managed-state.json` records no or a different hash for it (see Managed ownership below)

Diverged deprecated copies, edited copies, and unknown skills are preserved. This holds per file: an edited supporting file is a conflict by itself and is left as is, while its siblings still update. A file you add inside a skill directory is never touched. Removing a skill (a retired one, or uninstall) removes only the files the app owns, then the directories that became empty, from the file's own directory up to the skill's directory and never the skill root; a directory that still holds one of your files stays. A symlink in a skill's path (a symlinked skills root included), a directory where a file belongs, or a file where a directory belongs is a conflict for the files below it, found while planning rather than failing the apply.

Deprecated removal creates a transaction backup before deletion. Rollback validates the transaction, resolves the current destination from the harness registry, rejects destination mismatch and occupied targets, stages restores, and preserves the backup transaction.

## Rules

`templates/global-agent-rules.md` is the editable shared core. Harness appendices live under `templates/rules/`. Generated composed rules live under `templates/sync/`. `metadata/rules-history/` holds every base the app shipped, one file per content digest, so a rules file can be compared with the base it started from; `scripts/generate-rules-history.py` keeps it current.

Installed rule targets:

- Codex: `$CODEX_HOME/AGENTS.md` (default `~/.codex/AGENTS.md`)
- OpenCode: `~/.config/opencode/AGENTS.md`
- Claude Code: `~/.claude/CLAUDE.md`
- GitHub Copilot: `~/.copilot/copilot-instructions.md`
- Pi: `~/.pi/agent/AGENTS.md`
- Kilo Code: `$XDG_CONFIG_HOME/kilo/AGENTS.md` (default `~/.config/kilo/AGENTS.md`)

The last three belong to the light tier (off by default) and come from `metadata/light-harnesses.json`: one `ArtifactId::HarnessRules(<harness>)` each, a surface `<harness>_rules` and a target of the same name. Their bases are composed like the others (`templates/rules/{copilot,pi,kilo}.md` plus the shared core), so they carry no earlier version beyond the one in `metadata/rules-history/`.

Rule targets are merge-managed. Riggverk owns only the content between `<!-- BEGIN AGENT-WORKSPACE BASE` and `<!-- END AGENT-WORKSPACE BASE -->`; bytes outside are user-owned and preserved byte-for-byte, including a BOM, CRLF line endings, and a missing final newline. The markers count only as whole lines at column 0 outside fenced code blocks, and a file holds exactly one BEGIN followed by one END. Instructions after the block are the user's refinements and override the base where they conflict (the base states this in its Priority section).

Detection compares the block body, not the whole file. A body digest ignores CRLF versus LF and a missing final newline, and the managed-state record for a rules file is that digest.

| Installed file | Plan |
|----------------|------|
| absent | create a file holding the block |
| block body equals the bundled base | current |
| block body equals the recorded digest or a shipped base | update the block body; text before and after is kept |
| block body edited | conflict `base_block_edited`; left as is |
| no markers, file equals the recorded digest, a shipped base, or the current source (or holds only whitespace) | update: the file is replaced by a file holding the block, after a full backup |
| no markers, any other content | conflict `legacy_diverged`; left as is |
| duplicate, unpaired, or reordered markers; not UTF-8; larger than 4 MB | conflict `malformed_markers`; zero mutation |
| Pi: `AGENTS.override.md` next to the file (whatever the file holds, or absent) | conflict `masked_by_override`; left as is |
| Pi: no `AGENTS.md`, but `CLAUDE.md`, `CLAUDE.MD` or `AGENTS.MD` in the same folder | conflict `peer_context_file`; nothing created |

Edits inside the block are reported and never replaced without explicit confirmation. A base update that keeps user text is an `update_available`, never a conflict, and reports how many refinement lines it preserves.

For the two conflicts a user can resolve (`base_block_edited`, `legacy_diverged`), the app offers read-only diffs (installed file against the update, or the closest shipped base against the installed file), an explicit conversion, and "leave as is". Conversion writes the current base as the managed block and keeps what the user changed: every `##` section that differs from the closest shipped base, or that the base never had, moves below the END marker under a comment, and text around an edited block stays where it was. The preview shows the exact resulting file, and applying it is an ordinary backed-up transaction. "Leave as is" records the choice in `.agent-workspace/rules-preferences.json`; the file is then reported as "base updates available, you manage this file" instead of a conflict and is never written until the user converts it or clears the choice. Markers that are malformed are never rewritten.

Rollback of a block update restores only the previous block body, so text the user added after the update stays; it refuses when the block itself changed after apply. Creating, wrapping, and converting restore the whole file, and only while it is unchanged since apply.

Pi loads one context file per folder, the first that exists of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md` and `CLAUDE.MD` (checked against Pi 1.3.0), from its agent folder, the working directory and every parent. A plan therefore refuses when `AGENTS.override.md` is there (the block would never load) and when it would create `AGENTS.md` beside a `CLAUDE.md` (it would hide that file); only regular files count, and only their existence is checked. The two conflicts are not convertible: nothing the app writes to the file changes what Pi reads, so the user removes, renames or merges the other file first. The names come from the descriptor (`masked_by`, `peer_files`). The folders the app creates for Pi's file are owner-only (0700), as Pi makes its own.

Kilo's rules file lives in its config folder, which follows `XDG_CONFIG_HOME` (checked against Kilo 7.8.12; `KILO_CONFIG_DIR` does not move it). A relative `XDG_CONFIG_HOME` is ignored (the XDG specification calls it invalid), and a folder outside the home directory is the allowlisted root of that file. Kilo loads one global rules file, the first of `$KILO_CONFIG_DIR/AGENTS.md`, `AGENTS.md` in the config folder and `~/.claude/CLAUDE.md` (upstream source; not confirmed by a session), so creating the file stops Kilo reading `~/.claude/CLAUDE.md`, refinements there included. The review of a new file says so, the page warns while the target is on, and the descriptor field `shadows` holds the file. Copilot's CLI reads only `~/.copilot` and project files; VS Code's Copilot sessions can also load `~/.claude/CLAUDE.md`, so with Claude's rules managed the shared base may appear twice there, which the Copilot page notes.

Runtime health compares the block body with the bundled base. For the light tier the runtime pane shows one rules row (`synced`, `stale`, `missing`, `diverged`, or `off` while the target is off) and the warnings above; it never shows file text. Codex health also warns when a non-empty `$CODEX_HOME/AGENTS.override.md` exists: Codex reads it instead of `AGENTS.md`, which silently drops the base. Cursor User Rules stay a manual copy of `templates/cursor/user-rules.md`; the app does not write them.

Rule writes are explicit, allowlisted, backed up before any change, and separate from editing workspace source templates.

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

Riggverk owns only allowlisted managed keys and the named Playwright MCP entry. Unknown keys, user provider blocks, and other MCP entries are preserved.

The editable sources are:

- `templates/opencode.base.json`
- `templates/opencode.policy.json`

`templates/opencode.json` is generated and read-only in the Library editor.

### Codex

Riggverk manages only allowlisted Codex config defaults in `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`), and only while the `codex_config` target is on (off by default). `approval_policy`, `approvals_reviewer`, `sandbox_mode`, `apps._default.approvals_reviewer`, and `apps._default.default_tools_approval_mode` follow the template. `model` and `model_reasoning_effort` are create-only: written from the template (`gpt-6.1-sol`, `xhigh`) only while the file has no value, then user-owned, never overwritten and never reported as drift. The merge scripts read and write those scalar values only; user personality, MCP entries, unrelated tables, comments, and unsupported structures are preserved or cause a safe refusal with zero mutation.

App-shaped legacy top-level profile selectors (`profile = "safe"` / `"workspace-write"`) and legacy `[profiles.safe]` / `[profiles.workspace-write]` tables are removed only during migration when they still carry app-shipped values. Legacy profile handling is migration-only; Riggverk does not generally own or rewrite arbitrary Codex profiles. Same-line inline comments on managed scalar assignments are preserved; ambiguous managed lines refuse safely.

### Claude Code

Riggverk manages Claude rules, native subagents, and skills. Claude settings, authentication, trust state, caches, and user-scoped MCP credentials remain Claude-managed and are not read or written by Riggverk.

### Cursor

Cursor global agents, skills, and the named Playwright MCP entry are managed by native Rust operations. User Rules and Auto Review remain manual IDE settings. Project `.cursor/*`, project agents, project MCP, `.cursorignore`, and `AGENTS.md` are not written by the global setup flow.

### GitHub Copilot, Pi and Kilo Code

The light tier is off by default and manages the rules file of each (see Rules) and the shared skills (see the skill folders above). MCP is not managed yet, and nothing else in `~/.copilot`, `~/.pi` or `~/.config/kilo` is read or written. Their pages show the CLI version, the rules row and whether the bundled skills are installed in the folders each one reads. `COPILOT_HOME` and `PI_CODING_AGENT_DIR` are not followed: the app writes the default location and the page warns when one is set.

The only call the app makes to these CLIs is `<cli> --version`: bounded to 10 seconds, from a neutral working directory, parse-only (only the version token is kept). Other subcommands are never run: `copilot version` asks the network, `pi --help` creates files in the agent dir, and `kilo debug *` prints the resolved config with its secrets. `copilot --version` prints two lines and ends the first with a full stop (`GitHub Copilot CLI 1.0.98.`); the full stop is not part of the version. A Finder-launched app does not load the shell profile, and none of the three resolves on the minimal `PATH` when installed through nvm. When a CLI is not on `PATH`, the highest version folder of `~/.nvm/versions/node` that has it is used, and that folder (it holds `node`) is put in front of the probe's `PATH`; nvm's alias files are not read. Anything else installed elsewhere (a global npm prefix, bun, pnpm, volta) is reported as not on `PATH`; start the app from a shell where the CLI runs.

## Backups and writes

Writes use allowlisted targets and explicit arguments. Existing files that Install, uninstall, or a Library save would overwrite or remove are backed up first (new files are not). Install backups live in `<backup root>/setup/<transaction id>/artifacts/<artifact id>` with a `manifest.json` and `managed-state.previous.json`; Library saves in `<backup root>/docs/<doc id>-<timestamp>/`. Config merges use staged files and post-write validation. Backup roots and target roots reject filesystem roots, drive roots, home roots, traversal, and symlink escapes. See [SECURITY_MODEL.md](./SECURITY_MODEL.md) for the full write table and modes.

The frontend supplies named actions and bounded identifiers, not shell commands or arbitrary destination paths.

## Library edits

The Library edits the runtime workspace copy only. Saves are atomic, refuse symlinks and paths outside the workspace root, and back up the existing file first (`<backup root>/docs/<doc id>-<timestamp>/`). A saved edit changes what the app displays and what a later bundled update sees as a conflict; it does not change what harness installs write, which always come from the bundle. `templates/opencode.json` is generated and read-only in the Library.

## Managed installation

Surface status in the app is derived from artifact-level detection. OpenCode Config aggregates `opencode.json`, `tui.json`, and the Playwright MCP artifact; agents surfaces aggregate every managed artifact for that harness. The one `skills` surface aggregates every skill file in every skills folder the app manages, wanted or not, so a copy left in a folder that is no longer wanted shows up as a removal in the same preview.

The UI runs preview, shows the plan table, and calls apply only after the user confirms (`y`); `p` and `:preview` show a plan with no apply path. Preview issues a bounded in-memory token scoped to workspace, pending surfaces, and fingerprint. Rapid identical previews receive distinct tokens. Token issuance fails closed when the registry cannot be locked. Apply consumes the token only after preflight succeeds and immediately before the first mutation. Tokens expire, are pruned deterministically by age, and are never logged or persisted to disk. App restart invalidates stale previews.

Filesystem-mutating installation and rollback commands acquire a process-wide non-blocking mutation guard. A second mutation returns `setup operation already in progress` without filesystem changes or misleading transaction evidence. Preview, health, discovery, planning, and rollback dry-run remain available.

Packaged source and runtime destination are resolved independently by `SetupRoots`; installation refuses to run if they resolve to the same root. Path safety is centralized in `path_safety.rs` (symlink and containment checks, including dangling symlinks via `symlink_metadata`). Bounded directory copy/remove without following symlinks lives in `safe_filesystem.rs`; callers pass an explicit allowlisted root, and copy/reject paths validate destination symlinks and parent chains before mutation.

Managed ownership is recorded in `.agent-workspace/managed-state.json` schema 2 with stable SHA-256 digests. First-run adoption and stale cleanup require an exact canonical or historical digest. Unknown files and modified historical copies remain conflicts and are never claimed or deleted.

A whole-file copy artifact (a skill file in any skills folder, harness agent, OpenCode Playwright MCP file) whose bytes are exactly a version the app shipped is app-owned even when its recorded hash differs or is missing, for example after an older app version or legacy script synced it without recording ownership. The planner then updates or removes it like a recorded file, with backup and rollback. `metadata/shipped-digests.json` lists those versions per bundle source path (every committed version plus the current one, including retired skills and agents). A `SKILL.md` is listed under the logical key `skills/<name>/SKILL.md`, which also covers the per-harness adapters older versions installed; a supporting file is listed under its own bundle-relative path, such as `skills/security-audit/HUNTING.md`. Managed-state records written under the old per-harness skill identities are read as the `SkillFile` identity of the same `SKILL.md`, and old transaction manifests with those identities (and the retired per-harness skill surface ids) still roll back; `scripts/generate-shipped-digests.py` keeps it current and `release-check` verifies it. Rules blocks (`metadata/rules-history`), merge-managed configs, and workspace files have their own proofs and are not covered. Missing or malformed metadata proves nothing, so those files stay conflicts.

OpenCode agent permissions are composed from `templates/opencode.policy.json` plus `templates/opencode/agents/*.role.json`. Restrictive roles use `composition.replace_sections` so inherited bash/edit capabilities are replaced, not shallow-merged. `scripts/validate_opencode_permissions.py` guards the semantic contract in release-check.

Transactions persist manifest status fail-closed, validate backups before mutation, reject symlink parent chains, and record per-artifact apply, validation, rollback, managed digest, and full digest state. The exact prior managed-state bytes or prior absence are part of the transaction and are restored on rollback. Managed state is published atomically before the transaction becomes completed.

Automatic rollback uses the workspace root validated at transaction start, not the process working directory. Before a new apply, interrupted prepared, applying, failed, or rolling-back transactions for the same workspace are reconciled or the new apply is blocked. Rollback-failed transactions (for example an artifact preserved because the user edited it) are not retried automatically: they are reported as a manual step and only an explicit rollback runs them again. Reconcile never restores an artifact that a newer completed transaction wrote. Explicit rollback sets per-artifact `in_flight` before mutation, persists progress after each artifact, and refuses to overwrite content changed after apply.

## Full uninstall

Full uninstall previews removable, preserved, and merge-managed artifacts before any mutation:

- **Removable** — installed files with proven app ownership (managed-state digest, historical ownership, a version the app shipped, or current bundled source match).
- **Preserved** — modified or unknown user files that do not match an app-owned proof.
- **Merge-managed** — user-owned config files where only allowlisted keys were merged, and rules files that hold the user's own text beside the base block; the file is never deleted wholesale. A rules file that holds nothing but an unedited base block is removable.

Uninstall creates a rollback-capable backend transaction with per-file backups. Preview and rollback dry-run perform zero filesystem mutation. Actual rollback restores exact prior app-owned bytes from the transaction backup and refuses occupied or changed targets.

The frontend retains only the most recent install or uninstall transaction ID for the current app session (`z` or `:rollback` restores it after a dry run and a confirm). **Recover previous uninstall** remains visible after uninstall makes the workspace invalid, but recovery state is not persisted in AppSettings, localStorage, or a transaction registry. Closing or restarting the app loses the recovery affordance even though backend transaction evidence may remain on disk. Recovery requires a read-only dry-run before mutation and explicit confirmation to restore.

## Harness enablement

`AppSettings.enabled_harness_ids` is a persisted positive allowlist containing `codex`, `opencode`, `claude`, and `cursor`. New settings and older settings without the field enable all four. Unknown values are ignored, duplicates are removed, canonical order is preserved, and an empty list is valid.

Harness enablement is separate from `enabled_target_ids`. Disabling a harness hides its application surfaces, skips normal health and status path reads, and rejects new managed writes at backend command boundaries. It does not alter target preferences, existing harness files, managed ownership state, backups, or recovery transactions. Re-enabling restores UI and status checks but never installs automatically.

Workspace installation remains available with every harness disabled. Full uninstall remains global across proven app-owned artifacts, including disabled harnesses. Rollback restores the recorded transaction independently of current harness visibility.

## Security boundaries

The workspace must not contain credentials or private runtime state. Riggverk does not inspect `.env` files, private keys, auth stores, OAuth state, shell history, Claude trust state, or unrelated personal files.

No frontend-supplied shell strings, `sh -c`, unrestricted paths, or generic filesystem browsing are part of the contract.
