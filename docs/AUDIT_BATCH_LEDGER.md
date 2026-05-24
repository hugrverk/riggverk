# Audit batch ledger (2026-05-25)

## Batch 1 (prior)

Baseline: `main` @ `b4de47456bc8fcf35c7adeda5491e0d448440fcd`, clean tree, synced with `origin/main`.

End: `5d68b429` @ verification record after `3654025d`.

### Inventory (batch 1)

| ID | Sev | Status | Evidence | Fix |
|----|-----|--------|----------|-----|
| DOC-001 | P1 | fixed | README Workspace startup claims skills UI on Start | 2 |
| DOC-002 | P1 | fixed | README/WORKFLOWS/TROUBLESHOOTING say Save in Settings | 2 |
| DOC-003 | P2 | fixed | User docs omit update resources | 2 |
| DOC-004 | P2 | fixed | USING_THE_APP cites ux-context for prompt templates | 2 |
| DOC-005 | P2 | fixed | WORKSPACE_CONTRACT implies app project Cursor rules | 2 |
| DOC-006 | P2 | fixed | README claimed bundled resource preview (removed; drift guard) | 2 |
| DOC-007 | P3 | fixed | Nav aria Start vs docs Workspace | 2 |
| DOC-008 | P3 | fixed | Bundled docs omit Tools | 2 |
| DOC-009 | P3 | closed | No transition/private-repo wording remains | — |
| AW-BACK-001 | P1 | fixed | Zero-byte bundled files skipped by repair | 3 |
| AW-BACK-004 | P2 | fixed | Codex config diff silent when synced | 5 |
| AW-BACK-005 | P3 | fixed | Unconfigured diagnostics report bundled current | 3 |
| AW-BACK-006 | P3 | fixed | window.maximize can fail setup | 8 |
| AW-BACK-002 | P2 | blocked | open macOS-only | — |
| AW-BACK-003 | P2 | blocked | Settings/backups under ~/Library on all OS | — |
| RD-RESP-NAV | P1 | fixed | Sidebar hidden ≤1100px without section control | 7 |
| RD-WORKSPACE-SCROLL | P2 | fixed | repo-dashboard-workspace nested scroll | 7 |
| RD-HEAT-COMPACT-ONLY | P2 | fixed | Overview heatmap always compact | 7 |
| RD-HEAT-LABEL | P3 | fixed | Activity vs Commit heatmap label | 7 |
| PL-RESP-NAV | P2 | fixed | Prompt sidebar hidden ≤900px | 6 |
| LIB-BRAIN-TRIPLE | P3 | fixed | Triple Brain Setup heading | 8 |
| LIB-AGENTS-LABEL | P3 | fixed | Rail vs empty-state label mismatch | 8 |
| FONT-ZOOM-SIDEFX | P2 | follow-up | #root zoom + fixed px typography pass | — |

Batch 1 commits: `35d2bdc6` … `3654025d` (9), verify `5d68b429`.

---

## Batch 2 (follow-up audit)

Baseline: `main` @ `5d68b429b7f4452d03a5455863df1275a1c06289`, clean tree, synced with `origin/main`.

### Inventory (batch 2)

| ID | Sev | Status | Evidence | Fix |
|----|-----|--------|----------|-----|
| AW-REPAIR-001 | P1 | fixed | `repair_default_workspace` used `default_installed_workspace_path` while diagnostics use `configured_workspace_path` | workspace |
| AW-DOC-010 | P2 | fixed | WORKSPACE_CONTRACT claimed bundled preview + create dry-run UI | contract doc |
| AW-DEAD-001 | P3 | fixed | `bootstrap_*` run_action arms unused in frontend | actions.rs |
| AW-CSS-001 | P3 | fixed | `.start-trust-note` only in styles.css | styles.css |
| RD-AUTHOR-001 | P2 | fixed | Hardcoded uxsmedjan/PRIVATE chart labels | repo-dashboard |
| RD-DISPLAY-001 | P3 | fixed | Activity list slice(0,120) without copy | repo-dashboard |
| RC-GAP-001 | P3 | fixed | No drift guard for contract/repair path | check-readme-docs-drift |
| AW-BACK-002 | P2 | blocked | open macOS-only | — |
| AW-BACK-003 | P2 | blocked | Settings/backups ~/Library on all OS | — |
| FONT-ZOOM-SIDEFX | P2 | follow-up | #root zoom side effects | — |

### Commit ledger (batch 2)

| # | SHA | Message | Issues |
|---|-----|---------|--------|
| 1 | e66a2ddd | docs(audit): extend ledger for batch 2 follow-up audit | ledger |
| 2 | cecde237 | fix(workspace): align repair path with configured workspace | AW-REPAIR-001 |
| 3 | c0e62567 | docs: align WORKSPACE_CONTRACT with Workspace UI | AW-DOC-010 |
| 4 | b01befba | fix(repo-dashboard): generic author labels and list cap copy | RD-* |
| 5 | 78a151e4 | chore: remove dead bootstrap actions and unused CSS | AW-DEAD-001, AW-CSS-001 |
| 6 | ca9e1db8 | chore(release-check): guard contract and repair path drift | RC-GAP-001 |
| 7 | c7481370 | chore: cargo fmt workspace test imports | fmt |

Baseline `5d68b429` → end `c7481370` (7 commits).

### Verification (batch 2)

- [x] `npm run typecheck` — pass
- [x] `npm run build` — pass
- [x] `cargo fmt --check` — pass
- [x] `cargo check` — pass
- [x] `cargo clippy --all-targets -- -D warnings` — pass
- [x] `cargo test` — 340 passed
- [x] `./scripts/release-check.sh` — pass
- [x] `bash ./scripts/check-ui-regressions.sh` — pass
- [x] `python3 scripts/check-readme-docs-drift.py` — pass
- [x] `npx tsx scripts/check-prompt-loops-templates.ts` — pass
- [x] `git diff --check` — pass
