# Ledger: <slug>

Copy this file to the ledger path, replace every `<...>`, and delete this paragraph. Edit the Slices and Lanes tables in place and rewrite Next when the plan changes. Decisions, Findings and Log are append-only: add a line when the event happens, with the time `date -u +%FT%TZ` prints, and never rewrite an earlier line. The Log is the last section on purpose, so a line appended to the file lands in it. No secrets, tokens or env values; name a variable, never its value.

## Charter

- Goal: <outcome in one or two sentences>
- Done criteria:
  1. <command or observation that can fail>
- Scope: in: <...>. Out: <...>.
- Authority: <what you may do without asking>
- Caps: <agents at a time>; <models that may be used, or configured defaults>
- Budget: <limit, or none given>
- Base: <commit hash> on <branch>
- Integration branch: orchestrate/<slug>, worktree <path>

## Next

The part a resuming session reads first.

- State: <running | Done | Blocked | Budget | Stagnation | Stopped>
- Verified so far: <...>
- Not verified: <...>
- Next action: <the single safest next step>

## Slices

Status is one of: waiting, dispatched, collected, integrated, lead, dropped.

| id | files owned | acceptance checks | depends on | risk | status | lane |
| --- | --- | --- | --- | --- | --- | --- |
| A | <paths> | <commands> | - | mechanical | waiting | - |

## Lanes

One row per lane, written at dispatch, with `-` for a temp dir the harness manages. Start and end times go in the Log, not here.

| lane | slice | route | model | temp dir | worktree | branch |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | A | <route> | <model or default> | <path> | <path> | delegate/<slice slug> |

## Decisions

- <time> asked: <question>.
- <time> answered: <question>: <answer>.

## Findings

Each line starts with `verified`, `unproven` or `rejected`, then the evidence: the command you ran and what it showed.

- <time> verified: <claim>. Evidence: <command and result>.

## Log

- <time> start L1 (slice A).
- <time> end L1: <STATUS line or exit reason>.
- <time> check: <command> on <branch>: <result>.
- <time> integrate L1 into orchestrate/<slug>: <result>.
