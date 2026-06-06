# Agent Workspace Remediation Ledger

Active remediation source of truth. Audit input: `agent-workspace-deep-audit-2026-06-06.md`.

## Session

| Field | Value |
|---|---|
| Audited commit | `53d9d2b245a41caddff3cc4961e335166ded85b4` |
| Starting HEAD | `53d9d2b245a41caddff3cc4961e335166ded85b4` |
| Ending HEAD | `3e5a78cf4c95bdefe3d55419910d53c88cb55bf1` |
| Commits | 16 on `main` (unpushed) |
| Branch | `main` |
| Verdict | **READY FOR MERGE** — automated gates pass; manual webview smoke optional before share |

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
| AW-REL-002 | P3 | completed | Codex apply log + UI regressions script use mktemp + trap |
| AW-REL-001 | P3 | completed | `frontend-gate.sh` + `rust-gate.sh`; release-check delegates to both |
| AW-ARCH-001 | P2 | completed | `useLibraryController` + prior extractions; App.tsx ~820 lines (was ~1852) |
| AW-RD-007 | P3 | deferred | N+1 git show retained; optimize only if measured |
| AW-TYPES-001 | P3 | deferred | Contract fixture tests added via Vitest; no generated bindings |
| AW-CONFIG-001 | Decision | blocked | Bundle id `.app` migration needs operator plan |
| AW-CONFIG-002 | Decision | blocked | Schema URL needs official Tauri 2 verification |

## Verification (cumulative)

- `npm test` — pass (10)
- `npm run typecheck` — pass
- `npm run build` — pass
- `cargo test` — pass (366 unit + 1 runtime smoke in release-check)
- `cargo clippy -D warnings` — pass
- `./scripts/release-check.sh` — pass
- `bash ./scripts/check-ui-regressions.sh` — pass
- `git diff --check` — pass
- `./scripts/smoke-tauri-runtime.sh` — pass (backend IPC; fixed cursor profile apply + MCP path env)
- `./scripts/release-check.sh` (post-ARCH) — pass (2026-06-06)
- Native Tauri webview smoke — **not run** (manual per `docs/APP_RELEASE_SMOKE.md`)

## Deferred / blocked (no further autonomous work)

| ID | Action needed |
|---|---|
| AW-CONFIG-001 | Operator plan for bundle id `.app` migration |
| AW-CONFIG-002 | Verify Tauri 2 schema URL against official docs |
| AW-RD-007 | Optimize N+1 `git show` only if measured in production |
| AW-TYPES-001 | Generated TS bindings — optional future work |
| Webview smoke | Operator runs `docs/APP_RELEASE_SMOKE.md` before sharing builds |

## Commit log (remediation)

```
3e5a78cf refactor(app): extract library controller from App shell
2d2a9fde fix(smoke): align cursor profile runtime smoke with health checks
df76d649 refactor(app): extract workspace health controller
068a36a6 chore(release): wire rust gate and mktemp UI regression checks
327b4abe refactor(app): extract settings controller and header nav
de5536b1 docs(audit): add remediation ledger and mark historical reports
… (+10 earlier remediation commits)
```
