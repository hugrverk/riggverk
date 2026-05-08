# Agent Workspace Deep Audit

## Runtime context

- repo root: `/Users/me/Projects/agent-workspace`
- repository: `uxsmedjan/agent-workspace`
- branch: `main`
- starting commit: `d17a65ea2625a65b322df173193153187d18a908`
- working tree state: clean before and after audit commands (`## main...origin/main`)
- platform: `Darwin mac.local 25.4.0 ... RELEASE_ARM64_T8103 arm64`
- node/npm: `node v24.14.0`, `npm 11.9.0`
- rust/cargo: `rustc 1.95.0 (59807616e 2026-04-14)`, `cargo 1.95.0 (f2d3ce0bd 2026-03-21)`
- commands actually run:
  - `git status --short --branch`
  - `git rev-parse HEAD`
  - `git branch --show-current`
  - `node --version`
  - `npm --version`
  - `rustc --version`
  - `cargo --version`
  - `uname -a`
  - `npm run build`
  - `cargo fmt --check` from `src-tauri`
  - `cargo check` from `src-tauri`
  - `cargo clippy --all-targets --all-features -- -D warnings` from `src-tauri`
  - `cargo test` from `src-tauri`
  - `./scripts/release-check.sh`
  - `npm outdated --json`
  - `cargo search tauri --limit 3`
  - `cargo search tauri-plugin-dialog --limit 3`
  - read-only inspection with `rg`, `sed`, `nl`, `wc`

## Executive verdict

**HOLD: do not release before fixes.**

The app is usable and the existing `./scripts/release-check.sh` passes, but the stronger requested Rust gate fails under `cargo clippy --all-targets --all-features -- -D warnings`. There are no confirmed P0 arbitrary-command-execution issues from frontend-controlled input. The largest risks are release verification drift, async workspace state races, dirty-editor data loss paths, and a few backend boundary gaps that should be fixed before widening the app’s authority.

## Priority findings

### P0 security/blocker

No P0 findings confirmed.

### P1 release blocker

#### All-targets Clippy fails but release-check does not catch it

- severity: P1 release blocker
- evidence:
  - `cargo clippy --all-targets --all-features -- -D warnings` fails with 25 `clippy::ptr_arg` errors.
  - Examples: `src-tauri/src/commands/content.rs:530`, `src-tauri/src/commands/content.rs:1205`, `src-tauri/src/commands/contract.rs:820`, `src-tauri/src/commands/routing.rs:445`, `src-tauri/src/commands/workspace.rs:798`.
  - `scripts/release-check.sh:531` runs only `cargo clippy -- -D warnings`, so test-target lint failures are missed.
- root cause: helper/test functions accept `&PathBuf` instead of `&Path`, and the release script runs a narrower lint target than the audit gate.
- user impact: a release can pass the official script while failing a stricter CI or local verification run.
- recommended fix: change helper/test signatures to `&Path`; then update release-check to run `cargo clippy --all-targets --all-features -- -D warnings`.
- suggested verification: rerun `cargo clippy --all-targets --all-features -- -D warnings` and `./scripts/release-check.sh`.
- risk if ignored: release confidence is overstated; future Rust/toolchain upgrades can turn latent test-target issues into blocking failures later.

### P2 important cleanup/bug

#### Workspace-dependent async loaders can commit stale data

- severity: P2 important bug
- evidence:
  - startup fires `loadSettings`, diagnostics, default summary, and resource loading concurrently at `src/App.tsx:688`.
  - workspace resource loading fans out at `src/App.tsx:454-462`.
  - workspace path changes persist settings and then reload diagnostics/resources at `src/App.tsx:704-726`.
  - the individual loaders set active docs, skills, agent sources, contract, and status without request generation checks.
- root cause: workspace path is a global backend setting, but frontend loaders are not scoped to a request id or the path/settings snapshot that started them.
- user impact: rapid workspace changes or slow commands can show stale resources, stale diagnostics, or an active item from the previous workspace.
- recommended fix: introduce a workspace resource generation token or hook that ignores late responses after workspace path changes; clear terminal/status panels on path changes.
- suggested verification: simulate slow command responses or rapidly switch workspace path and confirm only the latest workspace can update resource state.
- risk if ignored: confusing or unsafe edits against the wrong perceived workspace.

#### Library source switching bypasses dirty-editor guards

- severity: P2 important bug
- evidence:
  - top navigation has dirty guards for Library and Settings at `src/App.tsx:783-800`.
  - config target selection has a dirty guard at `src/App.tsx:802-805`.
  - Library source rail calls `onSetSourceType(st.id)` directly at `src/views/LibraryView.tsx:924-928`.
  - editor state is source-specific and can be reset when active content/source changes.
- root cause: dirty guard logic lives around top-level view switches and selected config target switches, but not around internal Library source changes.
- user impact: unsaved Docs, Rules, Agents, or Configs edits can be lost when switching Library source sections.
- recommended fix: route Library source changes through an App-level guarded setter that checks the dirty flag for the current source before switching.
- suggested verification: edit a doc/rule/agent/config without saving, switch Library source, and confirm the leave confirmation appears and cancel preserves draft state.
- risk if ignored: local data loss and reduced trust in the editor.

#### `create_doc` lacks the backend content size limit used by saves

- severity: P2 security/resource boundary
- evidence:
  - `MAX_DOC_SIZE` is defined at `src-tauri/src/commands/content.rs:332`.
  - `save_doc_at_root` rejects content over 512 KB at `src-tauri/src/commands/content.rs:402-410`.
  - `create_doc_at_root` accepts `content: Option<String>` and writes it without the same size check at `src-tauri/src/commands/content.rs:459-492`.
- root cause: create and save paths enforce different backend limits.
- user impact: current UI passes `null` content, but the registered Tauri command boundary can write oversized content if called from the webview.
- recommended fix: apply `MAX_DOC_SIZE` to the resolved initial content before `std::fs::write`.
- suggested verification: add a Rust test that `create_doc_at_root` rejects content over 512 KB.
- risk if ignored: avoidable resource exhaustion and inconsistent command contracts.

#### Workspace path trust is marker-based while actions execute workspace scripts

- severity: P2 security/trust boundary
- evidence:
  - workspace validation requires marker files under the selected path at `src-tauri/src/commands/workspace.rs:100-117`.
  - allowlisted actions execute scripts from the selected workspace, for example `bash scripts/setup-agent-workspace.sh ...` at `src-tauri/src/commands/actions.rs:92-119` and release/check scripts later in that file.
  - command dispatch itself is allowlisted, but selected workspace scripts are trusted.
- root cause: the app is intentionally a thin wrapper around local scripts, but selecting a workspace also delegates execution trust to that workspace’s script tree.
- user impact: choosing an untrusted folder that looks like a workspace can execute its scripts through safe-looking GUI buttons.
- recommended fix: keep the thin-wrapper model, but make the trust boundary explicit in UI/docs and consider showing workspace identity/source warnings before executing scripts from non-default paths.
- suggested verification: confirm all script-running actions display the selected workspace path and are disabled for invalid workspaces.
- risk if ignored: users may not understand that workspace selection grants script execution authority.

#### Relative workspace paths are persisted and resolved against process cwd

- severity: P2 correctness/security hardening
- evidence:
  - relative non-tilde paths are intentionally preserved in `src-tauri/src/path_utils.rs:80-84`.
  - workspace validation canonicalizes the eventual path at `src-tauri/src/commands/workspace.rs:100-103`.
- root cause: normalization expands `~` but does not require an absolute path.
- user impact: the same settings value can resolve differently if app cwd changes, which is confusing for a GUI and weakens auditability.
- recommended fix: convert workspace paths to absolute paths on save or reject relative workspace paths with a clear error.
- suggested verification: add tests for relative path rejection/absolutization and verify Settings/Workspace error states.
- risk if ignored: accidental operation on an unintended relative workspace.

#### Terminal output has no defensive redaction boundary

- severity: P2 security/no-print boundary
- evidence:
  - terminal rendering prints raw `stdout` and `stderr` from action results at `src/components/TerminalOutput.tsx:76-86`.
  - the app intentionally runs diff/sync/release scripts that can emit user-managed file content.
- root cause: output display trusts scripts to avoid printing sensitive material.
- user impact: if scripts or diff output include credential-adjacent text, the GUI will display it verbatim.
- recommended fix: keep output useful, but add a documented no-print boundary: redact common secret patterns before display, and/or add per-action warnings for diff commands that can show local file contents.
- suggested verification: feed a synthetic action result with representative token-like strings and confirm displayed output is redacted without corrupting normal logs.
- risk if ignored: accidental display of sensitive local content in screenshots, screen shares, or logs.

#### Workspace action runners are UI-disabled but not invocation-guarded

- severity: P2 logic/UX
- evidence:
  - `runWsAction` sets `wsRunning` at `src/App.tsx:807-810`.
  - `runWsInstall` follows the same pattern at `src/App.tsx:833-859`.
  - the backend command can still be called while state updates are pending; late results overwrite `wsLog`.
- root cause: concurrency prevention is implemented as button disabled state, not as a request lock/generation inside the action runner.
- user impact: double-clicks or rapid interactions can produce overlapping actions and misleading final terminal output.
- recommended fix: use a ref-based in-flight guard and request id for action results.
- suggested verification: double-click an action button in a dev build and confirm only one backend invocation is made.
- risk if ignored: terminal output and status can represent the wrong/latest-finishing action.

### P3 polish/maintenance

#### Routing profile surface is half-retired

- severity: P3 maintenance/stale UX
- evidence:
  - current `src/views/RoutingView.tsx:1-104` is a Brain Setup clipboard view.
  - unused routing components/helpers remain: `src/views/routing/RoutingMatrix.tsx`, `src/views/routing/routingCompatibility.ts`, `src/views/routing/routingTemplates.ts`.
  - backend routing commands are still registered at `src-tauri/src/lib.rs:57-59`.
  - README still describes old routing profile UI files and a nonexistent `RoutingCompatibilityOverview.tsx` at `README.md:247-251`.
  - default docs explicitly say execution profiles are not visible in the GUI anymore at `resources/default-workspace/docs/USING_THE_APP.md:93`.
- root cause: the UI was simplified but compatibility/backend/docs were not reconciled.
- user impact: contributors cannot tell whether routing profiles are supported, legacy, or dead.
- recommended fix: decide one path: document backend-only compatibility and remove stale UI references, or restore a small supported Routing UI.
- suggested verification: `rg` confirms no app imports stale components; docs match actual navigation.
- risk if ignored: future edits revive dead paths or break backend compatibility unintentionally.

#### App and view components are too large for safe local reasoning

- severity: P3 architecture maintenance
- evidence:
  - `src/App.tsx` is 1166 lines.
  - `src/views/WorkspaceView.tsx` is 1247 lines.
  - `src/views/LibraryView.tsx` is 960 lines.
  - `src/styles.css` is 4509 lines.
- root cause: state orchestration, resource loading, editor dirty state, workspace actions, and UI layout are concentrated in a few files.
- user impact: small changes have high regression risk; the stale loader and dirty-guard gaps above are symptoms.
- recommended fix: extract narrow hooks/components only around active risk boundaries: workspace resource loader, Library dirty source switcher, terminal action runner.
- suggested verification: no behavior change; build plus targeted manual smoke of Workspace and Library.
- risk if ignored: incremental bug fixes stay expensive and fragile.

#### Custom controls have practical accessibility gaps

- severity: P3 accessibility/UX
- evidence:
  - install agent/scope toggle buttons do not expose `aria-pressed` at `src/views/WorkspaceView.tsx:686-699`.
  - project install target input has no programmatic label at `src/views/WorkspaceView.tsx:707-713`.
  - skills search input has no programmatic label at `src/views/WorkspaceView.tsx:740-746`.
  - skill selection check button uses only `x`/empty text and `aria-pressed` at `src/views/WorkspaceView.tsx:763-769`.
  - Library source rail uses `role="tablist"` but has no roving/arrow keyboard behavior at `src/views/LibraryView.tsx:920-937`.
  - Rules sidebar has a button with a no-op handler at `src/views/LibraryView.tsx:196-199`.
- root cause: native buttons are used, but custom toggle/tab semantics are incomplete.
- user impact: keyboard and screen-reader users get ambiguous control state and inconsistent navigation.
- recommended fix: add labels/pressed states; either implement tab keyboard behavior or use toolbar/list semantics; replace no-op button with static text or a real selectable control.
- suggested verification: keyboard-only pass through top nav, Workspace actions, Library source rail, editor controls, and Settings.
- risk if ignored: avoidable accessibility friction in core workflows.

#### README is stale in several operational details

- severity: P3 docs
- evidence:
  - README says Workspace startup loads routing data at `README.md:58-60`; current startup loads skills/docs/agents/contract/status, not routing profiles.
  - README references `bootstrap_*` and `verify_state` as custom-workspace actions at `README.md:81`; these backend actions remain, but the current GUI no longer exposes them.
  - README lists nonexistent `RoutingCompatibilityOverview.tsx` at `README.md:251`.
- root cause: docs did not follow the Brain Setup/Routing simplification.
- user impact: contributors waste time looking for old UI and action paths.
- recommended fix: update README architecture and app-surface sections to match current GUI and backend compatibility state.
- suggested verification: `rg` for removed names and compare README tree to `rg --files`.
- risk if ignored: onboarding and release review stay noisy.

#### Backup folder action is unnecessarily tied to valid workspace

- severity: P3 UX
- evidence:
  - `open_backups_folder` calls `workspace_root()?` before opening the backup root at `src-tauri/src/commands/backups.rs:253-269`.
- root cause: backup command reuses workspace validation even though the backup root is app-level.
- user impact: users cannot open backups from an invalid or missing workspace state, even when backups exist.
- recommended fix: allow opening the backup root after validating only the backup root; keep backup detail listing workspace-independent.
- suggested verification: set an invalid workspace path and confirm the backup folder can still open.
- risk if ignored: recovery UX is worse exactly when workspace setup is broken.

#### Minor stale or brittle UI text exists

- severity: P3 polish
- evidence:
  - Library config view hard-codes `6 agents bundled` at `src/views/LibraryView.tsx:381-382` and `src/views/LibraryView.tsx:811-812`.
  - terminal idle hint suggests `release-check` regardless of current availability at `src/views/WorkspaceView.tsx:1231`.
- root cause: static copy duplicates runtime state.
- user impact: small trust gaps when bundled targets or action availability changes.
- recommended fix: derive counts/status from runtime metadata.
- suggested verification: alter target metadata in a test fixture or mock and confirm UI text follows it.
- risk if ignored: low, but contributes to stale-status noise.

## Security review

### Command execution

Frontend-triggered command execution is allowlisted. `run_action(action: String)` dispatches exact action names rather than accepting arbitrary programs or args. The lower-level process helper uses `Command::new(program).args(args)` rather than shell string concatenation. No `sh -c` or arbitrary frontend-supplied program flow was found in the Tauri command path.

Residual risk: selected workspace scripts are trusted. GUI actions execute scripts under the current workspace, so workspace selection is a script trust boundary, not just a data-directory setting.

### Filesystem writes

Doc, config, agent, and routing saves generally resolve fixed registry paths or slug-derived paths, then use canonical containment checks. `safe_canonical_target` canonicalizes the workspace and existing target/ancestor before accepting writes. Size limits exist for save paths, config templates, agent templates, agent sources, routing profiles, and metadata; `create_doc` is the confirmed gap.

### Path validation

Workspace root validation canonicalizes and requires marker files. Content writes enforce workspace-root containment. `normalize_user_workspace_path` preserves relative paths, which should be tightened for a desktop GUI. Script-level install targets have additional path checks, but advanced environment overrides in bundled scripts intentionally permit non-default destinations.

### Workspace creation

Creation uses a bundled default workspace source, rejects broad unsafe targets, copies an allowlisted file list, and validates the result. `fs::create_dir` on a missing target avoids following a newly inserted target symlink. This area looks materially bounded.

### Settings persistence

Settings are normalized and persisted through Rust commands. Main concern is relative workspace path ambiguity and frontend races around applying new settings.

### Backups

Backups default to an app support directory. `AGENT_WORKSPACE_BACKUP_DIR` is an intentional documented/test override with broad-root refusal. Backup list/detail paths validate run ids and canonical containment under backup root. `open_backups_folder` should not require a valid workspace.

### Tauri capabilities

`src-tauri/capabilities/default.json` allows only `core:default` and `dialog:allow-open`. This is minimal for the current app. `src-tauri/tauri.conf.json` has a restrictive CSP with inline styles allowed for the current React/CSS model.

### Script invocation

Actions map to explicit local scripts. The app does not synthesize shell command strings from user input. The trust boundary is script content in the selected workspace and documented env overrides inside scripts.

### Terminal/log output

Terminal output displays raw action stdout/stderr. This preserves utility but lacks a no-print safety layer. Treat script output and diffs as potentially sensitive user-local content.

### Sensitive data/no-print boundaries

No secret values were inspected or printed. No `.env*`, private keys, credential stores, dumps, or unrelated personal files were opened. The main no-print risk is future terminal output from scripts, not a secret discovered during this audit.

## Architecture review

### Current boundaries

The app mostly remains a thin GUI wrapper around existing scripts and explicit local file operations:

- React manages view state, editor drafts, and button affordances.
- Tauri commands expose allowlisted actions and file operations.
- Bundled default workspace resources seed the workspace.
- Scripts remain the source of truth for install/sync/release behavior.

### Largest complexity hotspots

- `src/App.tsx`: state orchestration, dirty guards, resource loading, workspace path changes, action runners, settings, and editor save flows are mixed in one component.
- `src/views/WorkspaceView.tsx`: terminal, inventory, skills install, release, backups, create workspace, and diagnostics are one large view.
- `src/views/LibraryView.tsx`: source switching, multiple editor modes, sidebars, and item lists are concentrated.
- `src-tauri/src/commands/content.rs`, `routing.rs`, and `workspace.rs`: large modules with solid tests but broad responsibilities.

### Duplication

- Routing compatibility/profile logic remains in frontend and backend even though current Routing UI is Brain Setup only.
- Agent/source target metadata is duplicated between Rust registries, frontend text, README, and bundled docs.
- Dirty-state handling is duplicated per editor type rather than centralized around Library source transitions.

### Safest simplification opportunities

- Extract a `useWorkspaceResources` hook with request generation checks.
- Add a single guarded `setLibrarySourceType` path.
- Extract terminal action execution into a hook with an in-flight ref and result generation id.
- Reconcile routing docs/components/commands into a documented compatibility surface or remove unused frontend files after confirming no downstream consumers.

### Things not worth changing

- Do not replace the script-backed architecture with an internal orchestration layer.
- Do not add a shell abstraction or background worker system.
- Do not introduce new dependencies for markdown, terminal display, or state management until the current boundaries are fixed.

## Frontend/UI/UX review

### Workspace

The Workspace page has high functional density: path/status, inventory, skills install, release, backups, terminal, and create flow. The terminal/native utility aesthetic fits the product, but hierarchy is strained. The most confusing behavior is the path draft field in Inventory: it edits local state but does not have an adjacent apply/save action.

### Library

Library is powerful but source switching is risky because dirty guards are missing. The source rail and editor tab patterns look like tabs but are mostly button lists; they need either complete tab semantics or simpler list/toolbar semantics.

### Routing

Routing is currently a Brain Setup clipboard utility. That may be the right product shape, but old routing profile code and README claims create uncertainty about what is supported.

### Settings

Settings has better visible dirty state and save/reset affordances than Library. Target profile selection is understandable, but it relies on derived state from App; stale loader fixes should cover this too.

### Terminal/output

Terminal output is readable and copyable via `<pre>`, but stale action timing and overlapping action races can mislead. Raw stdout/stderr display is useful but needs no-print guidance or redaction for common sensitive patterns.

### Responsive/overflow

CSS uses fixed utility-like panels and many custom components. Overflow handling exists in terminal/code areas, but large pages are dense and likely require manual browser QA at narrower widths before release.

### Empty/loading/error states

Workspace has useful invalid/missing workspace states. Library has empty states. Some status text is static or stale-prone, especially release hints and hard-coded bundle counts.

## Accessibility review

### Keyboard

Native buttons are generally keyboard reachable. Custom tablists/source switches do not implement expected arrow-key navigation. If full tab semantics are not planned, the roles should be simplified.

### Focus

Buttons have visible focus styling. Some inputs rely heavily on border-color changes; increase focus visibility for search/path/target inputs.

### ARIA

Add `aria-pressed` to install agent and install-scope toggles. Add labels to search and path inputs. Add explicit labels to icon/text-only clear/check buttons. Use `aria-expanded` where panels open/close.

### Contrast/color-only indicators

Most status chips include text, not only color. Selection controls that show only background and an `x` should include accessible names and non-color state.

### Actionable fixes

Prioritize Library source dirty guard, labels/pressed states for Workspace selectors, and replacing the no-op Rules button.

## Deprecated/dead/stale code candidates

These are candidates with evidence, not removal instructions:

- `src/views/DocsView.tsx`: exported but no current import found by `rg`; Library owns docs editing now.
- `src/views/routing/RoutingMatrix.tsx`: exported but no current import found by `rg`.
- `src/views/routing/routingCompatibility.ts`: exported `buildCompatibilityRows` but no current import found by `rg`.
- `src/views/routing/routingTemplates.ts`: referenced in README tree, not by current app entry points.
- `src-tauri/src/commands/routing.rs` commands: still registered and tested; default docs describe backend metadata compatibility, so either document as backend-only or remove after compatibility decision.
- `list_agent_sources`: registered in `src-tauri/src/lib.rs` and defined in `content.rs`; current frontend uses `list_agent_metadata` for Library agent sources.
- `bootstrap_preview`, `bootstrap_diff`, `bootstrap_apply`, `verify_state`: backend action arms remain, README references them, but current GUI no longer exposes those actions.
- `README.md` references nonexistent `RoutingCompatibilityOverview.tsx`.

## Dependency review

### Frontend dependencies

Direct dependency surface is small and appropriate:

- runtime: `@tauri-apps/api`, `@tauri-apps/plugin-dialog`, `react`, `react-dom`
- build/dev: `@tauri-apps/cli`, React types, Vite React plugin, TypeScript, Vite

`npm outdated --json` showed patch/minor updates:

- `@tauri-apps/api` `2.10.1` -> `2.11.0`
- `@tauri-apps/cli` `2.10.1` -> `2.11.1`
- `@tauri-apps/plugin-dialog` `2.7.0` -> `2.7.1`
- `react` / `react-dom` `19.2.5` -> `19.2.6`

Major updates are available but should be deferred and tested separately:

- `vite` `6.4.2` -> `8.0.11`
- `@vitejs/plugin-react` `4.7.0` -> `6.0.1`
- `typescript` `5.9.3` -> `6.0.3`

### Rust dependencies

Direct Rust dependency surface is minimal:

- `tauri = "2"`
- `tauri-plugin-dialog = "2"`
- `serde`
- `serde_json`

Crates.io currently reports `tauri = "2.11.1"` and `tauri-plugin-dialog = "2.7.1"`.

### Upgrade/cleanup candidates

- Patch Tauri JS/Rust/plugin versions together in one maintenance slice.
- Patch React/React DOM in the same or next slice.
- Defer Vite/React plugin/TypeScript major upgrades until after release blockers are fixed.

### Risk/benefit

Patch updates are low-to-medium risk and mainly reduce drift. Major build-tool updates are not urgent because `npm run build` passes and the app has higher-value correctness issues first.

## Verification results

- `npm run build`: PASS
  - ran `tsc && vite build`
  - Vite `v6.4.2`
  - transformed 44 modules
  - emitted `dist/index.html`, CSS, and JS bundle
- `cargo fmt --check` from `src-tauri`: PASS
- `cargo check` from `src-tauri`: PASS
- `cargo clippy --all-targets --all-features -- -D warnings` from `src-tauri`: FAIL
  - 25 `clippy::ptr_arg` errors in test/helper code
  - representative files: `content.rs`, `contract.rs`, `defaults.rs`, `routing.rs`, `skills.rs`, `workspace.rs`
- `cargo test` from `src-tauri`: PASS
  - 231 lib tests passed
  - 0 main tests
  - 0 doctests
- `./scripts/release-check.sh`: PASS
  - runs script syntax checks, repo hygiene checks, bundled default workspace checks, forbidden scans, `npm run build`, `cargo fmt --check`, `cargo check`, narrower `cargo clippy -- -D warnings`, and `cargo test`
  - printed `release-check passed`
- dependency freshness:
  - initial non-escalated npm/cargo registry queries failed due restricted network/DNS
  - escalated `npm outdated --json` and `cargo search ...` succeeded

## Recommended follow-up implementation slices

### Slice 1: Make release verification strict and green

- objective: fix all-targets Clippy errors and make release-check run the same strict Clippy gate.
- files likely touched: Rust test/helper signatures in `src-tauri/src/commands/*.rs`, `scripts/release-check.sh`.
- risk level: low.
- behavior changes: no runtime behavior change.
- verification commands: `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test`, `./scripts/release-check.sh`.
- why now/deferred: do now; this is the release blocker.

### Slice 2: Guard workspace resource loading against stale responses

- objective: ensure only the latest workspace/settings generation can update workspace-dependent frontend state.
- files likely touched: `src/App.tsx`, optionally a new `src/lib` or hook file.
- risk level: medium.
- behavior changes: yes, stale results are ignored and path changes clear stale panels.
- verification commands: `npm run build`, manual smoke switching workspace paths, invalid workspace path check, Library/Workspace load check.
- why now/deferred: do after Slice 1; it reduces wrong-workspace risk.

### Slice 3: Fix dirty guards inside Library

- objective: prevent unsaved editor drafts from being lost when switching Library source sections.
- files likely touched: `src/App.tsx`, `src/views/LibraryView.tsx`, `src/lib/editorGuards.ts`.
- risk level: medium.
- behavior changes: yes, confirmation appears on dirty source switches.
- verification commands: `npm run build`, manual edit/switch/cancel/save flows for Docs, Rules, Agents, Configs.
- why now/deferred: do soon; it addresses direct data-loss risk.

### Slice 4: Tighten backend file/path boundaries

- objective: apply size limits to `create_doc`, require or canonicalize absolute workspace paths, and add tests.
- files likely touched: `src-tauri/src/commands/content.rs`, `src-tauri/src/path_utils.rs`, `src-tauri/src/settings.rs`, possibly `src-tauri/src/commands/workspace.rs`.
- risk level: medium.
- behavior changes: yes, relative workspace paths may be rejected or normalized.
- verification commands: `cargo fmt --check`, `cargo check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test`.
- why now/deferred: do after confirming desired relative-path compatibility.

### Slice 5: Reconcile Routing compatibility surface

- objective: choose and document whether routing profiles are backend-only compatibility or active UI; remove stale README/UI references accordingly.
- files likely touched: `README.md`, `resources/default-workspace/docs/USING_THE_APP.md`, `src/views/routing/*`, `src-tauri/src/lib.rs`, `src-tauri/src/commands/routing.rs`.
- risk level: medium.
- behavior changes: depends on whether commands are retained.
- verification commands: `npm run build`, Rust checks, `rg` for stale routing names, release-check.
- why now/deferred: defer until after blockers; it is maintenance clarity unless users depend on routing profiles.

### Slice 6: Accessibility and control semantics pass

- objective: add labels/pressed/expanded states, simplify or complete tab semantics, and remove no-op buttons.
- files likely touched: `src/views/WorkspaceView.tsx`, `src/views/LibraryView.tsx`, `src/views/SettingsView.tsx`, `src/styles.css`.
- risk level: low-to-medium.
- behavior changes: mostly accessibility behavior, minimal visual changes.
- verification commands: `npm run build`, keyboard-only smoke through Workspace/Library/Settings, screen-reader spot check if available.
- why now/deferred: do after dirty-state fixes so semantics align with final behavior.

### Slice 7: Dependency patch update

- objective: update low-risk Tauri/React patch versions after correctness fixes.
- files likely touched: `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`.
- risk level: low-to-medium.
- behavior changes: no intended behavior change.
- verification commands: `npm install`, `npm run build`, all Rust checks, `./scripts/release-check.sh`.
- why now/deferred: defer until release blocker and correctness fixes are green.
