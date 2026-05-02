# App Release Smoke

Manual smoke checklist for Agent Workspace app builds. Complements `scripts/release-check.sh` (automated syntax, bundled-default checks, forbidden-source scans, app build, Cargo checks). `scripts/release-check.sh` does not test GUI behavior, installed-app bundles, workspace creation, or folder picker interactions.

Run this checklist before sharing a built app bundle with another user.

## 1. Preflight

- [ ] `git status --short` is clean (no uncommitted changes)
- [ ] `./scripts/release-check.sh` passes
- [ ] `cd apps/ux-workspace-app && npm run tauri build` succeeds (skip if environment cannot produce macOS bundles)
- [ ] No secrets, private keys, names, or credential-bearing data in `apps/ux-workspace-app/resources/default-workspace/`
- [ ] Current branch and commit noted for the pass/fail report

## 2. Build / Install Smoke

- [ ] App bundle was built successfully (or dev mode confirmed working)
- [ ] App launches without generic error banner
- [ ] Product-facing title "Agent Workspace" is visible (window title, or branding)
- [ ] Bundled default workspace preview appears in Settings (not only in dev source checkout)

## 3. Workspace Setup Smoke

Folder picker and workspace path:

- [ ] Click "choose folder" in Settings — native folder dialog opens
- [ ] Select a folder — draft path updates (not saved yet)
- [ ] Cancel the picker — path remains unchanged
- [ ] Type a path manually — draft updates
- [ ] Save — path persists across view changes and app restart
- [ ] Empty/cleared path falls back to env var or built-in default
- [ ] Invalid workspace path shows missing markers and "invalid workspace"
- [ ] Health view workspace panel shows diagnostics matching Settings
- [ ] Health refresh updates diagnostics

## 4. Create Workspace Smoke

Use a safe throwaway folder, e.g. `~/Desktop/agent-workspace-smoke-test`.

- [ ] Type or choose a missing/empty target path
- [ ] Click "dry-run create"
- [ ] Plan status is `missing_directory` or `empty_existing_directory`
- [ ] "create workspace" button appears (only for safe statuses)
- [ ] Click "create workspace"
- [ ] Confirm created files:
  - [ ] `.ux-workspace/workspace.json`
  - [ ] `README.md`
  - [ ] `docs/`
  - [ ] `templates/`
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

## 5. Docs and Default Workspace Smoke

- [ ] Docs view shows curated workspace docs grouped by section (Start, Reference, Operating Model, Private / Operator, Development)
- [ ] Selecting a doc renders its Markdown content
- [ ] "open" button opens the doc in the system editor
- [ ] Bundled starter preview in Settings shows known categories and file paths
- [ ] Bundled starter preview shows non-empty Skills category
- [ ] Bundled default resources contain no private names, secrets, or core-skill-subset language
- [ ] Workspace docs are separate from templates/config views (Agents, Configs)

## 6. Sync / Install Smoke (Caution)

Dry-runs only unless testing your own machine:

- [ ] In a created or selected workspace, `scripts/install-agent-rules.sh --quiet --diff --opencode --codex --auggie` reports synced/diverged
- [ ] In a created or selected workspace, `scripts/install-opencode-config.sh --quiet --diff` reports synced/diverged
- [ ] In a created or selected workspace, `scripts/install-skills.sh --quiet --dry-run --agent opencode --global` reports planned counts
- [ ] install-skills dry-run from a created workspace reports the bundled skills
- [ ] In a created or selected workspace, `scripts/bootstrap.sh --quiet --diff --skip-skills --codex --opencode --auggie` completes without error
- [ ] Do not run `--apply` actions when testing someone else's machine
- [ ] Backups exist under `~/Library/Application Support/ai.openworkspace.ux-workspace/backups` before real sync if applicable

## 7. Known Limitations

- Internal repo/package names still use `ux-workspace` during transition (marker directory, workspace_type, app source directory)
- Workspace marker naming is still `.ux-workspace/workspace.json`
- Create flow has no rollback on rare I/O/race failure after preflight
- Import/upgrade flow is not implemented
- First public/share build should be tested as an installed `.app` bundle, not only dev mode
- `create_workspace_from_defaults` copies files only — no dependency install, no git init, no post-create hook
- Workspace scripts in the created workspace are copies of the bundled defaults and may not match the repo originals after bundles are updated
- Clean git status should be confirmed — residual dev artifacts in `dist/` or `target/` could be bundled unintentionally

## 8. Pass / Fail Report Template

Copy this template and fill in results.

```
## Agent Workspace App Smoke Report

- Commit: ________
- Build command: ________
- Machine: ________
- App version: ________
- App bundle path: ________ (or "dev mode")

### Checks Passed
- [ ] Preflight (clean git, release-check, build)
- [ ] Build/install (launch, no error banner, product name, bundled preview)
- [ ] Workspace setup (folder picker, save, diagnostics)
- [ ] Create workspace (dry-run, create, files, validation, no-overwrite, no-execute, rejection of unsafe targets)
- [ ] Docs and defaults (curated docs, bundled preview, no private names)
- [ ] Sync dry-runs (rules diff, config diff, skills dry-run, bootstrap diff)

### Checks Failed
- ________

### Notes
- ________

### Release Decision
- [ ] Ready to share
- [ ] Not ready — needs fixes
```
