---
name: nextjs-product-slice
description: Implement small Next.js product slices with clear route/component/server boundaries, existing patterns, verification, and low-maintenance diffs.
category: frontend
risk: medium
targets: codex, opencode, claude, auggie
related: implementation-plan, security-review, database-migrations, accessibility-review
---

# Next.js Product Slice

## Purpose

- Implement bounded product changes in Next.js codebases.
- Keep route, component, server action, API, and data boundaries clear.
- Optimize for solo-developer maintainability.

## Process

1. Inspect existing app/router structure, components, data fetching, actions, API routes, auth, and styling conventions.
2. Restate the user-visible behavior and non-goals.
3. Identify the smallest vertical slice that proves the behavior.
4. Reuse existing components, tokens, validation, and data access patterns.
5. Keep client components minimal. Prefer server-side code unless interactivity requires client state.
6. Verify with the narrowest relevant command and route check.

## Output

- Behavior implemented or planned.
- Files changed or proposed.
- Client/server boundary.
- Data access and auth considerations.
- Verification run.
- Remaining risk.

## Guardrails

- Do not create broad abstractions for one slice.
- Do not move logic client-side without need.
- Do not bypass auth or validation.
- Do not introduce new libraries without explicit value.
