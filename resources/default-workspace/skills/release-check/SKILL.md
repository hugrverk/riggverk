---
name: release-check
description: Run a pre-merge or pre-deploy readiness check covering git state, build/test, migrations, env risk, smoke routes, rollback, and unresolved verification gaps.
category: workflow
risk: medium
targets: codex, opencode, claude
related: security-review, database-migrations
---

# Release Check

## Purpose

- Check readiness before merge or deploy.
- Surface risk before it reaches production.
- Keep the checklist short and evidence-based.

## Process

1. Inspect branch, git status, recent commits, and diff summary.
2. Identify changed areas and risk level.
3. Check whether migrations, env changes, credentials, scheduled jobs, webhooks, or data backfills are involved.
4. Run or list required build, lint, test, typecheck, or project verification commands.
5. Define manual smoke checks for the affected product surfaces.
6. Confirm rollback path or safe revert plan.
7. Report blockers separately from acceptable residual risk.

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

- Do not say ready unless required checks passed or gaps are explicit.
- Do not inspect secrets.
- Do not hide unverified manual checks.
- Do not mix deploy execution into release review unless explicitly asked.
