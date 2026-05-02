---
name: triage
description: Lightweight solo-developer issue review. Use when the user wants to review, classify, prioritize, or prepare an issue before implementation.
---

# Triage

Turn an issue or request into a clear next action.

## Process

1. **Read context.**
   - Issue body, comments, linked docs, screenshots, logs, and relevant code.
   - Existing labels or repo guidance if present.

2. **Summarize.**
   - Problem or request in 1-3 bullets.
   - Evidence available.
   - Missing information.

3. **Classify.**
   - `bug`: documented behavior is broken.
   - `enhancement`: new or improved behavior.
   - `chore`: maintenance, cleanup, docs, tooling, or dependency work.

4. **Recommend next action.**
   - `ready`: enough context to implement.
   - `needs-info`: specific missing facts block work.
   - `needs-design`: product or architecture decision needed.
   - `decline`: not worth doing or outside scope.

5. **Draft execution brief when useful.**
   - Goal.
   - Constraints.
   - Relevant files or modules.
   - Acceptance criteria.
   - Verification command or manual check.

## Output

- Summary.
- Classification.
- Recommended next action.
- Execution brief, if useful.
- Open questions.

Only add public disclaimers if posting AI-generated text to a public tracker.
