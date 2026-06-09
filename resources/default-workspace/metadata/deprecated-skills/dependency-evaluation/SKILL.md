---
name: dependency-evaluation
description: Evaluate build-vs-buy and dependency risk before adding packages, plugins, SDKs, MCP servers, CLIs, or new internal abstractions.
category: dependency
risk: medium
targets: codex, opencode, claude
related: security-review
---

# Dependency Evaluation

## Purpose

- Prevent package, plugin, SDK, CLI, MCP server, and abstraction bloat.
- Choose boring, maintainable solutions that fit the existing repo.
- Make dependency additions explicit and justified.

## When To Use

- Before adding or replacing a package, plugin, SDK, CLI, MCP server, service, framework, or generated client.
- Before introducing a new internal abstraction that could become a local dependency.
- When a task has build-vs-buy tradeoffs.
- When dependency upgrades affect APIs, security, license, bundle size, runtime behavior, or maintenance.

## Do Not Use When

- The repo already has a clear dependency or pattern for the need.
- The logic is trivial enough to implement directly without a dependency.
- The task is only using an already-installed dependency in the existing project style.
- The evaluation would become open-ended research; bound it to the decision at hand.

## Process

1. Define the need:
   - Required behavior.
   - User-visible or developer-visible value.
   - Runtime environment.
   - Security, licensing, performance, and maintenance constraints.
2. Inspect the repo first:
   - Existing dependencies.
   - Existing helper APIs, patterns, plugins, framework features, or standard library support.
   - Current package manager and lockfile conventions.
3. Decide whether a dependency is necessary:
   - Prefer no dependency for small parsing, formatting, validation, or utility logic.
   - Prefer platform or framework primitives when they are clear and stable.
   - Prefer small, stable dependencies over broad frameworks for narrow needs.
4. Evaluate external candidates:
   - Maintenance activity and release cadence.
   - License compatibility.
   - Security history and vulnerability response.
   - Transitive dependency weight and bundle/runtime impact.
   - API stability and typed definitions.
   - Documentation quality and examples.
   - Ecosystem fit with the repo's stack.
   - Lock-in and migration cost.
5. Compare options:
   - Adopt directly.
   - Wrap behind a narrow local interface.
   - Build custom.
   - Defer.
6. If adding a dependency, state the justification before editing dependency files.
7. After dependency changes, verify install/build/test/typecheck paths that can fail from the change.

## Output

- Need and constraints.
- Existing repo alternatives checked.
- Options compared.
- Recommendation: adopt, wrap, build custom, or defer.
- Justification for dependency changes.
- Verification commands and results.
- Risks and follow-up.

## Guardrails

- Do not search forever; pick a bounded set of plausible candidates.
- Do not add dependencies for convenience alone.
- Do not assume npm; apply the same review to any ecosystem.
- Do not edit package manager files unless the task explicitly requires adding, removing, or updating dependencies.
