---
name: frontend-design
description: Design or improve frontend UI with a clear aesthetic direction, existing design-system fit, accessibility, verification, and low generic-AI feel.
category: frontend
risk: medium
targets: codex, opencode, claude
related: screenshot-review, browser-qa, accessibility-review
---

# Frontend Design

## Purpose

- Create or improve frontend UI with a clear point of view.
- Avoid generic AI/SaaS aesthetics.
- Match the existing product, brand, design system, and codebase before inventing new visual language.

## Process

1. **Read context.**
   - Existing design tokens, CSS/SCSS, component patterns, screenshots, routes, and user requirements.
   - For existing projects, preserve the product's visual language unless asked to redesign.
   - For greenfield work, choose one clear aesthetic direction before coding.

2. **Choose design direction.**
   - State the intended tone in one sentence.
   - Examples: editorial, utilitarian, premium, playful, brutalist, calm, dense, minimal, technical, organic.
   - Do not default to purple gradients, glass cards, generic SaaS sections, stock layouts, or random animation.

3. **Design the interface.**
   - Typography: clear hierarchy, deliberate scale, readable body copy.
   - Layout: strong composition, spacing rhythm, responsive behavior.
   - Color: restrained palette, meaningful contrast, accessible states.
   - Components: reusable patterns, not one-off decoration.
   - Motion: only where it clarifies state or improves perceived quality.
   - Accessibility: keyboard, focus, contrast, labels, reduced motion where relevant.

4. **Implement.**
   - Use existing framework and style conventions.
   - Prefer small, local diffs.
   - Reuse tokens and components before adding new ones.
   - Keep copy user-facing language consistent with the project.
   - Avoid broad rewrites unless explicitly requested.

5. **Verify.**
   - Run the narrowest relevant build, lint, or typecheck.
   - Check the relevant routes or components in browser when possible.
   - For visual work, report viewport coverage and screenshots/manual checks.
   - State any unverified visual risk.

## Output

- Design direction
- Files changed or proposed
- Key UI decisions
- Verification run
- Remaining visual or implementation risk

## Guardrails

- Do not optimize only for novelty.
- Do not add heavy animation or dependencies without clear value.
- Do not override a mature design system without reason.
- Do not claim visual quality without checking the rendered result when possible.
