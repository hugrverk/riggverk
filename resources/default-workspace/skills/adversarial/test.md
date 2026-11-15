# Test mode

One agent writes the tests, another writes the code, and neither grades its own work. A fresh adversary tries to break the change with failing tests tied to the acceptance criteria; you, the lead, keep only the tests you ran and saw fail for the stated reason, freeze them, and let the implementer change production code only. Test quality decides whether this helps: weak or over-mocked tests make the result worse, so a test that has not qualified never gates anything. The roles, the mutation guard and the role lookup are in `SKILL.md` next to this file; here the critic is called the adversary, and a qualified test is its proof.

Never start this mode because a task merely mentions tests; that is `tdd`.

Done when: an adversary round produced no new qualified failing test, or two rounds ran; the lead's own run of the test command is green, every kept test is byte for byte what qualified, and only tests that protect a criterion remain. Or the loop stopped at Escalated and is reported as such.

## Roles in this mode

- **Lead**: also writes the adversary's tests into the tree, runs every test, arbitrates `BLOCKED` and decides which tests stay.
- **Adversary**: read-only, fresh every round. It sees the task, the criteria, the code and the existing tests, never the implementer's reports or earlier rounds' discussion. The default adversary follows the same capability rule as the default critic.
- **Implementer**: changes production code only and never touches a test.

Resolve `adversary` and `implementer` as `SKILL.md` says (`Adversarial roles: adversary=codex/<model>` in the rules). Start line example:

```text
Roles: adversary=codex/<model> (default: other family, comparable, preflight ok), implementer=claude subagent (default); mode: test. Why: whoever writes the tests must not write the code. Change: say "adversary: claude", or add "Adversarial roles: adversary=claude" below END in your rules.
```

## Before round 1

1. Read the owning code and write down: the task; numbered acceptance criteria (C1, C2, ...), each one testable sentence quoted from the user, issue or spec, or written by you and confirmed with the user when unclear; the public interfaces in scope; the production paths the implementer may change; the full test command and the narrowest command that runs one test file; what is out of scope.
2. Choose the round's **test file**: one new file per round, at a path the repo's runner collects and in its test style (for example next to the existing tests of that module). Never add adversary tests to an existing test file, so that freezing the file freezes exactly the adversary's tests.
3. Snapshot the base commit and `git status --porcelain`, and make `<T>`.
4. Freeze the existing tests that cover the behaviour: record `git hash-object -w -- <paths>`. From here on only you change a frozen test, and only to discard one proven wrong, which goes into the ledger.

The current code is the working tree: the user's change, or the base when nothing is implemented yet, in which case the implementer's first turn is the implementation.

## Each round

1. **Adversary brief.** Fresh agent, cold start. Fill in the brief below with the task, the criteria, the interfaces, the commands, this round's test file, one existing test file as the style example, the diff (`SKILL.md`, Shared protocol) and the discarded-with-reason list from earlier rounds. Never add the implementer's reports.
2. **Mutation guard** (`SKILL.md`). A tripped guard discards the round; the change under test lives in the tree.
3. **Qualify** each proposed test on its own: write it into the round's test file and run the one-file command. It qualifies only when all of these hold:
   - it names one criterion and checks only what that criterion says;
   - it fails on the current code and the failure message matches the stated reason. A syntax, import, collection or fixture error disqualifies it, unless the stated reason is that a public interface the criterion requires is missing;
   - it fails the same way on a second run;
   - it goes through public interfaces in the repo's test style, asserts literal expected values from the criterion or a worked example, and mocks only system boundaries (network, clock, randomness, filesystem, database), never code the repository owns;
   - no existing or already qualified test checks the same thing.
   Remove a test that does not qualify and log one line with the reason; it joins the discarded list the next adversary receives. A test that passes is not a finding: discard it.
4. **Freeze** the qualified tests: record `git hash-object -w -- <round test file>`. If none qualified, delete the empty test file and stop with Done.
5. **Implementer turn.** Send a work order with the criteria, the frozen test paths and their failing output, the production paths in scope, the commands and these rules: change production code only, in the smallest diff that makes the frozen tests pass and keeps the rest green; never edit, skip, delete, weaken or special-case a test, and never detect that tests are running; if a test is impossible to pass or contradicts a criterion or another test, stop and report `BLOCKED: <test> - <evidence>` instead of working around it; report the exact commands run and their results.
6. **Path guard.** Re-run `git hash-object` on every frozen file and compare `git status --porcelain` with the round's start. A frozen file that changed is put back from its recorded hash (`git cat-file -p <hash> > <path>`), any other new or changed test file is removed from the implementer's diff, and the turn counts as `BLOCKED`. Then run the full test command yourself. A qualified test that still fails goes back to the implementer once with the output; if it fails again, Escalated.
7. **Arbitrate `BLOCKED`** against the criteria, and log the decision:
   - the test checks more than, or something other than, its criterion: discard it (delete it, drop its hash, log the evidence);
   - the criteria contradict each other or need a product decision: Escalated, with one batched question to the user;
   - the test is right: reject the `BLOCKED` with that evidence and send it back once; if it comes back, Escalated.
   The implementer never gets permission to change a test.

Stop with the matching terminal state:

- **Done**: an adversary round produced no new qualified failing test.
- **Round limit**: two adversary rounds ran, unless the user set another limit.
- **Escalated**: a question is waiting for the user.

## Keep or discard

The adversary's tests are probes; they join the change only when they earn it. After the loop, keep a frozen adversary test only when it protects a stated criterion in a case no other kept or existing test already covers (another input class or failure mode, not just other numbers), and delete the rest, noting which test covers each deleted one. Deleting a test is the only edit you make to a frozen file; never rewrite a kept test, since its bytes are what qualified. Run the full test command once more; everything kept passes.

Coverage gaps are notes, never blockers: list behaviour a criterion needs that no kept test exercises, from the adversary's untested risks or, if the repository already has a mutation-testing tool, from mutants that survive on the changed lines. Never install such a tool for this.

## Adversary brief

Paste this, filled in, as the adversary's whole prompt:

```text
You write adversarial tests for a code change. Find behaviour the acceptance criteria require that the current code gets wrong, and prove it with a failing test. You are read-only: do not create, edit, delete or commit files, do not run commands that write anywhere, and do not use skills, start agents or call other agent CLIs. You may read any file in the repository. You do not run the tests: the lead puts each one in the file below, runs it, and keeps it only if it fails for the reason you state.

Task: <...>
Acceptance criteria: <C1 ..., C2 ...>
Public interfaces in scope: <...>
Command that runs one test file: <...>
New test file for this round: <path>
Style example (an existing test file): <path>
Discarded earlier, with reasons (resubmit only with new evidence): <list or none>
Diff against <base>:
<diff, including new files, or "none: nothing is implemented yet">

Every test must:
- check one behaviour, tied to exactly one criterion, through public interfaces only;
- assert literal expected values taken from the criterion or a worked example, never recomputed the way the code computes them;
- mock only system boundaries (network, clock, randomness, filesystem, database), never code in this repository;
- be deterministic and independent of other tests and their order;
- stay inside what the criteria require: no private helpers, call order or unrequested behaviour.
Look first at edge cases, boundary values and error paths the existing tests miss. Submit only tests you expect to fail on the current code. Quality beats count: no test is a valid answer.

For each test use exactly:
**Test:** test name
**Criterion:** criterion ID, and the words of it that the test checks
**Expected failure:** what the current code does instead, and the assertion or error message the run will show
**Code:** one fenced block with the test and the imports it needs, ready for the new test file

Then a short **Untested risks** list: behaviour a criterion needs that you could not pin down in a test.
End with exactly one last line:
VERDICT: TESTS   (at least one test)
VERDICT: NONE    (no new failing test found)
```

## Report

Use the workspace final report (Changed, Verified, Not verified, Risk, Next) and add an adversarial ledger:

- each role, its route and model, and where it came from; the terminal state and the number of rounds;
- per round: tests proposed, qualified and discarded (one line each with the reason), and the implementer's production diff size (`git diff --stat` totals);
- `BLOCKED` reports and how you decided them, path-guard trips, route failures and fallbacks, open escalations;
- kept tests (file, name, criterion), deleted tests with the test that covers their criterion, and the coverage-gap notes.

End with one ledger line in the user's language, after the report:

```text
Ledger: Done after 2 rounds (no new qualified test); tests 5 proposed, 3 qualified, 2 discarded, 2 kept; BLOCKED 1 (test discarded); adversary codex/<model> (default).
```
