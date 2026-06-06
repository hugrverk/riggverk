# Repo Dashboard

Repo Dashboard reads a local git checkout and surfaces git activity, documentation, and active work.

## Docs

Docs lists every readable Markdown document discovered in the repository snapshot. Canonical documents show a compact role label (Guide, Active work, Current state, Limitations, Roadmap, Audit, Open questions, Reference) and sort before general reference documents when no search filter is active.

## Work

Work shows **canonical active queues** and **open GitHub issues** only.

When a repository declares a Kretsverket-style canon (`docs/BACKLOG.md` as the active work queue, typically referenced from `docs/START_HERE.md`):

- `docs/BACKLOG.md` — Bugs, Verify, and Enhancements tables
- `docs/audit/ISSUES.md` — active audit findings
- Open GitHub issues (via `gh`)

These sources do **not** automatically become Work items:

- `docs/CURRENT_STATE.md` and product documentation (existing behavior)
- `docs/KNOWN_GAPS.md` (limitations)
- `docs/ROADMAP.md` (future direction)
- `docs/audit/OPEN_QUESTIONS.md` (undecided topics)
- Completed or resolved rows removed from canonical queues

Canonical Work uses **Bugs**, **Verify**, and **Enhancements** columns with Source and Priority filters.

## Generic fallback

Repositories without a declared canonical queue retain conservative generic parsing: explicit TODO checklists, status tables, and similar actionable markers. The generic view keeps Started, Open, and Done columns.
