---
name: orchestrate
description: Leads agents toward a goal with a charter, a ledger that survives context loss, risk-routed lanes and lead-verified reports. Use when the user asks to orchestrate, never unasked.
license: MIT
compatibility: Needs git and either write-capable subagents in the current harness or another coding-agent CLI with a headless mode (Codex, Claude Code, OpenCode).
metadata:
  category: workflow
  risk: high
  targets: codex, opencode, claude, cursor, copilot, pi, kilo, antigravity, grok
  related: delegate, implementation-plan, zoom-out
---

# Orchestrate

You are the lead. You drive a goal to done through other agents: you plan, route, verify, integrate and decide; they do bounded slices. `delegate` hands slices to other agents (one or several, with no charter or ledger); this skill is the goal-driven loop around them. Agents' reports are claims, never evidence, and the goal is a verified result, not a busy fleet.

Done when: every done criterion in the charter is met and verified by your own checks, or the loop stopped at a terminal state below; the ledger is current; every worktree and branch you created is integrated, removed or listed for the user; and the report is given.

## When

Only when the user asks for it: "orchestrate this", "lead agents toward X", "run subagents until Y is done", or `/orchestrate <goal>`. Never start a fleet on your own initiative. A "do it yourself" from the user wins. This skill needs `delegate`; if it is not installed, say so and stop.

## Charter

Before any agent starts, write the charter as the first section of the ledger:

- **Goal**: the outcome in one or two sentences.
- **Done criteria**: checks that can fail, such as commands that must pass, behaviour to observe, files that must exist. "Looks good" is not one.
- **Scope**: what is in and out.
- **Authority**: what you may do without asking, taken from the user's words and rules. Default: commit and merge on your own branches only. Merging into the user's branch, pushing, releasing, publishing, changing settings, sending messages and deleting anything you did not create each need the user's yes unless the user's words or rules grant it.
- **Caps**: how many agents may run at once and which models may be used, from the user's words or rules. With none: two agents at a time in total, on their configured default models.
- **Budget**: time or cost limit, if the user gave one.

Ask one question up front only if the done criteria or the authority are unclear. Then say in chat, in a few lines, the goal, the authority, the caps and the ledger path.

## Ledger

One Markdown file that lets you, or a new session, resume after context loss. Put it where the user says. Otherwise put it at a path that `git check-ignore` confirms is ignored and that no build or clean step wipes. With neither, ask. Never use the OS temp directory, which a restart can clear.

Sections: Charter; Slices (id, files owned, acceptance checks, depends on, risk, status, lane); Lanes (route, model, worktree, branch, started, ended); Decisions (asked, answer, when); Findings (verified, unproven, rejected, with evidence); Log (one dated line per event); Next.

Update it after every event: a lane starts or ends, a check runs, a decision arrives, the plan changes. Record a lane's worktree and branch as soon as you know them. It holds no secrets, and only names variables, never their values.

**Resume.** Read the ledger first. Treat every lane without an end entry as dead: find its worktree with `git worktree list`, collect it as `delegate` describes, then re-brief or finish the slice.

## Loop

1. **Map.** Read the owning code and docs, or send read-only agents to map wide areas (`zoom-out`).
2. **Slice.** Break the goal into slices with `implementation-plan`. Every slice owns a disjoint set of files and has its own acceptance checks. Two slices that touch the same file run one after the other.
3. **Route by risk.**
   - **The lead keeps**: decisions, root-cause diagnosis, security judgement, releases and other outward actions, integration, and final verification.
   - **Critical** implementation (data, persistence formats, public contracts): the lead does it, or a lane on the model the user's rules name for critical work. Use `adversarial-implementation` when the user asked for critic review.
   - **Mechanical** (renames, codemods, boilerplate, docs sweeps): a lane on the route `delegate` resolves.
   - **Review or research**: fresh read-only agents.
4. **Dispatch.** Start lanes up to the caps, each with a `delegate` brief in its own worktree.
5. **Collect and verify** each lane as `delegate` describes, and run the acceptance checks yourself. A review finding counts only when you reproduce it; log the rest as unproven and do not act on them.
6. **Integrate** into `orchestrate/<slug>`, a branch you create from the base in your own worktree. Merge one lane at a time and run the checks after each. A conflict means the slices were not disjoint, so fix the plan, not just the merge. A lane that needs integrated work gets a worktree you add from `orchestrate/<slug>`. No integration runs while an adversarial slice is mid-round. Merging `orchestrate/<slug>` into the user's branch is an outward action.
7. **Re-plan.** After each integration, compare the ledger with what you now know. When evidence contradicts the plan, stop dispatching and re-slice.
8. **Decide.** Batch questions when a decision blocks a lane or crosses the authority. Use the harness's question tool when it has one, with the recommended option first and each question readable on its own. Keep unblocked lanes running while you wait.

While lanes run, wait for their notifications instead of polling, and spend the time on lead work: verify finished lanes, prepare the next briefs, update the ledger. Tell the user at milestones (a slice landed, a decision needed, a terminal state), not at every event.

## Terminal states

- **Done**: every done criterion verified by you.
- **Blocked**: every remaining slice waits on the user, so ask once with all of it.
- **Budget**: the time or cost limit is reached.
- **Stagnation**: two dispatch rounds in a row with nothing integrated, or the same failure twice. Escalate with the evidence.
- **Stopped**: the user said stop. Start nothing new, collect running lanes, update the ledger.

Each state ends with the report.

## Guardrails

- Outward actions happen only within the authority. Approval in one place does not carry over to the next.
- The git stash stack is shared across worktrees: never run a bare `git stash` or `git stash pop`.
- Clean up only what you created, as `delegate` describes.

## Report

Use the workspace final report (Changed, Verified, Not verified, Risk, Next) and add:

- the terminal state and the ledger path;
- `delegate`'s Output for each slice;
- decisions asked and answered;
- what is left running or uncleaned, and why.

## Harness notes

### Claude Code

- Lanes: the Agent tool in the background, with `isolation: "worktree"` for write lanes and read-only agent types for review and mapping. Send independent launches in one message. You do not choose the base of an `isolation` worktree (it has started from the default branch), so a lane that must start from `orchestrate/<slug>` gets a worktree you add yourself, given by path.
- If the `advisor` tool is available, call it after writing the charter and slices, before re-slicing on contrary evidence, and before declaring a terminal state.

### OpenCode

- The `explore`, `repo-scout`, `inspector`, `sentinel` and `scribe` roles have no shell. Include the diff or changed-file list in their prompt when needed.
- Riggverk's architect may start only read-only roles, so start write lanes through the `delegate` skill using external CLIs. Its step limit can end a long run before the goal: say so at the start, and keep the ledger current so a new session can resume.

### Light harnesses

- Copilot, Pi, Kilo and Grok usually have no subagents. Start external CLI lanes through the `delegate` skill. With none, say so and ask whether to work through the slices yourself, one at a time, which is not orchestration.
- Antigravity has built-in subagents: `research` for mapping and review, and `self` in its own worktree (the `branch` workspace option) for write lanes. External CLI lanes through the `delegate` skill work too.
