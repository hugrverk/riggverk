# Maintaining Riggverk

Recipes for changing the repository without breaking the release gate. Cutting a release is in [RELEASE.md](./RELEASE.md); what the app owns on a user's machine is in [WORKSPACE_CONTRACT.md](./WORKSPACE_CONTRACT.md).

## Orientation

| Path | What it is |
|---|---|
| `src/` | React and TypeScript UI |
| `src-tauri/` | Rust backend (Tauri 2) |
| `resources/default-workspace/` | the bundled workspace. The app installs it to `~/.config/riggverk` and bundles the directory exactly as it is on disk, ignored files included |
| `scripts/` | generators, checkers, the release gate (`release-check.sh`) and the release script (`release.sh`) |
| `release-notes/` | one Markdown file per release; the source of the app's "what's new" |
| `docs/` | maintainer and contract docs |

### Source or generated

Edit the source column. `python3 scripts/generate.py write` rewrites the generated column; never edit those files by hand, because `python3 scripts/generate.py check` fails while they differ. Paths without a top-level folder are under `resources/default-workspace/`.

| You edit | Registry name | It rewrites |
|---|---|---|
| `templates/global-agent-rules.md` (shared core), `templates/rules/<harness>.md` (appendix), `metadata/rules-adapters.json` | `agent-rules` | `templates/sync/<harness>-rules.md`, `templates/cursor/user-rules.md` |
| `templates/opencode.base.json`, `templates/opencode.policy.json` | `opencode-config` | `templates/opencode.json` |
| `agent-specs/<role>.body.md`, `templates/opencode/agents/<role>.role.json`, `ROLES` in `scripts/generate-agent-adapters.py` | `agent-adapters` | `agents/<role>.md`, the generated agents under `templates/claude/agents/`, `templates/codex/agents/` and `templates/cursor/agents/`, `metadata/agent-adapters.json` |
| `release-notes/<version>.md` | `release-notes` | `src/generated/release-notes.json` |
| (git history of the sync rules) | `rules-history` | `metadata/rules-history/` |
| (git history of skills and agents) | `shipped-digests` | `metadata/shipped-digests.json` |
| (git history of every bundled file) | `pre-manifest-ownership` | `metadata/pre-manifest-ownership.json` |

`python3 scripts/generate.py list` prints every output file; `python3 scripts/generate.py paths` prints them one per line.

## Setup

- Python 3.11 or newer first on `PATH` (the scripts use `tomllib`). macOS ships 3.9 as `python3`; with Homebrew Python:

  ```bash
  mkdir -p ~/.local/pyshim
  ln -s /opt/homebrew/bin/python3.14 ~/.local/pyshim/python3
  export PATH="$HOME/.local/pyshim:$PATH"
  ```

- Node.js 22 and npm 10+, then `npm ci`.
- Stable Rust (the disabled workflows pin 1.97.1).
- Bash and git. `rg` is not needed.

## Daily loop

```bash
# edit sources
git add -A                          # new files must be tracked before writing
python3 scripts/generate.py write   # rewrites generated files; never commits
./scripts/release-check.sh          # the gate
```

The gate prints the seconds each step took. `cargo test` dominates: several minutes, because the suite runs single-threaded. Everything before the frontend typecheck finishes in about a minute. For a faster inner loop, `python3 scripts/generate.py write --no-history` skips the history generators (the gate never skips them).

Every checker runs on its own from the repository root, for example `python3 scripts/check-source.py --group ui` or `python3 -m unittest scripts/test_check_source.py`.

## Recipes

Each recipe lists the files to touch, the command, and what fails if you forget.

### Change a skill

- Edit `resources/default-workspace/skills/<name>/SKILL.md` (and its supporting files). The description is one plain line of at most 300 characters that contains "Use when"; the body has a one-line `Done when: ...` exit criterion, and a `## Harness notes` section, if present, is the last `##` section.
- Update its row in `resources/default-workspace/docs/SKILLS.md` if the purpose changed. There is no count to update anywhere.
- `git add -A && python3 scripts/generate.py write`: `shipped-digests` and `pre-manifest-ownership` record the new version so installs of the old one stay app-owned.
- Forget it and `check-skill-routing.py` names the description problem; `generate.py check` names the stale ownership files.

### Add or remove a skill

- Add: create `skills/<name>/SKILL.md` (or `skills/<category>/<name>/SKILL.md`) with spec-valid frontmatter (`license: MIT`, Riggverk fields under `metadata:`, see "Skill Metadata" in the bundle's `docs/SKILLS.md`; `metadata.source` and a `NOTICE.md` entry when it adapts public work), add a row to `docs/SKILLS.md` in the bundle, and mention it in the routing rules if agents should pick it on their own. Nothing is listed anywhere else: the list of workspace copies is frozen and a new skill is read from the bundle. `check-skill-routing.py` fails on a skill without a `SKILLS.md` row (and on a row without a skill).
- Remove: delete the folder and its `SKILLS.md` row, add every file of it that the frozen list names to `RETIRED_FROM_BUNDLE` (see "Add, rename or delete a bundled file"), add the name to `REMOVED_SKILL_NAMES` in `src-tauri/src/managed_bootstrap.rs`, then `generate.py write`. The `pre-manifest-ownership` generator reads the history: a skill that once shipped and is gone without being listed in `REMOVED_SKILL_NAMES` fails `generate.py check`, so a skill cannot disappear by accident. `check-skill-routing.py` fails if the removed name is still mentioned anywhere outside the migration fixtures.

### Change or add an agent

- The body lives in `resources/default-workspace/agent-specs/<role>.body.md`; the OpenCode header (mode, permission overrides) in `templates/opencode/agents/<role>.role.json`; which harnesses get the role in `ROLES` in `scripts/generate-agent-adapters.py`.
- A new role also needs an entry in `metadata/agents.json`, a line in the Agents section of `docs/WORKSPACE_CONTRACT.md`, and a decision in `scripts/validate_opencode_permissions.py` (`EDIT_DEFAULT`, and `READONLY_ROLES` if it is read-only).
- Hand-written Cursor agents (not generated) are listed in `templates/cursor/manifest.json` and in the Cursor list of `docs/AGENT_RULES.md` in the bundle.
- `generate.py write`. What fails if you forget: `generate.py check` (adapters stale), `check-bundle-content.py` group `agents` (the `agents/` folder, `metadata/agents.json` and the adapters must agree; only the default agent is `mode: primary`), `check-readme-docs-drift.py` (documented agent lists), `validate_opencode_permissions.py` (permission contract).

### Change the shared rules

- Shared core: `resources/default-workspace/templates/global-agent-rules.md`. Per-harness text: `templates/rules/<harness>.md`. Which harness gets which file: `metadata/rules-adapters.json`.
- `generate.py write` rewrites the sync files and adds the new base to `metadata/rules-history/`. Every base ever shipped stays there automatically, so the app can show a user who edited an older base what they changed.
- Forget it and `generate.py check` fails on `agent-rules`, then on `rules-history`.

### Add or change a harness

The harness list lives in several places no compiler connects: `HarnessId` and the target registry in Rust (`src-tauri/src/agent_targets.rs`, `skill_roots.rs`, `skill_loads.rs`, `setup_lifecycle.rs`), `metadata/light-harnesses.json` and `metadata/rules-adapters.json` in the bundle, the rules and MCP templates, and the TypeScript tables (`src/types.ts`, `src/lib/harnessInstallation.ts`, `src/lib/rulesView.ts`, `src/shell/views.ts`, `src/App.tsx`), plus the skill target ids (`VALID_SKILL_AGENTS` in `agent_skill_targets.rs`, `ALL_HARNESSES` in `scripts/check-skill-routing.py` and `metadata.targets` of every bundled skill). `python3 scripts/check-harness-mirror.py` names the first mismatch of each kind; `check-managed-installation-contract.py` requires each harness view to render exactly one `HarnessPage`.

### Check what the harnesses list

Before a release and after upgrading a harness, run `python3 scripts/kit_listing_probe.py`. It runs Claude Code, Codex, OpenCode and Kilo from a throwaway home with a placeholder key and no model call, and reports per skill whether the description is listed in full, plus what the kit adds to the always-loaded prompt. Harnesses can still contact their vendors for catalogs and telemetry. It stays out of `release-check.sh`, because it depends on the installed harnesses.

- Codex shows the prompt itself. Claude Code shows token estimates, so "full" there means about the size of the description. OpenCode and Kilo show what they discovered, not what reaches the prompt.
- Exit 1: a default setup lost a description. Exit 2: the run says nothing about the kit, because a harness is missing, a control failed or a model was retired or changed. Use `--harness` to run fewer, and update the model names at the top of the script.

### Add or change a posture check

The code lives in `src-tauri/src/commands/security_posture.rs`, the phrases in `src/lib/securityPostureRows.ts`.

- Add the variant to `FindingCode` and its level to `level()`, reduce the key to a bool, enum or count in the harness's facts function (never keep or format a value), and add the same code to `FindingCode` in `src/types.ts` and to the copy table. A Rust test fails when the table has no key for a code.
- Add a fixture test, and extend the marker test in the same file when a new file or secret position is read.
- Check the key against the vendor docs for the harness version and cite the page in the module doc. Leave out what the docs do not state.
- A phrase never says secure, safe or all good; `enforced` means set in the file read.

### Add, rename or delete a bundled file

- A new bundled file is not listed anywhere: the list of workspace copies, `RETIRED_WORKSPACE_FILES` in `src-tauri/src/commands/retired_workspace_files.rs`, is frozen and the app reads bundled files from the bundle. Renaming or deleting a file that list names fails `check-retired-workspace-files.py` and the Rust test `every_listed_path_is_in_the_bundle_or_documented_as_retired`; add the path to `RETIRED_FROM_BUNDLE` in that file's tests, with a comment naming the release that dropped it. The Rust test `the_frozen_list_matches_the_list_it_was_frozen_from` pins the list by digest, so the list itself changes only on purpose. An empty listed file fails `check-bundle-content.py`.
- `git add -A && python3 scripts/generate.py write`: `pre-manifest-ownership` records the digest of every version the app shipped, so older installs stay app-owned.
- No symlinks inside the bundle (`check-bundle-content.py` group `symlinks`), no private context files or names (group `boundary`), and every JSON file must be strict JSON (group `json`).
- Names that must never ship (people, private projects) are not kept in the repository. List them one per line (`#` comments) in an untracked `.private-names` at the repository root, or point `RIGGVERK_PRIVATE_NAMES_FILE` at a list shared by every worktree; group `boundary` then fails on any of them in the bundle. Without a list the group skips that check and says so; a variable that names a missing file fails.
- The bundled user docs are listed in `DOC_FLOOR` in `scripts/check-bundle-content.py`; deleting one means removing it there in the same change.

### Change the OpenCode policy or models

- Permissions: `resources/default-workspace/templates/opencode.policy.json`. Non-permission settings (LSP, autoupdate): `templates/opencode.base.json`. Then `python3 scripts/generate.py write` (the snapshot and the agent adapters both change).
- `validate_opencode_permissions.py` checks the composed permissions semantically, including a floor of secret file names that every role must refuse to read or print; removing one from the policy fails there.
- Do not add bundled `model` or `small_model` values; `opencode-defaults` checks both templates. Update `OPENCODE_LITERALS` for `lsp`, `autoupdate`, or `snapshot` changes. TUI defaults: `TUI_DEFAULTS` in the same file.

### Merge main or a long-lived branch

| Situation | What to do |
|---|---|
| Edit not committed yet | `git add -A`, `python3 scripts/generate.py write`, commit. One commit, no amend |
| Committed, forgot to write | `write`; amend if unpushed, else commit `chore(generate): refresh generated files` |
| `git merge origin/main` | the history changed, so the history generators are stale. On conflicts in generated files: `git checkout --theirs -- $(python3 scripts/generate.py paths)`, then `write`, `git add -A`, finish the merge. `write` also sees `MERGE_HEAD`, so it can run before the merge commit exists |
| A merged pull request left `main` stale | `git pull`, `write`, commit `chore(generate): refresh generated files`. Prevention: merge main into the branch and `write` before merging |
| Rebase | `write` once at the end |
| Shallow clone | `git fetch --unshallow` (the history generators refuse a shallow clone) |

## Generators reference

`python3 scripts/generate.py check|write [--only NAME ...] [--no-history]` runs them in this order (later ones read the outputs of earlier ones):

| Name | Script | History walk |
|---|---|---|
| `agent-rules` | `generate-agent-rules.py` | no |
| `opencode-config` | `generate-default-opencode-config.py`; `check` also runs the bundled twin `resources/default-workspace/scripts/generate-opencode-config.py --check` on a temporary copy | no |
| `agent-adapters` | `generate-agent-adapters.py` (also runs the OpenCode permission contract) | no |
| `release-notes` | `generate-release-notes.py` | no |
| `rules-history` | `generate-rules-history.py` | yes |
| `shipped-digests` | `generate-shipped-digests.py` | yes |
| `pre-manifest-ownership` | `generate-pre-manifest-ownership.py` | yes |

The history generators share one walk of every commit reachable from `HEAD` (and `MERGE_HEAD`) plus the tracked working tree, so writing before or after `git commit` gives the same files. The outputs of the history generators (`metadata/shipped-digests.json`, `metadata/rules-history/`, `metadata/pre-manifest-ownership.json`) are append-only baselines: `write` emits the committed baseline plus whatever the history and working tree prove, so it never drops an entry, and `check` passes in a repository with squashed or fresh history as long as nothing is missing. Never delete an entry from these files to "clean up"; an install of that version would lose its ownership proof. A new `generate-*.py` must be added to `REGISTRY` in `scripts/generate.py`; `scripts/test_release_check_wiring.py` fails otherwise.

## Where guards live

`scripts/release-check.sh` runs these steps in order; each names the script that owns its checks.

| Step | Script | Protects |
|---|---|---|
| repo state | `git status`, `git diff --check` | whitespace errors and conflict markers in the worktree, the index and everything since the merge base |
| toolchain | - | git, node, npm and cargo present; Python 3.11+ (checked first) |
| shell syntax | `bash -n` | every tracked `.sh` file parses |
| generated files are current | `generate.py check` | every generated file, including the ownership history |
| python tests | `scripts/test_*.py` | each file must run at least one test; a new test file runs without editing the gate |
| app version agrees | `release_tools.py check-versions` | one version across package.json, tauri.conf.json, Cargo.toml and both lock files |
| README and docs drift | `check-readme-docs-drift.py` | stale doc claims, the collection-count lint, documented agent lists, this guide |
| skill catalog and routing | `check-skill-routing.py` | skill frontmatter and descriptions, the `SKILLS.md` catalog, routing rules, removed skill names |
| workspace copy list and Library docs registry | `check-retired-workspace-files.py`, `check-curated-library-docs.py` | the frozen list of workspace copies is sorted and each file is in the bundle or documented as retired from it; internal Cursor files stay out of the Library |
| bundle content | `check-bundle-content.py` | Codex templates (no tokens, safe defaults), listed workspace copy files present and non-empty, no symlinks, strict JSON, Playwright MCP guardrails (pinned, sidecar browser, no personal home paths), the Playwright MCP pin (every bundled template and doc names the version of `PLAYWRIGHT_MCP_VERSION` in `cursor_profile.rs`, and every entry passes `--prefix __PLAYWRIGHT_NPX_PREFIX_PATH__` before `-y` and `--browser chrome --isolated --no-webmcp`; a release day older than six months only warns), OpenCode and TUI defaults, the shared agents, the private-context boundary and private names, Cursor user-rules wording |
| Cursor profile | `check-cursor-profile.py`, `check-cursor-action-compat.py` | the Cursor manifest, agents, rules, MCP examples (no credentials, raw or structured), no fake global user-rules path in the bundle or the app source |
| bundled Codex merge script tests | `resources/default-workspace/scripts/test_merge_codex_config.py` | the shipped merge script; `scripts/test_codex_apply_secrets.py` (python tests step) applies it to a config holding secrets |
| OpenCode permission contract | `validate_opencode_permissions.py` | read-only roles cannot write, secret files are denied to every role and to the global block (in bash however a command spells the path, while commands that only mention a secret name keep their action), destructive commands are denied, the architect's gated commands stay gated, every bash deny that names a command also denies it inside pipes, chains, subshells and substitutions (bash calls are split per command like OpenCode 1.19.3) |
| harness ids agree | `check-harness-mirror.py` | the harness list across Rust, TypeScript and the light descriptor |
| managed installation contract | `check-managed-installation-contract.py` | one reviewed install owner, safe filesystem publishing, the preview/apply/rollback command surface, required gates in this script |
| shell command-string spawns in Rust | `check-shell-spawn.py` | no `sh -c` style process spawning in Rust |
| source: identity, Tauri config, startup order | `check-source.py` | product name, legal files, stable env vars and markers, install paths, window size, the app data move runs first |
| source: forbidden patterns and required markers | `check-source.py` | no shell command strings or remote skill installs in scripts and source; no project-target or page-scoped install actions; Codex skills folders; pinned Rust regression tests that replaced older source checks |
| source: UI | `check-source.py` | offline-first UI (no remote URLs or fonts, system font stacks), dev-only mock backend, selected-state design rules, typography plumbing |
| public residue | `check-public-residue.py` | no name the project retired (today: the name from before the Riggverk rename, in every spelling) outside its allowlist: `LEGACY_*` constants, metadata history, release notes, `docs/RELEASE.md`, the upgrade contract tests, and lines or blocks marked `residue-allow`; `--list-allowed` prints the allowlist, and a later rename is one more entry in `RESIDUES`. Four scoped residues keep cleaned text out: Swedish in a skill `description:`, concrete model ids in skill text, hard-coded user home paths (placeholder names only), and team-pack content (Kretsverket, WordPress, the dev port) in the bundle. They match shapes, not names. A fifth keeps a maintainer's own rule phrases (personal tools, account-specific delegation) out of the bundle: they are listed in an untracked `.private-residue` (or the file `RIGGVERK_PRIVATE_RESIDUE_FILE` names), and without one it is skipped |
| macOS app icon and disk image art | `prepare-macos-app-icon.sh` (macOS only) | the app icon, the disk image background (660x400 and @2x) and volume icon render from `assets/icon-source.svg`, and the layout in `tauri.macos.conf.json` matches the art |
| frontend typecheck, tests and build | `npm run typecheck`, `npm test`, `npm run build` | |
| rust fmt, clippy, tests | `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` | |
| pre-manifest upgrade smoke | `smoke-pre-manifest-upgrade.sh` | an install from a real old commit upgrades cleanly |
| tauri runtime smoke | `smoke-tauri-runtime.sh` | the backend commands against a temporary `HOME` |

A new `scripts/check-*.py`, `validate_*.py` or `smoke-*.sh` must be called from `release-check.sh`; `scripts/test_release_check_wiring.py` fails otherwise.

### Adding a rule

`check-source.py` and `check-bundle-content.py` keep their rules as data. To guard a new pattern, add a `Rule(id, kind, pattern, files, why, sample)` row to the right group: `kind` is `forbid` or `require`, `files` are repo-relative (`dir/` prefix, exact path or glob), and `sample` is text the pattern matches. The tests plant every `sample` in a throwaway tree and expect the rule to fire, so a rule that can never match fails its test. A rule whose files match nothing fails too. Checks that need structure (JSON values, ordering) are plain functions in the same group.

## Release flow

`./scripts/release.sh prepare` computes the CalVer version, drafts the notes, bumps the versions, runs the gate and opens the release pull request; edit `release-notes/<version>.md` and run `python3 scripts/generate.py write --only release-notes`; merge; `./scripts/release.sh publish` builds, signs, zips and creates the GitHub release. Details and rollback: [RELEASE.md](./RELEASE.md). The local gate is authoritative: GitHub Actions is disabled, and nothing verifies Windows unless someone re-enables `windows-checks.yml`.

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| `FAIL  pre-manifest-ownership` or `shipped-digests` after a merge or pull | the history changed | `python3 scripts/generate.py write`, commit |
| `ModuleNotFoundError: No module named 'tomllib'` or "python3 3.11 or newer is required" | Apple's Python 3.9 is first on `PATH` | the pyshim in Setup |
| "shallow clone: shipped versions need the full git history" | a shallow checkout | `git fetch --unshallow` |
| a new bundle file has no shipped digests | it is untracked (`write` prints a note) | `git add` it, `write` again |
| `FAIL: scripts/test_<name>.py ran no tests` | the file collected no test | give it a `unittest.TestCase` with `test_` methods |
| "description is N chars (max 300)" | skill description too long | shorten it; triggers go after "Use when" |
| `git diff --check` output | trailing whitespace or a conflict marker | fix the named line |
| `Cargo.lock` changed after `release.sh prepare` | a dependency resolved differently | see RELEASE.md; `prepare` stops and undoes its changes |
| `[ui] remote-urls: ...` or another `check-source.py` rule id | the named rule fired | the message gives the file and line; the rule's `why` says what to keep |

## Counts policy

Active docs state no counts of on-disk collections (a number or number word before "skills", "agents", "subagents" or "harnesses"): the count changes and the prose rots. Name the canonical list instead (`docs/SKILLS.md` in the bundle for skills, the Agents section of `docs/WORKSPACE_CONTRACT.md` for agents). `check-readme-docs-drift.py` enforces this with a lint over the active docs, this guide included; fixed behavior examples are allowlisted phrase by phrase in `COUNT_ALLOWLIST`. Numbers that are specifications (size limits, protocol versions) stay.
