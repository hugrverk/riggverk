---
name: tdd
description: Drives one specified behavior at a time through a red → green → refactor loop using public interfaces and the repo's test style. Use when expected behavior is already known and a feature, fix, or regression test should be written test-first. Not for unknown root causes (diagnose).
category: testing
risk: low
targets: codex, opencode, claude, cursor
related: diagnose, implementation-plan
---

# TDD

Use tests to drive one useful behavior at a time. Prefer behavior through public interfaces over implementation checks.

Done when: each specified behavior has a test seen failing for the right reason and then passing, and the refactor step ran green.

## Process

1. **Name the seams.**
   - A seam is the public boundary where behavior is observable without reaching inside: a function, command, route, or component interface.
   - List the seams under test before writing any test. Confirm them with the user only when the choice is ambiguous.

2. **Pick the first behavior.**
   - Choose the smallest behavior that proves progress.
   - Use existing test style, fixtures, and naming.
   - Avoid testing private methods or internal call order.

3. **Red.**
   - Write one failing test.
   - Run the narrowest command that proves it fails for the expected reason.

4. **Green.**
   - Write only enough production code to pass the test.
   - Run the same command until it passes.

5. **Repeat.**
   - Add the next behavior only after the previous one is green.
   - Keep each cycle vertical: behavior -> implementation -> verification.
   - Do not write a batch of speculative tests before learning from the first slice.

6. **Refactor.**
   - Refactor only while green.
   - Remove duplication, clarify names, and deepen interfaces where the code now exposes real pressure.
   - Run the relevant tests after each meaningful refactor.

## Test Scope

- Test critical paths, edge cases with real risk, and bug regressions.
- Skip tests that only lock current implementation shape.
- Prefer the smallest useful verification command.
- If a good test seam does not exist, say so and explain the risk.

## Anti-patterns

- Tautological: the expected value is recomputed the way the code computes it (`expect(add(a, b)).toBe(a + b)`), so the test passes by construction. Assert literal values from a worked example or the spec.
- Implementation-coupled: mocks internal collaborators, asserts call order, or verifies through a side channel such as querying the database instead of the interface. The tell is a test that breaks on a behavior-preserving refactor.
- Mocking your own code: mock only at system boundaries (network, database, clock, randomness, filesystem). Inject those dependencies; do not mock modules you control.

## Output

- Seams tested and behaviors covered.
- Red evidence (command and failure reason) and green evidence (command and result) for each behavior.
- Refactor performed, if any.
- Seams or behaviors not tested, with the risk.
