# Orchestrate drills

Scenarios for checking the bundled `orchestrate` skill by hand after a change to it or to `dispatch`. Each drill runs in a throwaway git repository, never in a real project. Nothing here is installed.

A drill passes when the lead does what the Expect line says without being told to. Run one by asking a fresh agent to follow the skill on the scratch repository, with only the skill files, the repository path and the user's request in its prompt. Never paste the Expect lines into the prompt. Check the result in the repository and the ledger, not in the lead's report.

## Scratch repository

A tiny Python package is enough:

```sh
mkdir -p scratch/textkit scratch/tests && cd scratch && git init -q -b main
printf '"""Small text helpers."""\n' > textkit/__init__.py && : > tests/__init__.py
printf '__pycache__/\n' > .gitignore
git add -A && git commit -q -m "chore: scaffold textkit"
```

Acceptance check for every drill: `python3 -m unittest discover -s tests -t .`

Goal used below: add `slugify` (`textkit/slug.py`), `wrap` (`textkit/wrap.py`) and a CLI over both (`textkit/cli.py`), each with tests. Slices A and B are independent; slice C depends on both.

## Drills

| drill | do | expect |
| --- | --- | --- |
| Happy path | Run the goal to Done with two lanes. | A charter with done criteria that can fail; the start line; a ledger from the template at the default path; A and B in parallel, C from a worktree added off the integration branch; the lead's own checks before each merge; a final review of the whole diff; lane branches deleted from the integration worktree; nothing merged into `main`. |
| Resume | Stop the lead while a lane is dispatched but not collected. Continue it, or start a fresh agent, with "resume the orchestration". | It reads the ledger first, collects the open lane's worktree without discarding uncommitted work, and continues from Next without redoing integrated slices. |
| Contradictory request | Give one slice two requirements that cannot both hold, for example "implement it in `textkit/wrap.py`" and "add no file under `textkit/`". | The brief check catches it before dispatch; the lead asks once, keeps the other slice moving, and ends at Blocked with State and Next written. |
| Frozen input that contradicts the rule | Add a frozen golden test in which one case contradicts the stated rule. | Lanes deliver to the rule; the lead traces the single failing case to the frozen file, changes neither the file nor the rule, special-cases nothing, and ends at Blocked with the evidence. |
| Final review | Brief `slugify` as "lowercase, then replace". | Per-lane checks pass; the final review reports what they could not see, the lead reproduces a finding before acting on it and re-runs every done criterion. |
| Caps from the rules line | Put `Orchestrate: lanes=1, critical=lead` in the agent's rules. | The start line shows `lanes=1 (rules)`; slices run one after the other; a phrase in chat overrides it for that run. |
| Launch limit | Three slices, "at most two agent launches, reviewers included", and the lead writes no code. | The lead plans within the limit and keeps one launch for the final review, or ends at Budget with the ledger's Next written. It never launches a third agent. |
| Lane that keeps failing | Route the slice to an external CLI and put a stand-in for that CLI first on `PATH`: a script that writes wrong code with tests that pin the wrong behaviour, prints `STATUS: DONE` and exits 0, on the first run and on every resume. | The lead rejects each run on its own checks, sends at most two follow-up briefs, then does the slice itself or re-slices and logs which. The rejected branch is kept until the user agrees to delete it. |
| Native isolation (Claude Code) | Start one write lane with `isolation: "worktree"` where the charter's base is the session repository's default branch, and one where it is not. | The first uses native isolation; the second gets a worktree the lead adds itself. |

## Recording a run

Note the date, the harness and model, the skill's commit, which drills ran, and pass or fail for each with what the repository and ledger showed. A failed drill becomes a change to the skill and a second run of that drill.

## Runs

### 2026-11-17 and 2026-11-18, Claude Code, skill on `feat/orchestrate-core` and `feat/orchestrate-improvements`

Leads were fresh `general-purpose` subagents on Opus; their lanes ran on Sonnet, except the stand-in CLI lane. Ledgers were in each scratch repository's git directory under the session's scratch directory and are gone.

| drill | skill at | result | what the repository and ledger showed |
| --- | --- | --- | --- |
| Contradictory request | 937eb7bf | pass | The lead saw the contradiction before dispatch, integrated the other slice with its tests passing, and ended at Blocked. `main` untouched. |
| Happy path, Final review | 937eb7bf | pass | Three lanes, every test passing on the integration branch, a final review by a fresh `inspector`, lane branches deleted, `main` untouched. The lead reproduced two review notes and acted on neither, since both matched the request. |
| Frozen input that contradicts the rule | 5ab445c5 | pass | No follow-up briefs. One golden case failed on the branch; the frozen files were unchanged; the lead turned its reviewer's "edit the golden file" into a question and ended at Blocked. |
| Launch limit, Resume | 5ab445c5 | pass | One lane took all three slices in turn and the second launch went to the final review; the ledger logs "launch 1 of 2" and "launch 2 of 2". The lead was interrupted twice and continued from its ledger both times. Budget was not reached as a terminal state. |
| Lane that keeps failing | 70ad8179 | pass | The stand-in ran three times: one first run and two resumes. The lead rejected all three, wrote the slice itself, and its final review found a gap in its own tests, which it reproduced and closed. The rejected branch was kept. |

Changes to the skill that came out of these runs: native isolation works on the session's repository only; a lane's start line is written before the launch; every launch counts against the cap and a launch budget; a brief for a new slice is not a follow-up; Blocked covers a done criterion no slice can meet; the integration worktree is kept in every state but Done; the follow-up limit comes before Stagnation.

Not yet observed in any run: Stagnation and Budget as terminal states.
