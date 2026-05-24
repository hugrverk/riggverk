# Batchprompt Template

Use for long autonomous multi-commit work only (8–10+ independent items, ideally one commit per completed item).

Prefer `templates/standard-prompt.md` for one bounded task and `templates/masterprompt.md` for smaller multi-slice work.

Operator metadata, outside the copy-safe prompt block:

Recommended target: <model or tool>
DB/migration: <YES|NO|POSSIBLE>
Token/audit warning: <Low|Medium|High>
Cost/risk note: <optional>
Branch policy: <branch / base / push / PR rules>
Commit policy: one completed item = one commit by default; hard cap 20 commits unless explicitly overridden

Copy-safe prompt block:

TEXT_BLOCK_START
You are working in:

<absolute path or repository>

Use the <skill-a>, <skill-b>, <skill-c> skills.

Goal:
<one sentence for the whole batch>

Context:
- <relevant project/context fact>
- <relevant constraint>
- <relevant prior decision>

Global scope:
- <included work across the batch>
- <included work>

Global non-goals:
- <excluded work>
- <excluded work>

Hard rules:
- Intended for 8–10+ independent items; target 10–15 items; hard cap 20 commits unless explicitly overridden.
- One completed item = one commit by default.
- Every item must be independently useful, verifiable, and reversible.
- Blocked items: mark BLOCKED with evidence, then continue with the next independent item.
- Global stop conditions stop the entire run (do not continue the batch).
- No silent fix-forward: later fixes get separate fix commits, or stop the run if earlier commits are invalidated.
- No unrelated opportunistic cleanup.
- High-risk items should be isolated or skipped unless explicitly scoped and gated in the batch plan.
- Do not inspect or print secrets, credentials, tokens, cookies, private URLs, .env files, key files, or unrelated personal files.
- Use English for code, comments, filenames, docs, and commits.
- Use Swedish only for Swedish user-facing product copy.
- Keep each item small, bounded, and aligned with repo patterns.
- Do not claim verification unless commands were run.

Before editing:
1. Report branch, starting commit, and git status.
2. Inspect relevant files and repo layout.
3. State whether DB/migration work is needed for the batch.
4. Produce initial inventory and batch ledger (below); do not start item work until both are stated.

Initial inventory:
- Branch: <name>
- Starting commit: <hash>
- Key paths / surfaces in scope: <list>
- DB/migration for batch: <YES|NO|POSSIBLE>
- Verification tools available: <tests, lint, typecheck, manual routes, etc.>
- Known risks or blockers: <list or none>

Batch ledger:
| # | Item (short) | Risk | Type | Status |
| --- | --- | --- | --- | --- |
| 1 | <title> | Low/Medium/High | <type> | pending |
| 2 | <title> | Low/Medium/High | <type> | pending |

Item format (repeat per item; copy scaffold for each ledger row):

Item <n>: <short name>

Risk: Low | Medium | High
Type: docs | UI | behavior | refactor | test | migration | security | other

Scope:
- <included work for this item only>

Non-goals:
- <excluded work>

Files:
- <path>
- <path>

Acceptance:
- <observable done criteria>

Verification:
- <narrow command or manual check for this item>

Commit:
- <Do not commit until item verification passes.>
- Message: <type(scope): subject>

Fallback:
- If blocked: mark BLOCKED in ledger with evidence; do not commit partial work for this item; continue to next item unless a global stop condition applies.
- If high risk and not explicitly scoped: skip with reason in ledger.

Verification gates (layered):
- Per item: run narrow verification before each commit.
- Every 3–5 commits: run a broader gate (lint, test subset, typecheck, or agreed smoke checks).
- Before final report: run final verification gate on the cumulative diff since starting commit.

Commit behavior:
- Complete item → verify → commit → update ledger to done.
- Do not batch multiple items into one commit unless explicitly overridden in operator metadata.
- Fix commits for prior items are separate items/commits; never amend away evidence of a bad item without explicit instruction.

Blocked item behavior:
- Record BLOCKED, evidence, and what was tried.
- Do not leave uncommitted half-finished work for blocked items unless explicitly asked to park WIP.
- Continue with the next independent item.

Global stop conditions (stop entire run and report):
- Evidence contradicts the batch plan or repo reality in a way that invalidates remaining items.
- A commit would break earlier items without a planned fix item.
- Security, data-loss, or migration risk discovered outside scoped items.
- Verification gate failure that indicates systemic breakage, not a single-item issue.
- Hard commit cap reached.
- User-defined stop: <optional>

Item 1: <name>

Risk: <Low|Medium|High>
Type: <type>

Scope:
- <included work>

Non-goals:
- <excluded work>

Files:
- <path>

Acceptance:
- <criteria>

Verification:
- <command or check>

Commit:
<type(scope): subject>

Fallback:
- <blocked/skip conditions>

Item 1 report:
- Status: done | blocked | skipped
- Commit: <hash or none>
- Changed
- Verified
- Not verified
- Risk

<Repeat Item 2 … Item N with the same scaffold.>

Final report:
- Branch
- Starting commit
- Ending commit
- Commits made, in order: <hash + message list>
- Items completed: <list>
- Items skipped or blocked: <list with evidence>
- Files changed by area: <summary>
- Verification run: <commands and results>
- Verification not run: <gaps>
- Regressions or risks: <list>
- DB/migration status: <YES|NO|POSSIBLE and what was done>
- Recommended next batch: <optional>
TEXT_BLOCK_END

Notes:
- Before constructing this prompt, inspect `memory.md`, `templates/`, and relevant project defaults. Weave selected skills into executable instructions, not just metadata.
- Replace TEXT_BLOCK_START and TEXT_BLOCK_END with a real fenced code block when using the template.
- Batchprompt is a prompt contract / execution mode, not a skill.
- Remove unused sections before sending.
- Keep operator metadata outside the prompt block.
- Use exact files, paths, commands, symbols, and routes when known.
