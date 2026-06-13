# App Release Smoke

Manual smoke checklist for Agent Workspace app builds. Complements `scripts/release-check.sh` (automated syntax, bundled-default checks, forbidden-source scans, app build, Cargo checks). `scripts/release-check.sh` does not test GUI behavior, installed-app bundles, or folder-picker interactions.

## Automated backend runtime smoke

For Tauri IPC-backed status without manual clicking or a live webview:

```bash
./scripts/smoke-tauri-runtime.sh
```

**Covers:** temp `HOME` + `AGENT_WORKSPACE_PATH`, workspace diagnostics, `get_status` sync fields, OpenCode runtime health, Cursor profile health, Brain Setup seed (no bundled private context).

**Does not cover:** Tauri webview routes, `invoke` in a browser, macOS window automation, or a real user profile. Playwright against `http://localhost:1420` only sees the Vite shell (no Tauri backend). Backend runtime smoke is not a substitute for actual isolated Tauri webview smoke below.

## Actual Tauri webview smoke (required before release)

Run the built or dev Tauri app with isolated `HOME`, `AGENT_WORKSPACE_PATH`, and backup paths. Verify in the real webview (not Vite-only):

### Uninstall and recovery

- [ ] Install into isolated `HOME`, workspace root, and backup root overrides
- [ ] **preview uninstall** classifies removable, preserved, and merge-managed artifacts
- [ ] Modified and unknown fixture files remain on disk after uninstall preview/apply
- [ ] **uninstall everything** removes proven app-owned files and invalidates or removes the workspace
- [ ] **Recover previous uninstall** remains visible after the workspace becomes invalid or missing
- [ ] **preview recovery** runs read-only dry-run and reports to restore / already restored / conflicts counts
- [ ] **restore workspace** opens confirmation; Escape closes and focus returns to the restore button
- [ ] Cancel confirmation leaves the recovery candidate unchanged
- [ ] **confirm restore** brings workspace and harness state back; Installed State Map and health refresh
- [ ] Recovery card disappears only after successful rollback
- [ ] Create a changed or occupied restore target; dry-run reports conflict and restore stays disabled
- [ ] No console errors during uninstall, recovery preview, or restore flows

### Codex 0.134+ migration

- [ ] Current top-level managed fields `approval_policy` and `sandbox_mode` apply correctly
- [ ] App-shaped legacy `profile = "safe"` / `"workspace-write"` selectors and `[profiles.*]` tables are removed when still app-shipped
- [ ] Custom profiles and unrelated keys remain
- [ ] Model, personality, MCP entries, and comments remain
- [ ] Same-line inline comments on managed fields remain
- [ ] Ambiguous managed lines refuse safely with zero mutation

### Settings and current UI

- [ ] Fresh and legacy settings enable Codex, OpenCode, Claude, and Cursor
- [ ] Disable one harness: its nav icon, page, Installed row, health calls, and harness-specific Library entries disappear
- [ ] Existing isolated harness files remain byte-identical after disable
- [ ] Restart preserves the disabled state and prior fine-grained target selections
- [ ] Re-enable restores UI and health without automatic installation
- [ ] Disable every harness: Workspace, Repo Dashboard, Prompt Loops, generic Library content, and Settings remain usable
- [ ] Explicit stale setup for a disabled harness fails without mutation
- [ ] Full uninstall preview still includes proven app-owned artifacts from disabled harnesses; rollback remains complete
- [ ] Installed State Map renders workspace, Codex, OpenCode, Claude, and Cursor groups and reflects status changes after managed actions
- [ ] Reduce Motion disables pulse, scan, and flash animation classes
- [ ] Landing page selection (`start`, `repo-dashboard`, `prompts`, `library`) persists and opens the selected view after app restart
- [ ] Appearance changes reset background and foreground overrides according to current behavior
- [ ] All four text sizes remain usable at minimum supported window size

### Installation rollback and dialogs

- [ ] Rollback dry-run after simulated interruption reports correct reconciliation
- [ ] Rollback retry does not restore already-completed artifacts twice
- [ ] `rolling_back` transaction with all artifacts restored finalizes without extra filesystem mutations
- [ ] Conflict review dialog: keyboard open, Escape closes, focus returns, and safe operations remain actionable
- [ ] No console errors during rollback and Codex apply flows

Run this checklist before sharing a built app bundle with another user.

## 1. Preflight

- [ ] `git status --short` is clean (no uncommitted changes)
- [ ] `./scripts/release-check.sh` passes
- [ ] `npm run tauri build` succeeds (skip if environment cannot produce macOS bundles)
- [ ] No secrets, private keys, names, or credential-bearing data in `resources/default-workspace/`
- [ ] Current branch and commit noted for the pass/fail report
- [ ] `./scripts/release-size-report.sh` runs and sizes are within expected range

## 2. Build / Install Smoke

- [ ] App bundle built successfully (or dev mode confirmed working)
- [ ] App launches without generic error banner on first launch
- [ ] Fresh launch shows Not installed or Current status, not path-chooser UI
- [ ] Workspace displays canonical path `~/.config/agent-workspace`
- [ ] Toolbar icons stay on the same compact row as macOS traffic lights
- [ ] Error/info banner renders below the toolbar
- [ ] Window drags from the header band; toolbar buttons remain clickable
- [ ] Start view scrolls when content exceeds window height
- [ ] Product title "Agent Workspace" visible

## 3. Workspace Install Smoke

- [ ] With no prior install, status is Not installed and **Install** is offered
- [ ] **Install** creates the isolated runtime workspace with `.agent-workspace/workspace.json` and bundled files
- [ ] A second run reports Current and performs no mutation
- [ ] Modified historical and unknown files are preserved as conflicts
- [ ] **open folder** opens the installed directory
- [ ] **refresh** updates diagnostics
- [ ] No choose-folder, check-path, use-default, or clear-active controls
- [ ] Idle terminal shows operations ready; hints mention diff/sync, not pull

## 4. Harness and Library Smoke

- [ ] Codex, OpenCode, Cursor, Claude nav icons load harness pages
- [ ] Workspace and each harness page show exactly one managed installation card
- [ ] No repair, Setup Lifecycle, duplicate skills install, or per-surface mutation controls appear
- [ ] Library: Docs, Rules, Skills, Agents, Configs, Brain Setup switch correctly
- [ ] Library → Docs: document selection, Preview, Edit, modified state, save, reset, open, create form, stale bundled-doc warning, Markdown table, fenced code, code copy
- [ ] Brain Setup copy block works
- [ ] Settings: appearance, all four text sizes (`small`, `medium`, `large`, `extra large`), and theme colors save and reset
- [ ] Extra-large text size at minimum supported window width

## 4b. Prompt Loops and Repo Dashboard Smoke

- [ ] Header exposes dedicated **Prompt Loops** and **Repo Dashboard** icons after Library and before Settings
- [ ] No **Tools** icon or intermediate Tools page exists
- [ ] Prompt Loops and Repo Dashboard sidebars have no tool switcher buttons
- [ ] No Prompt Loops shortcut hint block (1–4 / / / ↑↓) in the sidebar
- [ ] No Repo Dashboard sidebar `gh: enhanced` or `gh: local-only` status line
- [ ] Prompt Loops keyboard shortcuts still work outside editable controls
- [ ] **Use as context** from an eligible Repo Dashboard item switches to Prompt Loops with safe task context
- [ ] Repo Dashboard refresh on a repository with more than 500 locally available commits loads complete reachable history (not a hard 500-cap)

## 5. Sync / Install Smoke (Caution)

Dry-runs only unless testing your own machine:

- [ ] `scripts/install-agent-rules.sh --quiet --diff` from installed workspace
- [ ] `scripts/install-opencode-config.sh --quiet --diff`
- [ ] `scripts/install-skills.sh --quiet --dry-run --global` for selected agents
- [ ] Do not run `--apply` on someone else's machine without intent
- [ ] Apply creates backups under `~/Library/Application Support/ai.agentworkspace.app/backups`

## 6. Verify and Terminal Smoke

- [ ] **release-check** on Workspace VERIFY when script exists in workspace
- [ ] Terminal shows action label, OK/FAILED, exit code after a safe dry-run
- [ ] Output does not leak secrets or private paths from fixtures

## 7. Keyboard and Lazy Views

- [ ] Tab through nav — focus rings visible
- [ ] Library and Settings lazy-load with brief fallback
- [ ] Escape dismisses error banner

## 8. Known Limitations

- Workspace marker is `.agent-workspace/workspace.json` inside the install directory
- Install path is `~/.config/agent-workspace` (not a dot-prefixed `.agent-workspace` config folder)
- `AGENT_WORKSPACE_PATH` and backup-root overrides are development/test isolation controls only
- Import/upgrade from arbitrary folders is not supported in normal UI
- Uninstall recovery is session-scoped: the **Recover previous uninstall** card is not rediscovered automatically after app restart, even when backend transaction evidence remains on disk

## 9. Pass / Fail Report Template

```
## Agent Workspace App Smoke Report

- Commit: ________
- Build command: ________
- Machine: ________
- App version: ________
- App bundle path: ________ (or "dev mode")

### Automated release-check
- [ ] `./scripts/release-check.sh` passed
- Notes: ________

### Build / install
- [ ] Preflight and build/install checks passed
- Notes: ________

### Codex migration
- [ ] Codex 0.134+ managed-field and legacy migration checks passed
- Notes: ________

### Uninstall / recovery
- [ ] Isolated uninstall, recovery preview, confirmation, and conflict checks passed
- Notes: ________

### Settings / accessibility
- [ ] Installed State Map, Reduce Motion, landing page, appearance reset, and text-size checks passed
- Notes: ________

### Harness / library / tools
- [ ] Harness, Library, Prompt Loops, and Repo Dashboard checks passed
- Notes: ________

### Skipped checks and residual risk
- Skipped: ________
- Residual risk: ________

### Release Decision
- [ ] Ready to share
- [ ] Not ready
```
