# Release Hardening Audit

**Starting commit:** `9a96ec5085212895ff05d33b397e62b2d76a41de`  
**Date:** 2026-05-09  
**Verdict:** PASS WITH FINDINGS

## Changes Made

- Tightened backend workspace script execution/open paths so fixed workspace scripts must canonicalize inside the validated workspace before `bash` or `open` receives them.
- Fixed `scripts/release-size-report.sh` so missing `.app` executables are informational, matching the script contract.
- Added a release-check guard for the OpenCode `qwen3.6-plus` config shape:
  - `limit.context = 1000000`
  - `limit.output = 65536`
  - no `contextWindow`
- Removed stale root `AUDIT_REPORT.md`; it contained an obsolete HOLD verdict and removed routing-profile references.
- Fixed the duplicate numbering in `docs/APP_RELEASE_SMOKE.md`.

## Findings Fixed

### Medium

- Workspace script symlink escape: action and skill script entry points used fixed workspace-relative names but did not canonicalize the final script path before execution/open. A symlinked script could point outside the workspace. Fixed by reusing canonical containment checks and adding a targeted symlink-escape regression test.

### Low

- Size report false failure: `set -euo pipefail` made the report exit non-zero when no executable was found in an existing `.app` bundle. Fixed with an explicit non-fatal lookup.
- Stale release audit artifact: root `AUDIT_REPORT.md` contradicted the current release state and referenced removed routing-profile bloat. Removed.
- Smoke checklist numbering drift: fixed duplicate section numbering.
- Qwen config guard missing from release-check: added a cheap JSON assertion to prevent regressing back to `contextWindow` or wrong limits.

## Findings Deferred

- App signing/notarization: ad-hoc/local macOS bundle expectations remain a release distribution risk. Defer public release until signing/notarization is decided.
- Dependency major updates: `@vitejs/plugin-react`, `typescript`, and `vite` have newer majors. No security advisories were reported for production npm dependencies; defer major upgrades outside this RC hardening pass.
- Cargo dry-run shows `hashbrown 0.17.0 -> 0.17.1` available through transitive dependencies. No lockfile churn made for this RC.
- Manual installed-app GUI smoke was not completed in this pass; run `docs/APP_RELEASE_SMOKE.md` before sharing the bundle.

## Security Review Summary

- Backend command execution remains allowlisted by action IDs and fixed program names; no frontend-controlled executable path or shell string execution was added.
- Workspace script paths now canonicalize under the workspace root before execution/open.
- File writes reviewed in docs/rules/agents/config paths retain size limits and workspace containment checks.
- Backup list/detail/open behavior remains app-level and does not expose file contents or textual diffs.
- Terminal output redaction remains applied at the render boundary in `TerminalOutput`.
- Tauri capabilities remain minimal: `core:default` and `dialog:allow-open`.
- Bundled resources were checked for stale app naming, private names, stale routing-profile references, and Qwen config drift.

## Deprecated / Dead Code Cleanup

- Removed the stale root audit report.
- Routing-profile bloat search now only reports the release-check guard itself.
- No debug logs, `debugger`, `alert`, or no-op click controls were found in `src`.

## UI / UX / Accessibility Summary

- Code inspection confirmed labelled top nav icon buttons, labelled search clear buttons, `role="alert"` on the error banner, semantic disabled buttons, and visible focus-visible styling.
- Smoke checklist now retains lazy-loaded view and keyboard navigation checks with correct numbering.
- No UI redesign or new product surface was introduced.

## Dependency / Config Summary

- `npm audit --omit=dev`: 0 vulnerabilities.
- `npm outdated`: newer majors exist for `@vitejs/plugin-react`, `typescript`, and `vite`; no RC upgrade taken.
- `cargo tree -d`: duplicate transitive crates are present through Tauri dependency graph; no direct dependency action recommended.
- `cargo update --dry-run`: one compatible transitive update available (`hashbrown`); no lockfile churn taken.
- `package-lock.json` matches `package.json` by dry-run lockfile check.
- OpenCode `qwen3.6-plus` config has expected `limit.context`, `limit.output`, and no `contextWindow`.

## Verification Evidence

Baseline before changes:

- `npm run build`: PASS
- `cargo fmt --check`: PASS
- `cargo check`: PASS
- `cargo clippy --all-targets --all-features -- -D warnings`: PASS
- `cargo test`: PASS, 206 tests
- `./scripts/release-check.sh`: PASS
- `./scripts/release-size-report.sh`: FAIL, fixed in this pass

After fixes:

- `cargo test workspace_script_arg`: PASS, 2 tests
- `./scripts/release-size-report.sh`: PASS
- `npm run build`: PASS
- `cargo fmt --check`: PASS
- `cargo check`: PASS
- `cargo clippy --all-targets --all-features -- -D warnings`: PASS
- `cargo test`: PASS, 208 tests
- `./scripts/release-check.sh`: PASS

## Manual Smoke Evidence

Not completed in an installed app during this pass. The release smoke checklist is current and should be executed before distributing a built `.app`/DMG.

## Remaining Release Risks

- Public distribution still needs a signing/notarization decision.
- Installed-app GUI smoke remains required.
- Existing release bundles under `src-tauri/target/` are build artifacts and were not rebuilt as part of this audit.

## Recommendation

Rebuild the RC after final gates pass. Defer broad public release until signing/notarization is handled; sharing a local/test RC is acceptable after the manual smoke checklist passes.
