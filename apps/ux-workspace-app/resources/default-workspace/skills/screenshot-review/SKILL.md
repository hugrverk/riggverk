---
name: screenshot-review
description: Review UI screenshots before implementation. Use when the user provides screenshots or asks for visual audit, layout critique, responsive review, or screenshot-driven frontend improvements.
---

# Screenshot Review

## Purpose

- Turn screenshots into a bounded UI diagnosis and patch plan.
- Identify visual drift without jumping straight to code.
- Pair well with frontend-design for implementation planning.

## Process

1. Inspect supplied screenshots and any relevant route or component context.
2. Identify viewport, page state, and user flow.
3. Review hierarchy, spacing, density, alignment, typography, color, affordance, accessibility, and responsive behavior.
4. Compare against existing design tokens, components, and product language when repo context is available.
5. Rank issues by user impact and implementation risk.
6. Propose a small patch plan. Do not edit files unless explicitly asked.

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
