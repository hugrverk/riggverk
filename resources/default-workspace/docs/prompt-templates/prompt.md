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
- <relevant prior decision>

Scope:
- <included work>
- <included work>

Non-goals:
- <excluded work>
- <excluded work>

Hard rules:
- Inspect repository reality and relevant local docs before edits.
- Do not inspect or print secrets, credentials, tokens, cookies, private URLs, .env files, key files, or unrelated personal files.
- Use English for code, comments, filenames, docs, and commits.
- Use Swedish only for Swedish user-facing product copy.
- Keep the diff small and bounded.
- Stop and report if scope expands beyond one bounded task.
- Do not claim verification unless commands were run.

Tasks:
1. Inspect current state.
2. Diagnose or plan the smallest safe change.
3. Implement or audit only the scoped work.
4. Verify with the narrowest useful check.
5. Commit only if requested and verification passes.

Final report:
- Changed or Finding
- Verified
- Not verified
- Risk
- Next
```

Notes:
- Before constructing the prompt, inspect the active Agent Workspace standards (`docs/AGENT_RULES.md`, `docs/SKILLS.md`, `docs/WORKFLOWS.md`) and relevant project defaults.
- Weave exact skill names into executable instructions, not labels.
- Remove unused sections before sending.
- Use exact files, paths, commands, symbols, and routes when known.
- Avoid vague instructions without acceptance criteria.
