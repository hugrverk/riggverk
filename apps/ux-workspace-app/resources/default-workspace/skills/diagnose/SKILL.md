---
name: diagnose
description: Debug bugs, failures, flakes, slowness, or regressions with reproduce -> minimise -> hypothesise -> instrument -> fix -> regression-test.
---

# Diagnose

No blind fixes. Build a feedback loop first, then use it to falsify hypotheses.

## Process

1. **Understand the report.**
   - Restate the observed symptom and expected behavior.
   - Identify the smallest user-visible behavior that proves the bug.
   - Read relevant code and local docs before changing anything.

2. **Build a feedback loop.**
   - Prefer the fastest deterministic signal that reaches the bug: failing test, CLI command, HTTP script, browser check, fixture replay, trace replay, or small harness.
   - Assert the actual symptom, not a nearby crash.
   - If flaky, increase reproduction rate with repeats, stress, fixed seeds, controlled time, or narrower setup.
   - If no loop is possible, stop and report what was tried plus the artifact needed from the user.

3. **Reproduce and minimise.**
   - Run the loop until the failure is observed.
   - Shrink inputs, setup, and code path until the failing case is small enough to reason about.
   - Keep the original full-path repro for final verification.

4. **Hypothesise.**
   - List 3-5 ranked, falsifiable hypotheses before changing code.
   - Format each as: "If X is the cause, then Y should happen when Z changes."
   - Test one hypothesis at a time.

5. **Instrument.**
   - Use debugger or REPL inspection when available.
   - Otherwise add targeted logs at decision points that distinguish hypotheses.
   - Tag temporary logs with a unique prefix like `[DEBUG-a4f2]`.
   - For performance bugs, measure first: baseline timing, profiler, query plan, or benchmark.

6. **Fix.**
   - Turn the minimised repro into a regression test when there is a correct seam.
   - Watch it fail, apply the smallest fix, then watch it pass.
   - If no correct test seam exists, document that as architecture risk.

7. **Verify and clean up.**
   - Re-run the minimised regression signal.
   - Re-run the original feedback loop.
   - Remove all tagged debug logs and throwaway harnesses.
   - State the root cause, fix, commands run, and any unverified risk.

## Guardrails

- Do not patch based on vibes.
- Do not propose fixes before the root cause has been investigated and stated.
- Do not broaden scope into unrelated refactors.
- Do not keep temporary instrumentation unless it becomes intentional observability.
- Do not claim the bug is fixed unless the original loop was rerun or the gap is stated.
