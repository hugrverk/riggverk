---
name: handoff
description: Use to compact long sessions, paused workflows, branch state, or agent chains into a useful handoff.
category: workflow
risk: low
targets: codex, opencode, claude, auggie
related: agent-report-review, release-check, implementation-plan
---

# Handoff

## Purpose

- Preserve useful state when work pauses, changes owner, or moves between agents.
- Compact long sessions without duplicating existing artifacts.
- Make the next action clear and verifiable.

## Process

1. Identify the handoff audience and immediate next action.
2. Reference existing PRDs, ADRs, issues, commits, diffs, reports, or docs by path or URL instead of duplicating them.
3. Separate verified facts from unverified claims or assumptions.
4. Summarize current state, changed files if known, blockers, risks, and open decisions.
5. Include commands already run and their results. Do not invent verification.
6. Recommend the next skills to use based on the remaining work.
7. Keep the handoff compact enough for a new agent to act without re-reading the full session first.

## Output

- Current state.
- Existing artifacts to read.
- Changed files, if known.
- Verified facts.
- Unverified claims or assumptions.
- Risks and blockers.
- Next action.
- Recommended next skills.

## Guardrails

- Do not duplicate long source material, reports, diffs, or docs already available by path or URL.
- Do not hide uncertainty.
- Do not claim tests, builds, screenshots, or reviews happened unless they actually did.
