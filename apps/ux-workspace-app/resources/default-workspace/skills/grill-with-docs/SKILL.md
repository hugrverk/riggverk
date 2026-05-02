---
name: grill-with-docs
description: Stress-test a plan against repo docs and capture confirmed decisions before implementation.
disable-model-invocation: true
---

# Grill With Docs

Use repo docs as context, not as ceremony. Update docs only after the user confirms the decision.

## Process

1. **Inspect existing context.**
   - Read relevant `AGENTS.md`, `docs/agents/`, `CONTEXT.md`, `CONTEXT-MAP.md`, and ADR files if present.
   - Read code only where it can answer a question directly.

2. **Summarize the current understanding.**
   - Plan in 2-4 bullets.
   - Existing terminology or decisions that constrain it.
   - Known gaps.

3. **Ask bounded questions.**
   - Ask max 5-8 high-value questions.
   - Include a recommended default for each.
   - Prefer questions that affect architecture, data, scope, risk, or verification.

4. **Resolve terminology.**
   - Call out conflicts between the user's language and existing docs.
   - Propose one canonical term when language is fuzzy.

5. **Document only confirmed changes.**
   - Ask before editing docs.
   - Update `CONTEXT.md` for stable domain terms.
   - Offer an ADR only for decisions that are hard to reverse, surprising without context, and based on a real tradeoff.

## Output

- Decision summary.
- Confirmed doc updates, if any.
- Open questions.
- Suggested next implementation step.
