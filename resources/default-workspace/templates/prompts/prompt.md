# Prompt Template

Use for one bounded implementation, audit, review, or fix.

Return a brief note only when needed, then one clean copy/paste prompt block. The prompt block must contain executable agent instructions only.

```text
You are working in:

<absolute path or repository>

Goal:
<one bounded task in one sentence>

Use <skill-a> and <skill-b> as executable workflow guidance when relevant.

Context:
- <relevant project/context fact>
- <relevant constraint>

Scope:
- <included work>

Non-goals:
- <excluded work>

Hard rules:
- Inspect repository reality and relevant local docs before edits.
- Do not inspect or print secrets, credentials, tokens, cookies, private URLs, .env files, key files, or unrelated personal files.
- Use English for code, comments, filenames, docs, and commits.
- Keep the diff small and bounded.
- Do not claim verification unless commands were run.

Tasks:
1. Inspect current state.
2. Diagnose or plan the smallest safe change.
3. Implement or audit only the scoped work.
4. Verify with the narrowest useful check.

Final report:
- Changed or Finding
- Verified
- Not verified
- Risk
- Next
```
