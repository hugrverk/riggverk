---
name: release-check
description: Runs a pre-merge or pre-deploy gate with the repo's canonical release script, git state, build and test, migration and env risk, smoke routes, rollback plan, and a go/no-go verdict. Use when asked whether a branch is ready to merge, release, or deploy.
category: workflow
risk: medium
targets: codex, opencode, claude, cursor
related: security-review, database-migrations
context: fork
agent: verifier
background: false
allowed-tools: Bash(git status *) Bash(git log *) Bash(git diff *) Bash(head *) Bash(tail *)
---

# Release Check

Keep the gate short and evidence-based.

Done when: every required check is run or listed with a reason, blockers are separated from residual risk, and a go/no-go verdict is given.

## Process

1. Discover the repo's canonical release gate (`./scripts/release-check.sh`, `npm run verify`, CI workflow, Makefile target) and prefer running it over composing an ad-hoc list.
2. Inspect branch, git status, recent commits, and diff summary.
3. Identify changed areas and risk level.
4. Check whether migrations, env changes, credentials, scheduled jobs, webhooks, or data backfills are involved.
5. Run or list required build, lint, test, typecheck, or project verification commands not covered by the canonical gate.
6. Define manual smoke checks for the affected product surfaces.
7. Confirm rollback path or safe revert plan.
8. Report blockers separately from acceptable residual risk.

## Output

- Release scope.
- Git state.
- Commands run and results.
- Manual checks run or required.
- Migration/env risk.
- Rollback plan.
- Blockers.
- Go/no-go recommendation.

## Guardrails

- Do not say ready unless required checks passed or gaps are explicit. Verdict is no-go if any required check failed, or was not run without a stated, accepted reason.
- Do not inspect secrets.
- Do not hide unverified manual checks.
- Do not mix deploy execution into release review unless explicitly asked.

## Harness notes

### Claude Code

Runs in a forked verifier context; report the full gate result back, not a summary of intent.

Claude Code runs the commands below when the skill loads; in other harnesses they appear as plain text, so run them yourself.

Repository state when this check loaded:

- Branch and status: !`git status --short --branch 2>/dev/null | head -c 1200`
- Recent commits: !`git log --oneline -10 2>/dev/null | head -c 800`
- Working diff: !`git diff --stat 2>/dev/null | tail -4`

### OpenCode

- Use Plan for the gate list, Build only for approved fixes, and Explore or repo-scout for read-only failure localization.
- Keep command output bounded and report skipped gates with the reason, not as passing evidence.
