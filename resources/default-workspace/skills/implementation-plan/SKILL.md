---
name: implementation-plan
description: Create small verifiable implementation slices with exact files, steps, commands, and risks. Use before multi-step or cross-file work. Does not implement—pair with `minimal-implementation` for the patch.
category: planning
risk: low
targets: codex, opencode, claude, cursor
related: context-budget
---

# Implementation Plan

Make the plan clear enough for a coding agent with no project memory to execute safely; optimize for small diffs, verification, and low rework.

## Process

1. **Confirm scope.**
   - Restate goal.
   - Identify non-goals.
   - Call out DB/migration status when relevant.
   - Stop if the task is too broad and split it.

2. **Inspect repo reality.**
   - Read relevant files before planning.
   - Prefer existing patterns.
   - List files likely to be changed.
   - Do not invent APIs, routes, components, or commands.

3. **Slice the work.**
   - Each slice should be independently useful and verifiable.
   - Prefer small vertical slices over broad layer-by-layer work.
   - Each slice should include:
     - goal
     - files to inspect or change
     - exact implementation steps
     - verification command or manual check
     - commit message suggestion if useful

4. **Avoid placeholders.**
   - Do not write placeholder markers or vague chores such as generic test or error-handling steps.
   - If information is missing, name the missing fact and ask or mark it as a blocker.
   - Do not say "similar to previous task"; repeat necessary detail.

5. **Verification plan.**
   - Start with the narrowest useful command.
   - Add broader checks only when risk justifies it.
   - For frontend work, include route, viewport, and visual checks when possible.
   - For DB or schema work, explicitly state migration and rollback considerations.

## Output

- Goal
- Non-goals
- Assumptions
- File map
- Slices
- Verification plan
- Risks and blockers

## Guardrails

- Do not plan broad rewrites unless explicitly requested.
- Do not bury risky changes inside a large slice.
- Do not treat the plan as verified implementation.
