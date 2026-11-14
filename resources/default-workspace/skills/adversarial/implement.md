# Implement mode

One agent writes the change; a fresh critic tries to break it and to shrink it; you, the lead, accept only what you can prove. The goal is the smallest correct diff, not the most reviewed one. The roles, the proof rule, the mutation guard, adjudication and the finding format are in `SKILL.md` next to this file.

Done when: a fresh critic returned `VERDICT: APPROVE` or raised nothing you could prove, the simplification round is done and the lead re-ran the verification itself; or the loop stopped at Stagnation, Escalated or Round limit and is reported as such.

## Before round 1

1. Read the owning code and write down: the task, explicit acceptance criteria, files in scope, the verification commands and what is out of scope. Resolve unclear requirements with the user now, not through the loop.
2. Snapshot the base commit and `git status --porcelain`, and make `<T>`.
3. Freeze the judging tests: the existing tests that cover the behaviour plus any acceptance test you write or approve now. Record `git hash-object -w -- <test paths>`; `-w` stores the content, so a frozen test can be put back with `git cat-file -p <hash> > <path>` even if it was never committed. From here on only you change them, and only to fix a test proven wrong, which goes into the ledger.
4. Brief the implementer with the task, the criteria, the scope, the verification commands, the frozen test paths and these rules: smallest diff that meets every criterion; every hunk serves a criterion; follow existing patterns; no drive-by cleanup; no new dependencies or config changes unless the task needs them; never edit, skip, weaken or special-case a frozen test; if a criterion or a frozen test is impossible or contradicts another, stop and report `BLOCKED: <criterion or test> - <evidence>` instead of working around it; run the verification and report the exact commands and results; list anything not done.

## Each round

1. **Critic brief.** Fresh agent, cold start. Fill in "Critic brief" below with the task and criteria, the scope, the verification commands, the rejected-with-evidence list from earlier rounds and the diff (`SKILL.md`, Shared protocol).
2. **Mutation guard** (`SKILL.md`). A tripped guard discards the round.
3. **Check every proof** with the proof rule. A Minimality proof holds only if the checks stay green without the hunk. A proof test you add is temporary; keep it only if it guards a criterion, and then freeze it too.
4. **Adjudicate** every proven finding (`SKILL.md`): re-scope means fixing the narrower thing, and rejections join the list the next critic receives.
5. **Escalate instead of fixing** when a finding challenges the approach or architecture, would change a public contract, schema, security posture or scope, or needs a product decision, and whenever the implementer reports `BLOCKED`. Batch them into one question to the user per round.
6. **Fix.** Send the accepted and re-scoped findings to the implementer as a work order under the same rules as its first brief. Deletions the critic proposed under Minimality count as fixes. Then re-run `git hash-object` on the frozen tests; if one changed, put it back from its recorded hash and treat the turn as `BLOCKED`.
7. **Score and decide.** Score = 3 × Fatal + Significant, counting only accepted and re-scoped findings. Continue only while the score falls strictly from round to round. Compare `git diff --stat` with the previous round: a diff that grows needs an accepted finding that required it.

Stop with the matching terminal state:

- **Approved**: a fresh critic returns `VERDICT: APPROVE`, or its `REVISE` leaves no accepted or re-scoped Fatal or Significant finding after you checked every proof (say which in the ledger). Run the simplification round next.
- **Stagnation**: the score did not fall, or the same finding came back unchanged; escalate with both rounds' findings.
- **Escalated**: a question is waiting for the user.
- **Round limit**: three critic rounds, unless the user set another limit (most of the gain comes in the first two); report what is still open.

## Simplification round

Once, after Approved only. A fresh critic gets the simplification brief below and the approved diff. It may only propose removals; nothing new may be added. Accept a removal only when the removed lines serve no criterion, every check you re-run stays green, the code reads at least as clearly, and `git diff --stat` shrinks. The implementer applies the accepted removals; re-run the verification and put back any removal that turns a check red. No critic round follows, and the state stays Approved.

## Critic brief

Paste this, filled in, as the critic's whole prompt, with the finding format from `SKILL.md` in place of `<finding format>`:

```text
You are a hostile reviewer of a code change. Your job is to break confidence in it and to make it smaller. You are an auditor, not a contributor: do not create, edit, delete or commit files, do not run commands that write anywhere, and do not use skills, start agents or call other agent CLIs. You may read any file in the repository. You do not need to run your proofs: the lead runs them.

Task and acceptance criteria: <...>
Scope: <...>
Verification commands: <...>
Rejected with evidence in earlier rounds (re-raise only with new evidence): <list or none>
Diff against <base>:
<diff, including new files>

Attack every dimension; for each, report a finding or what you checked and why it holds:
1. Correctness: wrong results, broken edge cases, error paths, regressions in code the diff touches indirectly.
2. Acceptance: does the diff meet every criterion, or only the happy path?
3. Minimality: for each hunk, name the criterion it serves; if removing it breaks no criterion or check, propose deleting it. Flag new abstractions, options or files the task did not need, drive-by changes, and existing helpers or patterns the diff duplicates instead of using.
4. Risk: security, data loss, concurrency, compatibility, performance cliffs.
5. Verification: do the tests exercise the changed behaviour, or only coverage?

<finding format>
```

In this mode the two placeholders of the finding format are:

- `<mode field>`: `**Proposed Fix:** the smallest concrete change, preferring deletion`
- `<mode rules>`: `For a Minimality finding the proof may instead be the hunk and the checks that stay green without it; code the task did not need is Significant. Do not ask for new features, refactors or style changes outside the task.`

The critic proposes a fix here because the lead's proof check, not the critic's say-so, decides what is acted on.

## Simplification brief

```text
You review an approved code change for deletions only. Propose removing or merging lines the change added that no acceptance criterion needs. Never propose additions, rewrites, renames, new abstractions or changes outside the diff, and never trade readability for fewer lines. Do not edit files, run commands that write, use skills or start agents.

Task and acceptance criteria: <...>
Verification commands: <...>
Diff against <base>:
<diff, including new files>

For each proposal use exactly:
**Removal:** file:line range to delete or merge
**Why It Is Safe:** no criterion needs it, and which checks still cover the behaviour
**Readability:** why the code reads at least as clearly afterwards

End with exactly one last line:
VERDICT: REMOVE   (at least one proposal)
VERDICT: KEEP     (nothing can go)
```

## Report

Use the workspace final report (Changed, Verified, Not verified, Risk, Next) and add an adversarial ledger:

- each role, its route and model, and where it came from; the terminal state and the number of critic rounds;
- the score and the diff size (`git diff --stat` totals) per round, and what the simplification round removed;
- accepted, re-scoped, rejected and unproven findings, one line each, with the proof or the evidence for every rejection;
- frozen-test changes, `BLOCKED` reports, route failures and fallbacks, open escalations and remaining Minor findings.

End with the ledger line from `adversarial-roles.md`. Never call the result approved unless the last fresh critic said `VERDICT: APPROVE` or left no proven Fatal or Significant finding, and your own verification passed.
