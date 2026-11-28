---
name: minimal-implementation
description: Implements the smallest complete change and runs the narrowest falsifying check. Use when the direction is clear and code must change or be refactored.
license: MIT
metadata:
  category: implementation
  risk: low
  targets: codex, opencode, claude, cursor, copilot, pi, kilo, antigravity, grok
  related: implementation-plan, diagnose, tdd
---

# Minimal Implementation

Use for code implementation and refactoring. Build the smallest complete, clear, and verifiable solution. Minimize necessary complexity, not line count.

Done when: the diff contains only the requested behavior, the narrowest falsifying check ran green, and checks not run are reported.

## Rules

- Inspect the owning code and existing patterns before editing.
- Extend the current owner; do not create a parallel path.
- Implement only the requested outcome.
- Avoid unrelated cleanup, renaming, formatting, or modernization.
- Reuse existing types, utilities, components, state, validation, and configuration.
- Add an abstraction only when it removes real duplication, names a stable domain concept, or creates a required safety or test boundary.
- Do not add dependencies, configuration options, extension points, caching, concurrency, or generalized infrastructure for hypothetical future work.
- Keep control flow explicit and ownership local.
- Preserve existing validation, permissions, persistence, backup, and migration boundaries.

## Simplification pass

Before finishing, remove anything unnecessary:

- new files, helpers, types, state, branches, or config
- duplicate rules or ownership
- speculative abstractions
- second paths for existing operations
- changes outside the requested scope
- comments this diff added that restate the code, narrate the change or address the reviewer; keep comments the language or tooling requires and every comment you did not write

Stop and report if the task requires an unapproved rewrite, dependency, architecture change, or materially broader scope.

Verify with the narrowest check that can falsify the change. Report what ran, what did not run, and residual risk.

## Harness notes

### Claude Code

- When `advisor` is available, call it before the first edit when the approach is not dictated by the task, and before reporting done.
