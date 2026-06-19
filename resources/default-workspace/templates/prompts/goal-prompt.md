# Goal Prompt Template

Use for a bounded autonomous loop toward one stated goal.

Return a brief note only when needed, then one clean copy/paste prompt block capped at 4000 characters. The prompt block must contain executable agent instructions only.

```text
You are working in:

<absolute path or repository>

Goal:
<one stated goal>

Use <skill-a>, <skill-b>, and <skill-c> as executable workflow guidance when relevant.

Loop:
- Run a bounded Goal Prompt loop with max 5 iterations by default.
- Do not exceed 7 iterations unless the user explicitly overrides that cap.
- In each iteration, inspect repo reality, choose the next smallest coherent slice, patch only that slice, run the narrowest useful verification, and commit only if the slice is coherent and verified.
- Use one coherent verified iteration per commit unless the slice is docs-only or report-only.

Hard rules:
- Inspect repository reality and relevant local docs before edits.
- Stop and report evidence for ambiguity, owner decision, risky architecture, DB/migration work, production deploy, payment/auth/security uncertainty, failing baseline, unavailable verification, or no high-confidence next issue.
- Do not inspect or print secrets, credentials, tokens, cookies, private URLs, .env files, key files, or unrelated personal files.
- Do not claim verification unless commands were run.

Final report:
- Commits made
- Files changed
- Verification commands and results
- Verification not run
- Remaining risks
- Safest next action
```
