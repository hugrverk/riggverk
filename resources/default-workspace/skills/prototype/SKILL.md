---
name: prototype
description: Use for throwaway prototype work before production implementation.
category: workflow
risk: low
targets: codex, opencode, claude, cursor
related: frontend-design, zoom-out, implementation-plan
---

# Prototype

## Purpose

- Validate an idea before production implementation.
- Explore UI variants, state-machine or data-model options, interaction behavior, or technical feasibility.
- Keep prototype code clearly separate from production decisions.

## Process

1. Define the throwaway boundary: what can be temporary, where it lives, and what must not be treated as production-ready.
2. State the question the prototype must answer.
3. Build the smallest runnable or inspectable version that answers that question.
4. Avoid persistence by default unless persistence is the thing being tested.
5. Capture visible state, tradeoffs, and the decision made from the result.
6. Provide one run command when the prototype is runnable.
7. End with a delete-or-absorb follow-up: remove the prototype, promote selected ideas into production work, or keep it only as a named reference.

## Output

- Prototype goal.
- Throwaway boundary.
- Files or commands used.
- Result and decision.
- Run command, if runnable.
- Delete-or-absorb follow-up.

## Guardrails

- Do not let prototype shortcuts leak into production code without review.
- Do not add durable storage, migrations, long-lived config, or external services unless that is the prototype target.
- Do not present unverified prototype behavior as production evidence.
