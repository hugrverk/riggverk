# Design MD Token Role Audit

## Scope

This note tracks the bounded body/surface/text role fix for generated Design MD previews.

## Baseline Causes

- `body` was classified as canvas before text in `designMdColorSemantics.ts`.
- `body` was included in `isCanvasToken` and had a plain body light-canvas fallback in `designMdThemeResolver.ts`.
- `surface`, `card`, `panel`, and `tile` shared broad surface matching, allowing component-local surfaces to influence page-level theme choices.
- Source prose was applied too broadly to every token, so a sentence like "timeline colors are only..." could mark unrelated canvas and hairline tokens as timeline-only.
- Dark selection accepted explicit body/card/panel-like matches without checking whether the resolved token role was actually page background.

## Patch Direction

- Centralize token role classification in `designMdTokenRoleResolver.ts`.
- Treat plain `body` and plain `surface` as ambiguous unless group, source evidence, prose, and value support a stronger role.
- Preserve existing high-level semantic roles while attaching `resolvedRole`, `roleConfidence`, `roleEvidence`, and `roleWarnings`.
- Make light and dark theme resolution consume resolved roles before falling back to key-name matching.
- Keep generated HTML local, deterministic, sandboxed, script-free, and asset-free.

## Audit Command

Run:

```sh
node scripts/audit-design-md-token-roles.mjs
```

The script reads the local cached Design MD catalog only. It reports watched body/canvas/background/page/surface/card/panel/ink/text/foreground tokens, resolved roles, selected light/dark theme tokens, and mismatch flags for manual QA.
