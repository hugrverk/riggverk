---
name: kretsverket-status-report
description: Kretsverket profile of status-report for the Swedish lägesrapport, adding Kretsverket's origin/main docs, sections and plain tone. Use when someone asks for a lägesrapport, statusrapport, how far Kretsverket has come, or what remains before release.
license: MIT
compatibility: Needs git, an authenticated gh CLI, Node.js and the status-report skill.
metadata:
  category: kretsverket
  risk: low
  targets: codex, opencode, claude, cursor, copilot, pi, kilo, antigravity, grok
  related: status-report, browser-qa, handoff
---

# Kretsverket Status Report

A profile on top of the `status-report` skill. Follow `status-report` for the workflow, the data contract (`report.schema.json`), rendering, verifying, language and redaction. This file adds only what is specific to Kretsverket.

Done when: `status-report` is done, the report is in Swedish, every Kretsverket source below was read from `origin/main` or named in `gaps`, and the file is in `.agent-reports/rapport/`.

The `assets/` and `scripts/` files next to this `SKILL.md` belong to the earlier standalone report. Do not use them; use the template and scripts that ship with `status-report`.

## Sources

Run `git fetch origin`, then read each file with `git show origin/main:<path>`, never from a checkout that may be stale:

- `docs/CURRENT_STATE.md`, `docs/ROADMAP.md`, `docs/KNOWN_GAPS.md`, `docs/DECISIONS.md`, `docs/BACKLOG.md` and `docs/proposals/INTEGRATED_PLAN.md`.
- `package.json` on `origin/main` for `project.version`.
- git and `gh` for merged and open PRs, commits and releases, as in `status-report`.
- The latest green gate (Vitest, Playwright, visual, Rust). Use its test counts as metrics only when a green run is at hand; otherwise add a line to `gaps` instead of guessing.

## Sections

Map Kretsverket's documents onto `report.json`:

- `happened`: merged PRs and releases in the period, grouped per area (editor, symbols, wiring, files, export).
- `happening`: what `CURRENT_STATE.md` marks as in progress, plus open PRs.
- `next`: the horizons in `ROADMAP.md` and `INTEGRATED_PLAN.md`, with the release steps in order. An open decision from `BACKLOG.md` or `INTEGRATED_PLAN.md` goes here with `confidence` low and a `note` that starts with "Mitt förslag:".
- `risks`: `KNOWN_GAPS.md` items that block or threaten the release.
- `decisions`: decisions from `DECISIONS.md` dated inside the period.
- `metrics`: merged PRs, open PRs, commits and green test counts. There is no overall progress gauge. `progress` only appears with a counted basis, such as done items out of a `ROADMAP.md` horizon.

## Tone

Swedish (`project.language` is `sv`), plain and direct, for a reader who is not a developer. Use short sentences. Explain jargon (PR, grind, smoke, notarisering) or avoid it.

## Deliver

- Work in `.agent-reports/rapport/` in the Kretsverket checkout. The folder is git-ignored; never commit the report.
- Write `report.json` there, then render to `kretsverket-lagesrapport-<YYYY-MM-DD>.html` with `status-report`'s `render-report.mjs`.
- Run `status-report`'s `verify-report.mjs` from the Kretsverket root, so `playwright` resolves from Kretsverket's `node_modules` and the browser pass runs.
- Hand over the file as `status-report` describes, and reply in Swedish.
