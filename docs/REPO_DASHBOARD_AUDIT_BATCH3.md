# Repo Dashboard audit batch 3 (2026-05-25)

Baseline: `main` @ `94359f4a93dadded606f7a9c60dd181b58fdcfa9`, clean tree, synced with `origin/main`.

## Issue inventory

| ID | Sev | Status | Evidence | Affected | Proposed fix | Risk | Verification |
|----|-----|--------|----------|----------|--------------|------|--------------|
| RD-CHART-AUTHOR | P1 | pending | `normalizeAuthor` regex; node probe: Alice/Bob → `other`, chart null | `model.ts` | Top-2 authors by commit count → primary/secondary | low | `check-repo-dashboard-model.ts` |
| RD-RACE-001 | P1 | pending | `refreshFor` has no seq guard; fast path switch can overwrite | `RepoDashboardTool.tsx` | Increment load seq; ignore stale responses | low | unit reasoning + manual |
| RD-PATH-STALE | P1 | pending | Edit path keeps old `snapshot` until refresh | `RepoDashboardTool.tsx` | `pathsEqual(snapshot.repo_path, repoPath)` gate + status | low | UI smoke |
| RD-DOC-SIZE | P1 | pending | `read_local_docs` uncapped; `content.rs` uses 512KB | `repo_dashboard.rs` | Cap doc bytes + warning | low | rust test |
| RD-WORK-CAP | P2 | pending | `WorkItemsList` slices 120 silently | `RepoDashboardTool.tsx` | Truncation copy (activity already has) | low | UI regression grep |
| RD-HEAT-ASIDE | P2 | pending | `.repo-dashboard-heat-aside { overflow: auto }` nested scroll | `styles.css` | `overflow: hidden`; horizontal on heat-scroll only | low | `check-ui-regressions.sh` |
| RD-MERGE-DEDUP | P2 | pending | `mergeWorkItems` concatenates without dedup | `docsParser.ts` | Dedup by source+path+line+text | low | check script |
| RD-WORK-KEY | P3 | pending | React key `${path}-${line ?? text}` can collide | `RepoDashboardTool.tsx` | Include source + stable index fallback | low | lint |
| RD-RC-GUARD | P2 | pending | No release-check for personal author regex / doc cap | scripts | Add guards to release-check + ui-regressions | low | release-check |
| RD-AUTHOR-REGEX | P1 | pending | `hellq\|uxsmedjan` still in model (batch2 UI-only) | `model.ts` | Remove with dynamic map | low | rg in release-check |

## Fix list (this batch)

All rows above except none blocked.

## Commit plan

1. Ledger (this file)
2. Backend doc cap + tests
3. Model dynamic authors + check script
4. Parser dedup + parser checks
5. Tool race/path/work-cap
6. CSS heat-aside scroll
7. Accessibility pass (path status, busy on refresh)
8. Release-check / ui-regression guards
9. Runtime smoke fixups if needed
