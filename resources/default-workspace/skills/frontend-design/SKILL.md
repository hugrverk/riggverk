---
name: frontend-design
description: Chooses and implements visual direction for web and product UI, preserving an existing design system or committing to one coherent direction for greenfield work. Use when building or restyling screens, layouts, or components. Not for screenshot-only critique, accessibility audits, or runtime QA.
license: MIT
metadata:
  category: frontend
  risk: medium
  targets: codex, opencode, claude, cursor, copilot, pi, kilo, antigravity, grok
  related: screenshot-review, browser-qa, accessibility-review, prototype
---

# Frontend Design

Done when: the design thesis is stated, each state the change touches was rendered and checked at two or more viewports, and body-text contrast was verified; anything not rendered is reported as Not verified.

## Mode

Identify the working mode before any visual decision:

- **Existing product**: preserve the mature product language. Inspect tokens, components, routes, and screenshots first. Change only what the task requires.
- **Greenfield**: commit to one coherent direction before coding. Default to utilitarian clarity, not decorative novelty.
- **Explicit redesign**: only when requested. State what changes, what stays, and how success is measured.

## Routing boundaries

- **screenshot-review**: diagnoses static screenshots; does not implement unless asked.
- **frontend-design** (this skill): chooses visual direction and implements UI when requested.
- **accessibility-review**: specialist accessibility audit; not a substitute for baseline a11y during implementation.
- **browser-qa**: supplies runtime evidence after implementation.
- **prototype**: explores uncertain variants without creating permanent parallel design systems.

## Inspect first

Before proposing a direction, inspect repository reality:

- design tokens, typography, spacing, color, and component ownership
- relevant routes, layouts, and content patterns
- product language and the language of existing user-facing copy
- screenshots or live UI when available
- existing motion, density, and state handling

Preserve a mature product design system when one exists. Do not fall back to generic AI SaaS styling (purple gradients, interchangeable card stacks, stock dashboard chrome) unless the task explicitly requests a redesign.

## Design thesis

Write one sentence that states purpose, audience, tone, and density. Example: *calm operational workspace for small teams of developers — dense, legible, low ceremony.*

Then choose one coherent design thesis: the overall character the interface should express (for example restrained industrial, editorial, soft utility, or focused dashboard). Execute that thesis consistently; do not mix unrelated aesthetics in one slice.

Allow one or two reinforcing signature elements when they support the thesis — for example a distinctive type hierarchy, a controlled accent, or a consistent framing device. Avoid stacking unrelated decorative ideas.

## Typography

Treat typography as a primary design tool:

- establish hierarchy with scale, weight, and rhythm
- respect line length and reading comfort for body text
- prefer the existing type system; add fonts only with license, fallback, and performance justification
- do not ban system fonts when the product already depends on them

## Layout and composition

Treat layout as composition, not only spacing:

- define primary focal points and scan paths
- use asymmetry, density, whitespace, framing, or controlled overlap when they serve the thesis
- avoid endless equivalent card stacks and stock SaaS section patterns
- reuse existing components and ownership before inventing new structures

## Color, depth, and atmosphere

Use color, contrast, depth, texture, borders, and background treatment intentionally:

- one dominant palette with at most one controlled accent when appropriate
- never rely on color alone for meaning
- add atmosphere only when it supports the thesis; decorative backgrounds are optional, not required

## Motion and interaction

Define interaction purpose before adding animation:

- motion should clarify state, focus, or hierarchy — not decorate by default
- respect `prefers-reduced-motion`
- match implementation complexity to the chosen aesthetic; heavy animation requires clear value

## States and content realism

Finish the states users actually encounter:

- hover, focus, active, disabled, loading, empty, error, success
- long labels, truncation, overflow, localization, and realistic content length
- responsive behavior across narrow mobile through desktop widths

## Verification

When implementation is performed:

- verify rendered output (browser-qa or equivalent), not only static correctness
- keyboard reachability and visible focus
- contrast at least WCAG AA for body text unless the product standard is stricter
- reduced-motion behavior

## Final coherence check

Before reporting done, confirm the result is recognizable, usable, and intentional — not merely technically correct or generically polished.

## Guardrails

- Do not force novelty in mature products.
- Do not require animation, decorative backgrounds, or non-system fonts by default.
- Do not add dependencies or heavy animation libraries without clear value.
- Do not claim visual quality without checking the rendered result.
- Keep maintenance cost visible in tradeoffs.

## Harness notes

### Codex

- When visual direction needs concrete assets or mockups, use available image generation or bitmap references instead of abstract placeholders.
- Verify responsive UI with browser screenshots or appshots at the relevant viewports, and inspect overlap, text fit, and rendered assets before reporting completion.
