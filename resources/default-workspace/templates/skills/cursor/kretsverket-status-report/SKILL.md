---
name: kretsverket-status-report
description: Builds the Swedish one-file HTML lägesrapport for Kretsverket from the bundled template, with fresh facts from origin/main docs, git, gh and the latest green gate. Use when someone asks for a lägesrapport, statusrapport, how far Kretsverket has come, or what remains before release.
category: kretsverket
risk: low
targets: codex, opencode, claude, cursor
related: browser-qa, screenshot-review, handoff
---

# Kretsverket Status Report

Produces exactly one self-contained HTML file in Swedish that a non-developer can read on a desktop or a phone. Not for PR descriptions, release notes or short status replies in chat.

Done when: the report is written to `.agent-reports/rapport/` in the Kretsverket checkout with a dated name, `verify-report.mjs` passes all four runs, and the file has been handed to the user.

## Bundled files

Installed harness skills contain only this file. The template and the verifier live in the Agent Workspace folder (default `~/.config/agent-workspace`, see Settings → workspace), or under `resources/default-workspace/` in an agent-workspace checkout:

- `skills/kretsverket/kretsverket-status-report/assets/report-template.html`: the approved report from 2026-10-13. It carries the design, structure, section ids, motion and no-JS handling. Every fact, number, date and name in it is from 2026-10-13; replace all of them on each use and never reuse one.
- `skills/kretsverket/kretsverket-status-report/scripts/verify-report.mjs`: the Playwright check (see Verify).

## Sources

Facts come only from:

- `docs/CURRENT_STATE.md`, `docs/ROADMAP.md`, `docs/KNOWN_GAPS.md`, `docs/DECISIONS.md`, `docs/BACKLOG.md` and `docs/proposals/INTEGRATED_PLAN.md`, read with `git fetch origin` then `git show origin/main:<path>`, never from a checkout that may be stale.
- git and `gh` counts: merged and open PRs, first commit date, app version from `package.json` on `origin/main`, line counts of tracked files.
- The latest green gate numbers (Vitest, Playwright, visual, Rust). If no green run is at hand, leave those figures out instead of guessing.

Rules:

- Label every percentage or progress figure as an uppskattning, and say how the overall figure is weighted.
- Never invent a number. If no source gives it, drop the element.
- Never include secrets, tokens, `.env` values, private URLs or customer data.
- The footer lists the sources actually used and the date they were read.

## Structure

Keep the template's section ids and this order:

1. Sticky nav.
2. Hero `#oversikt`: eyebrow with the date and app version, a one-line headline, a short TL;DR, the animated gauge with the overall estimate, KPI count-ups, and per-track progress bars.
3. `#pa-plats`: filterable area grid with the states Klart (`s-ok`), Delvis (`s-part`) and Experimentellt (`s-exp`).
4. `#kvar`: what remains to build, in three horizons.
5. `#release`: release stepper.
6. `#beslut`: open decisions, filterable by före release and kan vänta, each with a recommendation.
7. `#agent`: the agent pipeline with its flowing line.
8. `#nu`: pågår just nu.
9. Sources footer.

Values that live in more than one place must change together:

- Gauge: the `aria-label`, `stroke-dashoffset` = 515.2 × (1 − p/100), the `#gaugeNum` text, and `const GAUGE` in the script.
- KPIs: the final value in the markup (Swedish formatting, e.g. `12 884`, `5,5 mån`) and `data-count`, `data-decimals`, `data-suffix`.
- Track bars: `--w`, `data-w` and the `.pct` text.
- Filter chip counts (`data-c`, `data-dc`) equal the number of cards per `data-s` or `data-b` value.

## iPhone Quick Look and no-JS

Quick Look does not run JavaScript, and the first version showed a blank page there. So:

- All content and every final value are in the markup. JavaScript only enhances.
- The head script adds `html.js`. Only `.js .reveal` starts hidden.
- Bars use `width: var(--w)` with `.js .bar > i:not(.go) { width: 0 }`.
- The gauge and counters hold their final values in the markup; JavaScript resets them to 0 before animating.
- Filter controls are hidden under `html:not(.js)`.
- JavaScript generates no content.

## Design

Keep the template's look; if Kretsverket's tokens or icon have changed, take them from `origin/main`:

- Moonlit Macaron dark tokens from `src/themePresets.json`: `--bg #0f1115`, surfaces `#171a1f`, `#1d2127`, `#23272e`, accent `#5ca4ff`, cyan `#34e0c4`, text `#edf0f3`, `#b3bcc7`, `#86929f`.
- The cyan and blue radial corner fade from `src/styles/layout.css` and the faint canvas grid.
- System font stack. The app icon inline from `assets/brand/app-icon/app-icon-small-dark.svg`.
- No external scripts, fonts or images. 16 px side gutter, no horizontal scroll, `prefers-reduced-motion` respected.

## Language

Swedish, plain and direct, for a reader who is not a developer. Short sentences. Explain jargon (PR, grind, smoke, notarisering) or avoid it. Recommendations start with "Mitt förslag:".

## Verify

Copy the verifier next to the report so `playwright` resolves from Kretsverket's `node_modules`, then run it from the Kretsverket root:

```bash
cp "<workspace>/skills/kretsverket/kretsverket-status-report/scripts/verify-report.mjs" .agent-reports/rapport/
node .agent-reports/rapport/verify-report.mjs .agent-reports/rapport/kretsverket-lagesrapport-<YYYY-MM-DD>.html
```

It loads the file at 1280 and 390 px wide, each with JavaScript off and on. It fails on horizontal overflow, page errors, hidden content, counters or gauge not at their final values, a gauge whose number, arc and label disagree, and filter counts that do not match the cards. Fix and rerun until it prints `PASS: all four runs`.

## Deliver

- Write `.agent-reports/rapport/kretsverket-lagesrapport-<YYYY-MM-DD>.html` in the Kretsverket checkout. The folder is git-ignored; never commit the report.
- Hand the file to the user with the harness's file-send tool when there is one, so it opens on a phone. Otherwise give the path.
- Reply in Swedish with what the report says in three lines and which figures are estimates.

<!-- Generated by scripts/generate-skill-adapters.py. Do not edit directly. -->
## Harness Adapter

### Cursor Agent

- Cursor User Rules are installed manually and may be absent: keep secrets out of output and report verification evidence regardless.
