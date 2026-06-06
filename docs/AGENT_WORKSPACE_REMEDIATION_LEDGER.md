# Agent Workspace Remediation Ledger

Active remediation source of truth. Audit input: `agent-workspace-deep-audit-2026-06-06.md`.

## Session

| Field | Value |
|---|---|
| Audited commit | `53d9d2b245a41caddff3cc4961e335166ded85b4` |
| Prior remediation HEAD | `07cb1b1cd08e4f5261cf9746cbaa5d649efbaeea` |
| Follow-up pass start HEAD | `07cb1b1cd08e4f5261cf9746cbaa5d649efbaeea` |
| Correctness closure start HEAD | `0a1f69cd555f350b79e11d8cabf5fda881c9a452` |
| Implementation HEAD (verified) | `4f9bbc03967f432d7464bfd3f12f427fded64336` |
| Remote HEAD | Obtain from Git: `git rev-parse origin/main` (do not embed the evidence commit SHA here) |
| Branch | `main` |
| Verdict | **READY FOR MANUAL WEBVIEW SMOKE** — automated gates pass; native webview smoke BLOCKED in agent environment |

## Baseline (pre-edit, correctness closure)

| Gate | Result |
|---|---|
| `npm test` | pass (25 tests) |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `cargo fmt/check/clippy/test` | pass (371 tests) |
| `./scripts/release-check.sh` | pass |
| `bash ./scripts/check-ui-regressions.sh` | pass |
| `git diff --check` | pass |

## Finding status

| ID | Severity | Status | Notes |
|---|---|---|---|
| AW-CFG-001 | P1 | completed | Single OpenCode read path; draft identity + load-seq guards |
| AW-ASYNC-001 | P1 | completed | Resource ID + monotonic save-operation tokens on doc/agent/config saves |
| AW-SET-001 | P1 | completed | `mutateAppSettings` in `useAppSettingsController`; Tools uses canonical path |
| AW-SET-002 | P1 | completed | `SETTINGS_WRITE_MUTEX` single-owner recovery; read-only `load()`; corrupt backup; Rust regression tests |
| AW-TOOLS-001 | P2 | completed | `savedRepoEntriesFromSettings` view adapter; no separate backend snapshot |
| AW-PL-001 | P2 | completed | `isEditableEventTarget` |
| AW-TEST-001 | P2 | completed | Vitest + RTL; 30 tests; `npm test` in release-check |
| AW-PROC-001 | P2 | completed | `run_cmd_bounded` with caps + timeout polling |
| AW-RD-001 | P1 | superseded | Product requirement changed after audit: load every locally available commit through bounded 500-record pages, not a 500-record total cap |
| AW-RD-002 | P1 | completed | Bounded capture in process runner for repo git |
| AW-RD-003 | P1 | completed | UTF-8 byte truncation; doc listing warning |
| AW-RD-004 | P2 | completed | NUL-delimited name-status parsing |
| AW-RD-005 | P2 | completed | Noninteractive git env + 60s fetch timeout |
| AW-RD-006 | P3 | completed | 60s sync clock tick while snapshot exists |
| AW-RD-008 | P3 | completed | Component-based path validation |
| AW-TIMER-001 | P3 | completed | `useTransientStatus` with unmount cleanup |
| AW-MD-001 | P2 | completed | `SafeMarkdown` single-`pre` fenced blocks + component tests |
| AW-FONT-001 | P2 | completed | Removed `#root` zoom; font size via `--app-font-size` tokens |
| AW-DEAD-001 | P3 | completed | Removed unreachable `save_config_template` fallback |
| AW-DEAD-002 | P3 | completed | Removed unused workspace contract load/state |
| AW-LOAD-001 | P3 | completed | Removed duplicate `fetchStatus` + startup `loadBrainSetupSeed` |
| AW-DOC-001 | P3 | completed | Historical labels on prior audit docs |
| AW-REL-002 | P3 | completed | Codex apply log + UI regressions script use mktemp + trap |
| AW-REL-001 | P3 | completed | Extracted `frontend-gate.sh` + `rust-gate.sh`; release-check delegates (not fully modularized) |
| AW-ARCH-001 | P2 | completed | `useLibraryController` + prior extractions |
| AW-RD-007 | P3 | deferred | N+1 git show retained; optimize only if measured |
| AW-TYPES-001 | P3 | deferred | Contract fixture tests via Vitest; no generated bindings |
| AW-CONFIG-001 | Decision | blocked | Bundle id `.app` migration needs operator plan |
| AW-CONFIG-002 | Decision | blocked | Schema URL needs official Tauri 2 verification |

## Verification (cumulative, correctness closure)

| Gate | Result |
|---|---|
| `npm test` | pass (30) |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `cargo fmt --check` | pass |
| `cargo check` | pass |
| `cargo clippy -D warnings` | pass |
| `cargo test` | pass (375 unit + 1 runtime smoke in release-check) |
| `./scripts/release-check.sh` | pass |
| `bash ./scripts/check-ui-regressions.sh` | pass |
| `./scripts/smoke-tauri-runtime.sh` | pass (backend IPC only) |
| `git diff --check` | pass |
| Native Tauri webview smoke (`docs/APP_RELEASE_SMOKE.md`) | **BLOCKED** — no macOS Tauri webview automation in agent environment |

## Post-audit product change: complete commit history

The previous 500-record total cap was intentionally removed after operator review. Repo Dashboard now reloads the full commit history available in the local checkout using bounded 500-record `git log` pages against a frozen `HEAD`. Each subprocess keeps timeout and output limits. A shallow clone is reported as incomplete because commits absent from the local object database cannot be displayed.

This post-audit change was written directly through the GitHub connector. It requires local Rust formatting, check, Clippy, tests, release-check, and manual Repo Dashboard smoke before the audit can be marked fully closed.

## Native webview smoke (manual checklist)

Operator must run before sharing builds:

- [ ] App launch; Start and Workspace health
- [ ] Library document, agent, and OpenCode config source switching
- [ ] Save and dirty-state behavior after fast selection changes
- [ ] Repo Dashboard repository save/import then immediate theme or target change
- [ ] Prompt Loops repository list refresh
- [ ] Fenced code blocks and copy controls
- [ ] Small, medium, and large font settings
- [ ] Repo Dashboard refresh loads the complete locally available commit history, including repositories with more than 500 commits
- [ ] No console errors; no credential-bearing output

## Deferred / blocked (no further autonomous work)

| ID | Action needed |
|---|---|
| AW-CONFIG-001 | Operator plan for bundle id `.app` migration |
| AW-CONFIG-002 | Verify Tauri 2 schema URL against official docs |
| AW-RD-007 | Optimize N+1 `git show` only if measured in production |
| AW-TYPES-001 | Generated TS bindings — optional future work |
| Webview smoke | Operator runs `docs/APP_RELEASE_SMOKE.md` |

## Commit log (correctness closure)

Chronological order from `3e5a78cf` through implementation HEAD `4f9bbc03`. The docs commit `0a1f69cd` also contained minor verification-driven code cleanup.

```
07cb1b1c docs(audit): finalize remediation ledger at ARCH completion
04d5d24d fix(settings): unify repo mutations through app settings controller
c57329db fix(settings): lock read-modify-write and recover corrupt settings safely
54229d88 fix(library): bind save completion to editor operation identity
41fb2b20 fix(markdown): render fenced code through react-markdown pre boundary
0a1f69cd docs(audit): record follow-up remediation evidence and gate results
a812d496 fix(settings): serialize recovery under SETTINGS_WRITE_MUTEX
9b1de77d fix(settings): preserve corrupt-file recovery warning in UI
604436c3 fix(library): make save-operation tokens monotonic and checkable
4f9bbc03 fix(settings): satisfy clippy in concurrent recovery test
```

After push, confirm remote alignment with `git rev-parse origin/main`.
