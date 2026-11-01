---
name: handoff
description: Turns a session or an executor or subagent report into a compact, redacted handoff with verified versus claimed state, changed files, risks, and the single safest next action. Use when pausing work, transferring context, reviewing another agent's report, or nearing the context limit.
license: MIT
metadata:
  category: workflow
  risk: low
  targets: codex, opencode, claude, cursor, copilot, pi, kilo, antigravity, grok
  related: diagnose, implementation-plan, release-check
  source: https://github.com/mattpocock/skills (handoff, MIT)
---

# Handoff

Done when: a fresh agent could execute the next action without reading the session, and every Verified line cites a command, file, or diff.

## Process

1. Extract the goal, current state, changed files, commands run, results, blockers, and stated risks. In a git repository, start from `git status --short`, `git log --oneline -8` and `git diff --stat`, each piped through `head -c 2000`, instead of recalling them.
2. Separate verified facts from unsupported claims, assumptions, and checks not run. A line without a cited command, file, or diff belongs under Not verified.
3. Decide the safest next action:
   - accept
   - verify
   - fix
   - revert
   - continue with a bounded slice
4. Reference existing commits, diffs, docs, issues, and reports instead of duplicating them.
5. Redact secrets, tokens, passwords, auth headers, and personal data from everything you write or quote.
6. Produce a compact handoff that another agent can act on without rereading the full session. When it is written to a file, save it in the OS temporary directory, not the workspace.

## Output

- Current state
- Changed files or existing artifacts
- Verified
- Not verified
- Risks and blockers
- Next action
- Relevant skills

Do not invent verification, hide uncertainty, repeat long source material, or demand exhaustive checks without risk justification.

## Harness notes

### Claude Code

Claude Code runs the commands below when the skill loads. Other harnesses show them as plain text and run the commands of step 1 themselves.

Repository state captured when this skill loaded:

- Status: !`git status --short 2>/dev/null | head -c 1200`
- Recent commits: !`git log --oneline -8 2>/dev/null | head -c 800`
- Diff stat: !`git diff --stat 2>/dev/null | tail -4`

Use this as starting evidence for Verified/Not verified instead of running step 1 again.
