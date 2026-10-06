---
name: screenshot-review
description: Diagnoses supplied UI screenshots for hierarchy, spacing, overflow, alignment, and responsive risks and returns a ranked patch plan without editing files. Use when the user shares screenshots or images of a UI to critique. Not for live-browser verification (browser-qa).
category: frontend
risk: low
targets: codex, opencode, claude, cursor
related: frontend-design, browser-qa, accessibility-review
---

# Screenshot Review

Turn screenshots into a bounded diagnosis and patch plan; do not jump straight to code.

Done when: each issue has a root-cause hypothesis, a likely file, and a verification viewport.

## Process

1. Inspect supplied screenshots and any relevant route or component context.
2. Identify viewport, page state, and user flow.
3. Review hierarchy, spacing, density, alignment, typography, color, affordance, accessibility, and responsive behavior.
4. Compare against existing design tokens, components, and product language when repo context is available.
5. Rank issues by user impact and implementation risk.
6. Propose a small patch plan. Do not edit files unless explicitly asked.

## Frequent root causes

- Squeezed or overflowing text in a row: flex/grid child missing `min-width: 0` or truncation styles.
- Clipped focus ring or shadow: `overflow: hidden` on an ancestor, or no padding around focusable content.
- Horizontal scroll on mobile: fixed widths, `100vw` plus scrollbar, or an unwrapped wide element (table, `pre`, image).
- Misaligned icon/text rows: mixed line-heights or icons not flex-centered.
- Uneven spacing rhythm: hardcoded margins instead of the repo's spacing tokens.

## Output

- Screenshot context.
- Main visual issues.
- Root cause hypothesis.
- Ranked fixes.
- Files likely involved.
- Verification viewports.
- Remaining uncertainty.

## Guardrails

- Do not redesign the product from one screenshot.
- Do not claim browser verification from screenshot review alone.
- Do not invent design tokens if existing tokens fit.
- Do not optimize only for novelty.
