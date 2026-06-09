---
name: frontend-design
description: Design or improve frontend UI with a clear aesthetic direction, existing design-system fit, accessibility, verification, and low generic-AI feel.
category: frontend
risk: medium
targets: codex, opencode, claude, cursor
related: screenshot-review, browser-qa, accessibility-review
---

# Frontend Design

## Mode

Identify your working mode first:

- **Existing product**: preserve visual language, fit into design tokens and component patterns. Change only what the task requires.
- **Greenfield**: choose one clear direction before coding. Default to utilitarian, not decorative.
- **Explicit redesign**: only when asked. State what changes and why, with measurable improvement criteria.

## Intent

State in one sentence: purpose, audience, tone, information density. Example: *compact operational dashboard for solo developers — calm, dense, technical.*

## Design direction

Pick at most one signature idea: a deliberate color accent, a consistent spacing rhythm, a single motion pattern, or a strong layout hierarchy. Do not layer multiple signature ideas.

Avoid: purple gradients, glass cards, generic SaaS sections, stock layouts, random animation, equivalent card stacks.

## Typography

Use the existing type system first. Before adding a new font: check the license, verify system fallback coverage, and confirm the performance cost (file size, load strategy). Prefer system font stacks for utility surfaces.

## Color

One dominant palette. At most one controlled accent color. Never use color as the only differentiator (add text, icon, or pattern).

## Motion

At most one primary motion concept (fade, slide, scale, or spring). Respect `prefers-reduced-motion`. Do not animate loading indicators on every surface.

## States

Consider: loading, empty, error, disabled, validation, focus, overflow, long-label truncation, localization.

Test with realistic content length, not placeholder text.

## Composition

Strong hierarchy, deliberate whitespace, no endless equivalent card stacks. Reuse components before adding new ones.

## Verification

- Responsive: narrow mobile, wide mobile, tablet, desktop.
- Keyboard: all interactive elements reachable and operable.
- Reduced motion: no distracting animation when the user prefers static.
- Contrast: at least WCAG AA for body text.
- No generic AI SaaS aesthetic.

## Guardrails

- Do not optimize only for novelty or visual complexity.
- Do not override a mature design system.
- Do not claim visual quality without checking the rendered result.
