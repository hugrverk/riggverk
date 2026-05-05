# Standard Prompt Template

Use for one bounded implementation, audit, review, or fix.

Operator metadata, outside the copy-safe prompt block:

Recommended target: <model or tool>
DB/migration: <YES|NO|POSSIBLE>
Token/audit warning: <Low|Medium|High>

Copy-safe prompt block:

TEXT_BLOCK_START
You are working in:

<absolute path or repository>

Use the <skill-a>, <skill-b> skills.

Goal:
<one sentence>

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
- Do not inspect or print secrets, credentials, tokens, cookies, private URLs, .env files, key files, or unrelated personal files.
- Use English for code, comments, filenames, docs, and commits.
- Keep the diff small and bounded.
- Do not claim verification unless commands were run.

Tasks:

1. Inspect current state

Run:

<commands>

Inspect:

<files or directories>

2. Diagnose or plan

- State the relevant current behavior.
- Identify root cause or affected surface.
- List files you plan to change and why.

3. Implement or audit

- <exact implementation or audit instruction>
- <exact implementation or audit instruction>

4. Verification

Run:

<commands>

Manual checks:

<routes, states, viewports, or flows>

5. Commit

<Do not commit.>
or
<Commit if verification passes with: type(scope): subject>

Final report:
- Changed or Finding
- Verified
- Not verified
- Risk
- Next
TEXT_BLOCK_END

Notes:
- Replace TEXT_BLOCK_START and TEXT_BLOCK_END with a real fenced code block when using the template.
- Remove unused sections before sending.
- Keep operator metadata outside the prompt block.
- Use exact files, paths, commands, symbols, and routes when known.
- Avoid vague instructions without acceptance criteria.
