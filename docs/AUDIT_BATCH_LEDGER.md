# Audit batch ledger (2026-05-25)

Baseline: `main` @ `b4de47456bc8fcf35c7adeda5491e0d448440fcd`, clean tree, synced with `origin/main`.

## Inventory

| ID | Sev | Status | Evidence | Fix (batch) |
|----|-----|--------|----------|-------------|
| DOC-001 | P1 | fixed | README Workspace startup claims skills UI on Start; skills live on harness pages | 2 |
| DOC-002 | P1 | fixed | README/WORKFLOWS/TROUBLESHOOTING say Save in Settings; app autosaves targets | 2 |
| DOC-003 | P2 | fixed | User docs omit **update resources** (StartView has separate action) | 2 |
| DOC-004 | P2 | fixed | USING_THE_APP cites `ux-context` for prompt templates | 2 |
| DOC-005 | P2 | fixed | WORKSPACE_CONTRACT implies app project Cursor rules | 2 |
| DOC-006 | P2 | follow-up | README claims bundled resource preview; no UI invoke | — |
| DOC-007 | P3 | fixed | Nav aria "Start" vs docs "Workspace" | 2 |
| DOC-008 | P3 | fixed | Bundled docs omit Tools (Prompt Loops, Repo Dashboard) | 2 |
| DOC-009 | P3 | follow-up | WORKSPACE_CONTRACT transition/private-repo note | — |
| AW-BACK-001 | P1 | fixed | `missing_bundled_file_paths` uses `is_file()` only; empty files skipped by repair | 3 |
| AW-BACK-004 | P2 | fixed | `install-codex-config.sh --diff` silent when synced | 5 |
| AW-BACK-005 | P3 | fixed | Unconfigured diagnostics report bundled `current` | 11 |
| AW-BACK-006 | P3 | fixed | `window.maximize()?` can fail setup | 11 |
| AW-BACK-002 | P2 | blocked | `open` macOS-only; needs product decision for Linux/Windows | — |
| AW-BACK-003 | P2 | blocked | Settings/backups under `~/Library/...` on all OS | — |
| RD-RESP-NAV | P1 | fixed | Sidebar hidden ≤1100px with no section control | 7 |
| RD-WORKSPACE-SCROLL | P2 | fixed | `.repo-dashboard-workspace { overflow: auto }` nested scroll | 7 |
| RD-HEAT-COMPACT-ONLY | P2 | fixed | Overview heatmap always `compact` density | 7 |
| RD-HEAT-LABEL | P3 | fixed | "Activity heatmap" vs "Commit heatmap" | 7 |
| PL-RESP-NAV | P2 | fixed | Prompt sidebar hidden ≤900px | 6 |
| LIB-BRAIN-TRIPLE | P3 | fixed | Triple "Brain Setup" heading | 8 |
| LIB-AGENTS-LABEL | P3 | fixed | Rail vs empty-state label mismatch | 8 |
| FONT-ZOOM-SIDEFX | P2 | follow-up | `#root { zoom }` + fixed px; broader typography pass | — |

## Commit ledger

| # | SHA | Message | Issues |
|---|-----|---------|--------|
| 1 | 35d2bdc6 | docs(audit): add batch audit ledger for 2026-05-25 | ledger |
| 2 | 66e9f6d7 | docs: align README and bundled docs with current app behavior | DOC-001–008,007 |
| 3 | 94685872 | fix(workspace): treat zero-byte bundled files as missing | AW-BACK-001, AW-BACK-005 |
| 4 | 6f80216b | fix(codex): print synced line when config diff has no changes | AW-BACK-004 |
| 5 | 85b58c51 | fix(repo-dashboard): narrow section nav, heatmap density, scroll | RD-* |
| 6 | a187e459 | fix(prompt-loops): add narrow-layout group selector | PL-RESP-NAV |
| 7 | 4b69bb84 | fix(library): reduce duplicate Brain Setup labels | LIB-* |
| 8 | cb57529f | fix(tauri): do not fail startup when maximize is unsupported | AW-BACK-006 |
| 9 | 3654025d | chore(release-check): guard UI and bundled-file regressions | guards |

Baseline `b4de47456` → end `3654025d` (9 commits).

## Verification (end of batch)

- [x] `npm run typecheck` — pass
- [x] `npm run build` — pass
- [x] `cargo fmt --check` — pass
- [x] `cargo check` — pass
- [x] `cargo clippy --all-targets -- -D warnings` — pass
- [x] `cargo test` — 339 passed
- [x] `./scripts/release-check.sh` — pass
- [x] `git diff --check` — pass
