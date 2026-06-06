# Agent Workspace Remediation Ledger

Active remediation source of truth. Audit input: `agent-workspace-deep-audit-2026-06-06.md`.

## Session

| Field | Value |
|---|---|
| Audited commit | `53d9d2b245a41caddff3cc4961e335166ded85b4` |
| Starting HEAD | `53d9d2b245a41caddff3cc4961e335166ded85b4` |
| Branch | `main` |
| Verdict | **READY FOR MERGE CHECK** (pending native smoke) |

## Baseline (pre-edit)

| Gate | Result |
|---|---|
| `npm ci`, typecheck, build | pass |
| `cargo fmt/check/clippy/test` | pass (360 → 367 tests after remediation) |
| `./scripts/release-check.sh` | fail pre-fix (chart CSS contract) → **pass** post-fix |
| `check-ui-regressions.sh` | pass post-fix |
| `npm test` | pass (10 tests) |

## Finding status

| ID | Severity | Status | Notes |
|---|---|---|---|
| AW-CFG-001 | P1 | completed | Single OpenCode read path; draft identity + load-seq guards |
| AW-ASYNC-001 | P1 | completed | Resource ID checks on doc/agent/skill/config reads |
| AW-SET-001 | P1 | completed | Revision CAS + `commitAppSettingsMutation` + shared tools controller |
| AW-SET-002 | P1 | completed | Mutex + atomic temp/rename/sync writes |
| AW-ASYNC-001 | P1 | completed | (see above) |
| AW-TOOLS-001 | P2 | completed | `useSavedRepoEntriesController` in ToolsView |
| AW-PL-001 | P2 | completed | `isEditableEventTarget` |
| AW-TEST-001 | P2 | completed | Vitest + RTL; `npm test` in release-check |
| AW-PROC-001 | P2 | completed | `run_cmd_bounded` with caps + timeout polling |
| AW-RD-001 | P1 | completed | `git log -n 501`, cap 500 |
| AW-RD-002 | P1 | completed | Bounded capture in process runner for repo git |
| AW-RD-003 | P1 | completed | UTF-8 byte truncation; doc listing warning |
| AW-RD-004 | P2 | completed | NUL-delimited name-status parsing |
| AW-RD-005 | P2 | completed | Noninteractive git env + 60s fetch timeout |
| AW-RD-006 | P3 | completed | 60s sync clock tick while snapshot exists |
| AW-RD-008 | P3 | completed | Component-based path validation |
| AW-TIMER-001 | P3 | completed | `useTransientStatus` with unmount cleanup |
| AW-MD-001 | P2 | completed | Shared `SafeMarkdown` (react-markdown + GFM) |
| AW-FONT-001 | P2 | completed | Removed `#root` zoom; font size via `--app-font-size` tokens |
| AW-DEAD-001 | P3 | completed | Removed unreachable `save_config_template` fallback |
| AW-DEAD-002 | P3 | completed | Removed unused workspace contract load/state |
| AW-LOAD-001 | P3 | completed | Removed duplicate `fetchStatus` + startup `loadBrainSetupSeed` |
| AW-DOC-001 | P3 | completed | Historical labels on prior audit docs |
| AW-REL-002 | P3 | partial | Codex apply log uses mktemp dir + trap |
| AW-REL-001 | P3 | partial | `scripts/release-check/frontend-gate.sh` extracted |
| AW-ARCH-001 | P2 | partial | Extracted shared hooks (`useSavedRepoEntriesController`, `useTransientStatus`, `appSettingsMutation`, `useResourceRequestGuard`); `App.tsx` still large |
| AW-RD-007 | P3 | deferred | N+1 git show retained; optimize only if measured |
| AW-TYPES-001 | P3 | deferred | Contract fixture tests added via Vitest; no generated bindings |
| AW-CONFIG-001 | Decision | blocked | Bundle id `.app` migration needs operator plan |
| AW-CONFIG-002 | Decision | blocked | Schema URL needs official Tauri 2 verification |

## Verification (cumulative)

- `npm test` — pass (10)
- `npm run typecheck` — pass
- `npm run build` — pass
- `cargo test` — pass (367)
- `cargo clippy -D warnings` — pass
- `./scripts/release-check.sh` — pass
- `bash ./scripts/check-ui-regressions.sh` — pass
- `git diff --check` — pass
- Native Tauri smoke — **not run** (manual)
