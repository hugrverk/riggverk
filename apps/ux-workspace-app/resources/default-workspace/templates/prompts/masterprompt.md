# Masterprompt Template

Use for multi-slice work only.

Operator metadata, outside the copy-safe prompt block:

Recommended target: <model or tool>
DB/migration: <YES|NO|POSSIBLE>
Token/audit warning: <Low|Medium|High>
Cost/risk note: <optional>

Copy-safe prompt block:

TEXT_BLOCK_START
You are working in:

<absolute path or repository>

Use the <skill-a>, <skill-b>, <skill-c> skills.

Goal:
<one sentence>

Context:
- <relevant project/context fact>
- <relevant constraint>
- <relevant prior decision>

Global scope:
- <included work>
- <included work>

Global non-goals:
- <excluded work>
- <excluded work>

Hard rules:
- Do not inspect or print secrets, credentials, tokens, cookies, private URLs, .env files, key files, or unrelated personal files.
- Use English for code, comments, filenames, docs, and commits.
- Keep each slice independently useful and verifiable.
- Stop and report if evidence contradicts the plan.
- Do not claim verification unless commands were run.

Before editing:
1. Report branch and git status.
2. Inspect the relevant files.
3. State whether DB/migration work is needed.
4. State the planned slices.

Slice 1: <name>

Goal:
<slice goal>

Scope:
- <included work>

Non-goals:
- <excluded work>

Files to inspect or change:
- <path>
- <path>

Implementation:
- <step>
- <step>

Verification:
- <command>
- <manual check>

Commit:
<Do not commit.>
or
<Commit this slice if verification passes with: type(scope): subject>

Slice 1 report:
- Changed
- Verified
- Not verified
- Risk
- Next

Slice 2: <name>

Goal:
<slice goal>

Scope:
- <included work>

Non-goals:
- <excluded work>

Files to inspect or change:
- <path>
- <path>

Implementation:
- <step>
- <step>

Verification:
- <command>
- <manual check>

Commit:
<Do not commit.>
or
<Commit this slice if verification passes with: type(scope): subject>

Slice 2 report:
- Changed
- Verified
- Not verified
- Risk
- Next

Final report:
- Branch
- Slices completed
- Files changed
- Commands run
- Verification result
- Not verified
- Remaining risk
- Suggested next step
TEXT_BLOCK_END

Notes:
- Replace TEXT_BLOCK_START and TEXT_BLOCK_END with a real fenced code block when using the template.
- Add more slices only when needed.
- Keep slices small enough to verify independently.
- Do not bury risky changes inside a large slice.
- Prefer vertical slices over broad layer-by-layer rewrites.
- Keep operator metadata outside the prompt block.
