# App Release Smoke

Manual smoke checklist for Agent Workspace app builds. Complements `scripts/release-check.sh` (automated syntax, bundled-default checks, forbidden-source scans, app build, Cargo checks). `scripts/release-check.sh` does not test GUI behavior, installed-app bundles, workspace creation, or folder picker interactions.

Run this checklist before sharing a built app bundle with another user.

## 1. Preflight

- [ ] `git status --short` is clean (no uncommitted changes)
- [ ] `./scripts/release-check.sh` passes
- [ ] `npm run tauri build` succeeds (skip if environment cannot produce macOS bundles)
- [ ] No secrets, private keys, names, or credential-bearing data in `resources/default-workspace/`
- [ ] Current branch and commit noted for the pass/fail report
- [ ] `./scripts/release-size-report.sh` runs and sizes are within expected range

## 2. Build / Install Smoke

- [ ] App bundle was built successfully (or dev mode confirmed working)
- [ ] App launches without generic error banner (no "Contract: invalid workspace path" on first launch)
- [ ] Error/info banner does not overlap macOS traffic-light buttons (Tauri overlay title bar)
- [ ] Start view and main content scroll when content exceeds window height (Tauri build)
- [ ] Product-facing title "Agent Workspace" is visible (window title, or branding)
- [ ] Bundled default workspace preview appears in Workspace tab (not only in dev source checkout)

## 3. Workspace Setup Smoke

Folder picker and workspace path:

- [ ] Click "choose folder" in Workspace tab — native folder dialog opens
- [ ] Select a folder — workspace path is saved and diagnostics refresh
- [ ] Cancel the picker — path remains unchanged
- [ ] Type a path manually — draft updates
- [ ] Empty/cleared path falls back to env var or built-in default
- [ ] Invalid workspace path shows missing markers and "invalid workspace"
- [ ] Workspace view shows compact validity note and first-run guide when no valid workspace selected
- [ ] First-run guide shows 5 numbered steps (choose path, dry-run, create, library, dry-run sync) and security hints
- [ ] Idle terminal shows "$ operations ready" with workspace status, branch, and target counts
- [ ] Idle terminal suggests next commands: "try: pull, diff rules, sync configs, release-check"
- [ ] After a command runs, the terminal shows the action name, OK/FAILED status, exit code, and relative timestamp
- [ ] Running commands show "$ <label>..." with activity loader animation

## 4. Create Workspace Smoke

Use a safe throwaway folder, e.g. `~/Desktop/agent-workspace-smoke-test`.

- [ ] Type or choose a missing/empty target path
- [ ] Click "dry-run create"
- [ ] Plan status is `missing_directory` or `empty_existing_directory`
- [ ] "create workspace" button appears (only for safe statuses)
- [ ] Click "create workspace"
- [ ] Confirm created files:
  - [ ] `.agent-workspace/workspace.json`
  - [ ] `README.md`
  - [ ] `docs/`
  - [ ] `templates/`
  - [ ] `agents/`
  - [ ] `scripts/`
  - [ ] `skills/`
- [ ] Confirm bundled skill files exist:
  - [ ] `skills/diagnose/SKILL.md`
  - [ ] `skills/security-review/SKILL.md`
  - [ ] `skills/context-budget/SKILL.md`
- [ ] App auto-saves and uses the created workspace
- [ ] Diagnostics show valid workspace with all markers present
- [ ] Scripts were not executed (check file timestamps or content integrity)
- [ ] Existing files in the target were not overwritten
- [ ] Non-empty, unsafe, valid-existing, or missing-parent targets are rejected by dry-run
- [ ] Remove throwaway test folder after test

## 5. Library and Default Workspace Smoke

- [ ] Library view shows a three-column layout: source rail (Docs, Rules, Skills, Agents, Configs), item sidebar, and content pane
- [ ] Source rail uses text-only labels with count badges; no unicode icons
- [ ] Source rail active source has a subtle accent underline indicator
- [ ] Library view allows switching between source types: Docs, Rules, Skills, Agents, Configs
- [ ] Docs are grouped by section in the sidebar (Start, Guides, Reference, Context)
- [ ] Start section includes README, Start Here, and Concepts
- [ ] Guides section includes Using the App, Git Versioning, and Workflows (when present)
- [ ] Reference section includes Skills, Agent Rules, OpenCode Config, and Troubleshooting (when present)
- [ ] Selecting a doc renders its Markdown content in the main pane
- [ ] "open" button opens the doc in the system editor
- [ ] Rules shows Global Rules template with preview/edit tabs
- [ ] Skills shows search-filtered skill list with preview
- [ ] Agents shows agent source list with edit/save functionality
- [ ] Configs shows config targets with JSON preview and edit
- [ ] Bundled starter preview in Workspace tab shows known categories and file paths
- [ ] Bundled starter preview shows non-empty Skills category
- [ ] Bundled default resources contain no private names, secrets, or core-skill-subset language
- [ ] Workspace docs are separate from templates/config (Library handles source editing; Workspace handles operations)

## 6. Sync / Install Smoke (Caution)

Dry-runs only unless testing your own machine:

- [ ] In a created or selected workspace, `scripts/install-agent-rules.sh --quiet --diff --opencode --codex --claude --auggie` reports synced/diverged
- [ ] In a created or selected workspace, `scripts/install-opencode-config.sh --quiet --diff` reports synced/diverged for config + tui + agents
- [ ] In a created or selected workspace, `scripts/install-skills.sh --quiet --dry-run --agent codex --agent opencode --agent claude --agent auggie --global` reports planned counts
- [ ] install-skills dry-run from a created workspace reports the bundled skills
- [ ] In a created or selected workspace, `scripts/bootstrap.sh --quiet --diff --skip-skills --codex --opencode --claude --auggie` completes without error
- [ ] Do not run `--apply` actions when testing someone else's machine
- [ ] Real apply creates backups under `~/Library/Application Support/ai.agentworkspace.app/backups` before overwriting diverged target files

## 7. Skills Selection Smoke (Workspace Operations)

- [ ] Workspace SKILLS operation block shows selected count and agent toggles (global install only)
- [ ] "select skills" button expands the skills selector
- [ ] Search input filters skills by name, id, and description
- [ ] "all" selects all skills; "clear" deselects all
- [ ] Checkbox toggles install selection for each skill
- [ ] Agent toggles (codex, opencode, claude, auggie, cursor) are visible and toggleable
- [ ] No project scope toggle or project target path input in Skills panel
- [ ] Cursor Profile panel has no project target input or project sync/diff buttons
- [ ] Cursor actions grouped: Global (refresh/diff/sync/validate), Rules (show/copy/settings), Templates (MCP/sandbox show/copy)
- [ ] "hide selector" collapses the skills selector
- [ ] Dry-run and install actions behave identically to previous behavior
- [ ] "open script" button opens install-skills.sh in system editor

## 8. Brain Setup Smoke

- [ ] Brain Setup page renders the generated prompt block with skill routing, model recommendations, security rules, and verification discipline
- [ ] "copy brain setup" button copies the prompt block to clipboard
- [ ] Pasted block is well-formed and ready for AI assistant custom instructions

## 9. Backup Smoke

- [ ] "open backup folder" opens the backup directory in Finder
- [ ] Backup folder opens even with an invalid/empty workspace (backups are app-level, not workspace-dependent)
- [ ] Backup listing shows timestamped backup directories

## 10. Terminal Redaction Smoke

- [ ] Run a safe action (dry-run sync, diff, or contract check) and confirm terminal output appears
- [ ] Check that terminal output does not contain raw file content, secrets, or private paths if any fixture data would include them
- [ ] Terminal shows action label, OK/FAILED status, exit code, and relative timestamp

## 11. Settings Smoke

- [ ] Settings view shows Appearance (dark/light/system) and Accent color picker with hex input
- [ ] Changing accent via color picker updates the hex input and applies accent immediately
- [ ] Typing a valid hex color updates the color picker and applies accent immediately
- [ ] Typing an invalid hex shows a validation hint and disables the save button
- [ ] The last valid accent remains applied while an invalid hex is being typed
- [ ] Clicking "default" on the accent row clears the input and resets to the built-in accent
- [ ] "save" button saves accent color to persisted settings
- [ ] After save, the hex input and picker remain in sync with persisted settings
- [ ] "reset defaults" clears the accent and all settings to factory defaults
- [ ] Rule targets and config targets can be toggled individually
- [ ] Target profiles can be applied and show matched profile name

## 12. Lazy-Loaded Views Smoke

- [ ] Click Library tab — view loads with brief "loading library…" fallback, then renders
- [ ] Click Brain Setup tab — view loads with brief "loading…" fallback, then renders
- [ ] Click Settings tab — view loads with brief "loading…" fallback, then renders
- [ ] Switching back to Workspace tab is instant (eager-loaded)
- [ ] No console errors during lazy view transitions

## 13. Keyboard Navigation Smoke

- [ ] Tab through top nav icons (Workspace, Library, Brain Setup, Settings) — focus ring visible
- [ ] Tab through Workspace controls — focus ring visible on all buttons
- [ ] Tab through Library source rail — focus ring visible
- [ ] Tab through skill search and selector — focus ring visible
- [ ] Tab through Settings controls — focus ring visible
- [ ] Escape or click dismisses error banner
- [ ] Search "clear" buttons are labeled and keyboard-accessible

## 14. Known Limitations

- Workspace marker naming is `.agent-workspace/workspace.json` (established contract marker)
- Create flow has no rollback on rare I/O/race failure after preflight
- Import/upgrade flow is not implemented
- First public/share build should be tested as an installed `.app` bundle, not only dev mode
- `create_workspace_from_defaults` copies files only — no dependency install, no git init, no post-create hook
- Workspace scripts in the created workspace are copies of the bundled defaults and may not match the repo originals after bundles are updated
- Clean git status should be confirmed — residual dev artifacts in `dist/` or `target/` could be bundled unintentionally

## 15. Pass / Fail Report Template

Copy this template and fill in results.

```
## Agent Workspace App Smoke Report

- Commit: ________
- Build command: ________
- Machine: ________
- App version: ________
- App bundle path: ________ (or "dev mode")

### Checks Passed
- [ ] Preflight (clean git, release-check, build, size report)
- [ ] Build/install (launch, no error banner, product name, bundled preview)
- [ ] Workspace setup (folder picker, save, diagnostics, idle terminal, result timestamp)
- [ ] Create workspace (dry-run, create, files, validation, no-overwrite, no-execute, rejection of unsafe targets)
- [ ] Library (source rail nav, sidebar items, edit/save docs, agents, configs, skills)
- [ ] Brain Setup (copy block, clipboard, well-formed output)
- [ ] Backup (open folder, listing, works with invalid workspace)
- [ ] Terminal redaction (safe fixture output, no raw secrets)
- [ ] Settings (appearance, accent picker, hex input, save, reset)
- [ ] Sync dry-runs (rules diff, config diff, skills dry-run, bootstrap diff)
- [ ] Lazy-loaded views (Library, Brain Setup, Settings load with fallback)
- [ ] Keyboard navigation (focus-visible rings, error dismiss, search clear)

### Checks Failed
- ________

### Notes
- ________

### Release Decision
- [ ] Ready to share
- [ ] Not ready — needs fixes
```
