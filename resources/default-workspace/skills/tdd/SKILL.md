---
name: tdd
description: Use a narrow red -> green -> refactor loop for test-first features, fixes, regressions, and behavior changes.
category: testing
risk: low
targets: codex, opencode, claude, cursor
related: diagnose, implementation-plan
---

# TDD

Use tests to drive one useful behavior at a time. Prefer behavior through public interfaces over implementation checks.

## Process

1. **Pick the first behavior.**
   - Choose the smallest behavior that proves progress.
   - Use existing test style, fixtures, and naming.
   - Avoid testing private methods or internal call order.

2. **Red.**
   - Write one failing test.
   - Run the narrowest command that proves it fails for the expected reason.

3. **Green.**
   - Write only enough production code to pass the test.
   - Run the same command until it passes.

4. **Repeat.**
   - Add the next behavior only after the previous one is green.
   - Keep each cycle vertical: behavior -> implementation -> verification.
   - Do not write a batch of speculative tests before learning from the first slice.

5. **Refactor.**
   - Refactor only while green.
   - Remove duplication, clarify names, and deepen interfaces where the code now exposes real pressure.
   - Run the relevant tests after each meaningful refactor.

## Test Scope

- Test critical paths, edge cases with real risk, and bug regressions.
- Skip tests that only lock current implementation shape.
- Prefer the smallest useful verification command.
- If a good test seam does not exist, say so and explain the risk.
