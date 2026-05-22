# App Release Smoke

Manual smoke checklist for Agent Workspace app builds. Complements `scripts/release-check.sh` (automated syntax, bundled-default checks, forbidden-source scans, app build, Cargo checks). `scripts/release-check.sh` does not test GUI behavior, installed-app bundles, or folder-picker interactions.

## Automated backend runtime smoke

For Tauri IPC-backed status without manual clicking or a live webview:

```bash
./scripts/smoke-tauri-runtime.sh
```

**Covers:** temp `HOME` + `AGENT_WORKSPACE_PATH`, workspace diagnostics, `get_status` sync fields, OpenCode runtime health, Cursor profile health, Brain Setup seed (no bundled private context).

**Does not cover:** Tauri webview routes, `invoke` in a browser, macOS window automation, or real `~/.config/agent-workspace` install/repair. Playwright against `http://localhost:1420` only sees the Vite shell (no Tauri backend).

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
- [ ] Fresh launch shows Workspace install state (MISSING or INSTALLED), not path-chooser UI
- [ ] Workspace displays canonical path `~/.config/agent-workspace`
- [ ] Toolbar icons stay on the same compact row as macOS traffic lights
- [ ] Error/info banner renders below the toolbar
- [ ] Window drags from the header band; toolbar buttons remain clickable
- [ ] Start view scrolls when content exceeds window height
- [ ] Product title "Agent Workspace" visible

## 3. Workspace Install Smoke

- [ ] With no prior install, status is MISSING and **install** is offered
- [ ] **install** creates `~/.config/agent-workspace` with `.agent-workspace/workspace.json` and bundled files
- [ ] **repair** adds missing files only; does not overwrite edited files
- [ ] **open folder** opens the installed directory
- [ ] **refresh** updates diagnostics
- [ ] No choose-folder, check-path, use-default, or clear-active controls
- [ ] Idle terminal shows operations ready; hints mention diff/sync, not pull

## 4. Harness and Library Smoke

- [ ] Codex, OpenCode, Cursor, Claude, Augment nav icons load harness pages
- [ ] Harness pages show diff/sync actions when workspace is valid
- [ ] Skills install UI on harness pages (not Workspace)
- [ ] Library: Docs, Rules, Skills, Agents, Configs, Brain Setup switch correctly
- [ ] Brain Setup copy block works
- [ ] Settings: appearance and theme colors save and reset

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
- `AGENT_WORKSPACE_PATH` overrides path for dev/test only
- Import/upgrade from arbitrary folders is not supported in normal UI

## 9. Pass / Fail Report Template

```
## Agent Workspace App Smoke Report

- Commit: ________
- Build command: ________
- Machine: ________
- App version: ________
- App bundle path: ________ (or "dev mode")

### Checks Passed
- [ ] Preflight
- [ ] Build/install
- [ ] Workspace install/repair
- [ ] Harness + Library + Settings
- [ ] Sync dry-runs
- [ ] Verify + terminal

### Checks Failed
- ________

### Release Decision
- [ ] Ready to share
- [ ] Not ready
```
