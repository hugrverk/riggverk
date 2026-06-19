# Batch Prompt Template

Use for autonomous multi-commit work across many independent items.

Return a brief note only when needed, then one clean copy/paste prompt block. The prompt block must contain executable agent instructions only.

```text
You are working in:

<absolute path or repository>

Goal:
<one sentence for the whole batch>

Use <skill-a>, <skill-b>, and <skill-c> as executable workflow guidance when relevant.

Context:
- <relevant project/context fact>
- <relevant constraint>
- <relevant prior decision>

Batch scope:
- <included work across independent items>
- <included work>

Non-goals:
- <excluded work>
- <excluded work>

Hard rules:
- Use this only when repo reality supports at least 5 real independent items.
- Create or confirm an appropriate branch before edits.
- Record starting git status and baseline checks.
- Maintain a batch ledger.
- Complete one independent verified item per commit by default.
- Run item-level verification before each commit.
- Run broader verification after 3 to 5 commits when justified.
- Stop and report evidence for failing baseline, DB/migration risk, repo reality conflict, security uncertainty, systemic verification failure, or lack of enough real independent items.
- Do not inspect or print secrets, credentials, tokens, cookies, private URLs, .env files, key files, or unrelated personal files.
- Do not claim verification unless commands were run.

Initial inventory:
- Branch:
- Starting commit:
- Key paths / surfaces:
- Verification tools:
- Known risks or blockers:

Batch ledger:
| # | Item | Risk | Status | Commit |
| --- | --- | --- | --- | --- |
| 1 | <title> | Low/Medium/High | pending | |
| 2 | <title> | Low/Medium/High | pending | |

Per item:
1. Restate item scope and non-goals.
2. Patch only that item.
3. Run narrow verification.
4. Commit only if verified.
5. Update the ledger.

Final report:
- Branch
- Starting commit
- Ending commit
- Commits made in order
- Items completed
- Items skipped or blocked with evidence
- Files changed by area
- Verification run
- Verification not run
- Regressions or risks
- Recommended next action
```

Notes:
- Before constructing the prompt, inspect the active Agent Workspace standards (`docs/AGENT_RULES.md`, `docs/SKILLS.md`, `docs/WORKFLOWS.md`) and relevant project defaults.
- Weave exact skill names into executable instructions, not labels.
- Use a Prompt for one bounded task. Use a Goal Prompt for one goal with dependent slices.
- Remove unused sections before sending.
