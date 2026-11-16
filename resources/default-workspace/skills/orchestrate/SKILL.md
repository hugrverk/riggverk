---
name: orchestrate
description: Leads agents toward a goal with a charter, a ledger that survives context loss, risk-routed lanes and lead-verified reports. Use when the user asks to orchestrate, never unasked.
license: MIT
compatibility: Needs git and either write-capable subagents in the current harness or another coding-agent CLI with a headless mode (Codex, Claude Code, OpenCode).
metadata:
  category: workflow
  risk: high
  targets: codex, opencode, claude, cursor, copilot, pi, kilo, antigravity, grok
  related: dispatch, blueprint, adversarial, zoom-out, security, migrations, release-check, pr-workflow, handoff
---

# Orchestrate

You are the lead. You drive a goal to done through other agents: you plan, route, verify, integrate and decide; they do bounded slices. `dispatch` hands slices to other agents (one or several, with no charter or ledger); this skill is the goal-driven loop around them. Agents' reports are claims, never evidence.

Done when: every done criterion in the charter is met and verified by your own checks, or the loop stopped at a terminal state below; the ledger is current; every worktree and branch you created is integrated, removed or listed for the user; and the report is given.

## When

Only when the user asks for it: "orchestrate this", "lead agents toward X", or `/orchestrate <goal>`. Never start a fleet on your own initiative. This skill needs `dispatch`; if it is not installed, say so and stop.

## Charter

Before any agent starts, write the charter as the first section of the ledger:

- **Goal**: the outcome in one or two sentences.
- **Done criteria**: checks that can fail, such as commands that must pass, behaviour to observe, files that must exist. "Looks good" is not one.
- **Scope**: what is in and out.
- **Authority**: what you may do without asking, taken from the user's words and rules. Default: commit and merge on your own branches only. Merging into the user's branch, pushing, releasing, publishing, changing settings, sending messages and deleting anything you did not create each need the user's yes unless the user's words or rules grant it.
- **Caps**: how many lanes may run at once and which routes and models they use. Resolve them with `orchestrate-rules.md` next to this file.
- **Budget**: a time, cost or launch limit, if the user gave one.

Ask one question up front only if the done criteria or the authority are unclear. Then say the goal and the authority in chat in a few lines, and print the start line from `orchestrate-rules.md`.

## Ledger

One Markdown file that lets you, or a new session, resume after context loss. Put it where the user or the `Orchestrate:` line says. Otherwise use `orchestrate/<slug>.md` inside the directory `git rev-parse --path-format=absolute --git-common-dir` prints, which every worktree shares; ask only when that cannot be written. Never use the OS temp directory.

Start it from `ledger-template.md` next to this file. Slices, Lanes and Next are edited in place; Decisions, Findings and Log are append-only, one line per event with the time `date -u +%FT%TZ` prints, written when the event happens and never reconstructed afterwards. Log a lane's worktree, branch and temporary directory as soon as you know them. The ledger holds no secrets: name a variable, never its value.

**Resume.** Read the ledger first. Treat every lane without an end line as dead: find its worktree with `git worktree list`, collect it as `dispatch` describes, then re-brief or finish the slice.

## Loop

1. **Map.** Read the owning code and docs, or send read-only agents to map wide areas (`zoom-out`; `repo-scout` where the harness has it).
2. **Slice.** Break the goal into slices with `blueprint`. Every slice owns a disjoint set of files and has its own acceptance checks. Two slices that touch the same file run one after the other.
3. **Route by risk.**
   - **The lead keeps**: decisions, root-cause diagnosis, releases and other outward actions, integration, and final verification. A slice that touches auth, permissions, secrets, validation at a trust boundary, shell execution or payments is also yours, with `security`; schema and persisted-data changes go through `migrations`.
   - **Critical** implementation (data, persistence formats, public contracts): you do it, or a lane on the `critical` route. Use `adversarial` when the user asked for critic review; its own lookup picks the implementer and the critic, and both count against the lane cap.
   - **Mechanical** (renames, codemods, boilerplate): a lane on the `mechanical` route, else the route `dispatch` resolves. A docs-only slice may go to `scribe` where the harness has it.
   - **Review or research**: fresh read-only agents, by the names in the Harness notes: `inspector` for code review, `sentinel` for a diff with security surface, `repo-scout` for mapping. `verifier` may run checks as a second opinion, never instead of your own run.
4. **Dispatch.** Start lanes up to the caps, each with a `dispatch` brief in its own worktree. Read each brief against the charter before it goes out: every decision in it follows from a done criterion or a scope line, and where the wording allows two readings, choose one and add an example that shows which.
5. **Collect and verify** each lane as `dispatch` describes, and run the acceptance checks yourself. Tests a lane added beyond its brief are claims too: read what they pin. A review finding counts only when you reproduce it; log the rest as unproven. A lane gets at most two follow-up briefs, as in `dispatch`; after that, do the slice yourself or re-slice it, and log which.
6. **Integrate** into `orchestrate/<slug>`, a branch you create from the base in your own worktree. Merge one lane at a time and run the checks after each. A conflict means the slices were not disjoint, so fix the plan, not just the merge. A lane that needs integrated work gets a worktree you add from `orchestrate/<slug>`. No integration runs while an adversarial slice is mid-round.
7. **Re-plan.** After each integration, compare the ledger with what you now know. When evidence contradicts the plan, stop dispatching and re-slice.
8. **Decide.** Batch questions when a decision blocks a lane or crosses the authority. Use the harness's question tool when it has one, recommended option first. Keep unblocked lanes running while you wait.
9. **Final review.** When the last slice is integrated, review `orchestrate/<slug>` as one change before you call it done. Read `git diff <base>..orchestrate/<slug>` in bounded slices, and give it to a fresh reviewer, by the names in the Harness notes: `inspector`, plus `sentinel` when it has security surface. Its findings count only when you reproduce them. Look for what per-lane checks cannot see: slices that contradict each other, duplicated helpers, a contract one slice changed and another still assumes, and hunks no done criterion needs. Then run every done criterion and the repository's wider gate yourself in the integration worktree. When the goal ends in a merge or a release, `release-check` adds its verdict against the charter's base, on top of your run. Fix what you prove in one wave, through a lane or yourself, and re-run the checks. A finding that needs a re-plan goes back to step 7.

While lanes run, wait for their notifications instead of polling, and do lead work: verify finished lanes, prepare the next briefs, update the ledger. Tell the user at milestones, not at every event.

## Terminal states

- **Done**: every done criterion verified by you, after the final review.
- **Blocked**: every remaining slice waits on the user, so ask once with all of it.
- **Budget**: the time, cost or launch limit is reached.
- **Stagnation**: two dispatch rounds in a row with nothing integrated, or the same failure twice. Escalate with the evidence.
- **Stopped**: the user said stop. Start nothing new, collect running lanes, update the ledger.

Set the ledger's State on every terminal state. After any but Done, write the ledger's Next section with what `handoff` asks for (verified, not verified, the single safest next action), in the ledger and not in a separate file, so a new session can resume from that file alone. Each state ends with the report.

## Guardrails

- Outward actions happen only within the authority. Approval in one place does not carry over to the next. After Done, merging `orchestrate/<slug>` into the user's branch uses `dispatch`'s Integrate commands, and pushing or opening a PR goes through `pr-workflow`, each step with the user's ok.
- The git stash stack is shared across worktrees: never run a bare `git stash` or `git stash pop`.
- Clean up only what you created, as `dispatch` describes. Lane branches are merged into `orchestrate/<slug>`, not into the user's branch: remove a lane's worktree first, then run `git branch -d` for its branch from the integration worktree; anywhere else `-d` refuses it. If that worktree is already gone, confirm each branch with `git merge-base --is-ancestor <branch> orchestrate/<slug>` before `git branch -D`. Then remove the integration worktree and the temporary directories. Keep the branch `orchestrate/<slug>` and list it in the report until the user has merged or dropped it.

## Report

Use the workspace final report and add:

- the terminal state and the ledger path;
- `dispatch`'s Output for each slice;
- decisions asked and answered;
- what is left running or uncleaned, and why.

## Harness notes

### Claude Code

- Write lanes: the Agent tool with the `general-purpose` type, in the background, with its `model` parameter when the caps name a model. `isolation: "worktree"` works on the session's own repository and starts from the remote default branch, or from your HEAD when the `worktree.baseRef` setting is `head`, never from a branch you name. Use it only when that is the charter's repository and base; otherwise, and for every lane that needs `orchestrate/<slug>`, add the worktree yourself and give its path.
- Follow-up briefs go to the same lane with SendMessage, which keeps its context.
- Read-only lanes: `repo-scout`, `inspector` and `sentinel`, or `/code-review` for a review pass. The three have no shell and stop after 12 turns, so write the diff to a file outside the repository, give them its path, and split a large diff across several reviewers.

### Codex

- Lanes: Codex subagents, each told to work only in a worktree you added. In a non-interactive run, an action that needs approval fails back to you.
- The sandbox may refuse git metadata writes (`git worktree add`, merges, a ledger in the git directory): ask for that approval at the start.
- `agents.max_concurrent_threads_per_session` caps open threads: keep the lane cap within it and close each collected lane's thread.
- Read-only lanes: `repo_scout`, `inspector` and `security_reviewer`.

### OpenCode

- As Riggverk's architect you may start only `explore`, `repo-scout`, `inspector`, `sentinel`, `scribe` and `verifier`, and none of them takes a code slice, so write lanes go through external CLIs with `dispatch`'s recipes. `git worktree`, `git merge` and those CLIs each ask for approval: say so at the start.
- The read-only agents cannot run a ranged `git diff`, so write the range diff to a file and give them its path; the redirect and a read outside the repository ask too.
- The architect's limit of 100 steps can end a long run before the goal: keep the ledger current so a new session can resume.

### Cursor

- Lanes: Cursor's own subagents; several Task calls in one message run in parallel. Ask for a worktree per write lane, or give it the path of one you added.
- Read-only lanes: `repo-scout`, `inspector` and `security-reviewer`.

### Light harnesses

- Copilot, Pi, Kilo, Antigravity and Grok usually have no subagents. Use external CLI lanes whose `dispatch` preflight passes. With none, say so and ask whether to do the slices yourself.
