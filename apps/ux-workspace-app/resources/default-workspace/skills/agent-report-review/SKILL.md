---
name: agent-report-review
description: Review a coding agent final report for completeness, verification quality, risk, missing checks, and the safest next prompt or action.
---

# Agent Report Review

## Purpose

- Evaluate executor reports before trusting them.
- Identify missing verification, scope drift, weak claims, and safe next steps.
- Support role separation between executor and reviewer.

## Process

1. Read the final report and any provided diff, commands, screenshots, or logs.
2. Extract stated goal, files changed, commands run, verification results, and remaining risk.
3. Check whether the report proves the requested behavior.
4. Flag claims that are unsupported, ambiguous, or too broad.
5. Identify missing checks and whether they are blocking.
6. Recommend one next action: accept, ask for verification, request fix, revert, or run a follow-up slice.

## Output

- Summary.
- What is verified.
- What is not verified.
- Scope drift, if any.
- Risk level.
- Recommended next action.
- Follow-up prompt if needed.

## Guardrails

- Do not accept "looks good" without evidence.
- Do not demand exhaustive audits for low-risk changes.
- Do not claim commands passed unless shown.
- Do not rewrite the executor report unless asked.
