---
name: improve-codebase-architecture
description: Find bounded architecture improvements that reduce maintenance cost without broad rewrites.
---

# Improve Codebase Architecture

Look for small refactors that increase locality and reduce caller burden. Do not propose broad rewrites unless the user asks.

## Process

1. **Inspect.**
   - Read relevant code, tests, docs, and recent failure context.
   - Identify modules where understanding or changing one behavior requires many files.

2. **Find candidates.**
   - Shallow pass-through modules.
   - Leaky interfaces that force callers to know implementation details.
   - Duplicated orchestration across callers.
   - Missing seams that make behavior hard to test.
   - Concepts named inconsistently across code and docs.

3. **Evaluate.**
   - Use the deletion test: if removed, does complexity disappear or scatter across callers?
   - Prefer changes that improve both testability and everyday maintenance.
   - Respect existing architecture decisions unless real friction justifies revisiting them.

4. **Recommend.**
   - Present a short ranked list.
   - For each candidate include files, problem, proposed change, benefit, risk, and verification.
   - Ask which candidate to implement before editing unless the user already requested a specific refactor.

5. **Implement narrowly.**
   - Keep the public behavior stable unless explicitly changing it.
   - Refactor in small steps with tests or equivalent checks.
   - Stop if the change expands into a broader redesign.

## Output

- Ranked opportunities.
- Recommended first refactor.
- Verification plan.
- Risks and non-goals.
