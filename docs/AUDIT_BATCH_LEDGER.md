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

| # | Message | Issues |
|---|---------|--------|
| 1 | (pending) | ledger |
| 2+ | (pending) | per batch above |

## Verification (end of batch)

- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `cargo fmt --check` / `cargo check` / `cargo clippy` / `cargo test`
- [ ] `./scripts/release-check.sh`
