# Agent Workspace Remediation Ledger

Active remediation source of truth. Audit input: `agent-workspace-deep-audit-2026-06-06.md`.

## Session

| Field | Value |
|---|---|
| Audited commit | `53d9d2b245a41caddff3cc4961e335166ded85b4` |
| Prior remediation HEAD | `07cb1b1cd08e4f5261cf9746cbaa5d649efbaeea` |
| Follow-up pass start HEAD | `07cb1b1cd08e4f5261cf9746cbaa5d649efbaeea` |
| Ending HEAD | `a6aa703f94b6ff8639df6c3545f2819efaefb1ec` |
| Branch | `main` |
| Verdict | **READY** — automated gates pass; native webview smoke BLOCKED in agent environment |

## Baseline (pre-edit, follow-up pass)

| Gate | Result |
|---|---|
| `npm test` | pass (10 tests) |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `cargo fmt/check/clippy/test` | pass (366 tests) |
| `./scripts/release-check.sh` | pass |
| `bash ./scripts/check-ui-regressions.sh` | pass |
| `git diff --check` | pass |

## Finding status

| ID | Severity | Status | Notes |
|---|---|---|---|
| AW-CFG-001 | P1 | completed | Single OpenCode read path; draft identity + load-seq guards |
| AW-ASYNC-001 | P1 | completed | Resource ID + save-operation identity on doc/agent/config saves |
| AW-SET-001 | P1 | completed | `mutateAppSettings` in `useAppSettingsController`; Tools uses canonical path |
| AW-SET-002 | P1 | completed | `mutate_settings` / `mutate_settings_locked` under mutex; corrupt JSON recovery |
| AW-TOOLS-001 | P2 | completed | `savedRepoEntriesFromSettings` view adapter; no separate backend snapshot |
| AW-PL-001 | P2 | completed | `isEditableEventTarget` |
| AW-TEST-001 | P2 | completed | Vitest + RTL; 25 tests; `npm test` in release-check |
| AW-PROC-001 | P2 | completed | `run_cmd_bounded` with caps + timeout polling |
| AW-RD-001 | P1 | completed | `git log -n 501`, cap 500 |
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

## Verification (cumulative, follow-up pass)

| Gate | Result |
|---|---|
| `npm test` | pass (25) |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `cargo fmt --check` | pass |
| `cargo check` | pass |
| `cargo clippy -D warnings` | pass |
| `cargo test` | pass (371 unit + 1 runtime smoke in release-check) |
| `./scripts/release-check.sh` | pass |
| `bash ./scripts/check-ui-regressions.sh` | pass |
| `./scripts/smoke-tauri-runtime.sh` | pass (backend IPC only) |
| `git diff --check` | pass |
| Native Tauri webview smoke (`docs/APP_RELEASE_SMOKE.md`) | **BLOCKED** — no macOS Tauri webview automation in agent environment |

## Native webview smoke (manual checklist)

Operator must run before sharing builds:

- [ ] App launch; Start and Workspace health
- [ ] Library document, agent, and OpenCode config source switching
- [ ] Save and dirty-state behavior after fast selection changes
- [ ] Repo Dashboard repository save/import then immediate theme or target change
- [ ] Prompt Loops repository list refresh
- [ ] Fenced code blocks and copy controls
- [ ] Small, medium, and large font settings
- [ ] Repo Dashboard refresh
- [ ] No console errors; no credential-bearing output

## Deferred / blocked (no further autonomous work)

| ID | Action needed |
|---|---|
| AW-CONFIG-001 | Operator plan for bundle id `.app` migration |
| AW-CONFIG-002 | Verify Tauri 2 schema URL against official docs |
| AW-RD-007 | Optimize N+1 `git show` only if measured in production |
| AW-TYPES-001 | Generated TS bindings — optional future work |
| Webview smoke | Operator runs `docs/APP_RELEASE_SMOKE.md` |

## Commit log (follow-up correctness pass)

```
41fb2b20 fix(markdown): render fenced code through react-markdown pre boundary
54229d88 fix(library): bind save completion to editor operation identity
c57329db fix(settings): lock read-modify-write and recover corrupt settings safely
04d5d24d fix(settings): unify repo mutations through app settings controller
a6aa703f docs(audit): record follow-up remediation evidence and gate results
```
