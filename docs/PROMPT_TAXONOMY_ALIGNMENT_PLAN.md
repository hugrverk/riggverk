# Prompt Taxonomy Alignment Plan

## Objective

Align Agent Workspace prompt generation, bundled prompt templates, docs, registry entries, and guards with the current ux-context prompt contract:

- Prompt = one bounded task/fix/audit/review.
- Goal Prompt = bounded autonomous loop toward one stated goal, with a copy/paste prompt block capped at 4000 characters.
- Batch Prompt = autonomous multi-commit run for many independent items.
- Prompt output = brief note only when needed, then one clean copy/paste prompt block.
- Prompt block = executable agent instructions only.
- No operator metadata or routing-only notes.
- Routing, risk, DB/migration, branch, and skill guidance belongs inside the prompt only when relevant to execution.
- DB/migration constraints must be executable instructions, not labels.

## Constraints

- Use repository reality as source of truth before edits.
- Keep the diff small and reviewable; do not rename internal `promptLoops` files/directories unless required.
- Remove the visible `Masterprompt` concept from UI, docs, templates, and generated prompt text.
- Do not preserve old operator metadata fields such as `Recommended executor`, `Recommended target`, `DB push`, `Migration`, `Branch`, or `Risk/cost notes` as a required output scaffold.
- Keep skill names exact and executable in prompt instructions when relevant.
- Do not change harness installation behavior, managed ownership, or security boundaries except for registry/doc paths needed by prompt-template alignment.
- Do not update generated adapters unless a touched source requires it.

## Implementation phases

### Phase 1 — Runtime Prompt Builder alignment

Update the app prompt template source and validation logic.

Files likely involved:

- `src/tools/promptLoops/data.ts`
- `src/tools/promptLoops/types.ts`
- `src/tools/promptLoops/validateTemplates.ts`
- `src/tools/promptLoops/PromptLoopsTool.test.tsx`

Required changes:

- Replace prompt groups with `Prompt`, `Goal Prompt`, `Batch Prompt`, and `Rewrite`.
- Replace group keys with stable modern keys such as `prompt`, `goal-prompt`, `batch-prompt`, and `rewrite`.
- Replace all `standardprompt`, `masterprompt`, and old metadata language in prompt text.
- Add a `Goal Prompt` start/verify/merge or review flow that enforces:
  - max 4000 characters for the copy/paste prompt block
  - default max 5 iterations, hard cap 7 unless explicitly overridden
  - one coherent verified iteration per commit unless docs-only/report-only
  - stop conditions for ambiguity, owner decision, risky architecture, DB/migration, production deploy, payment/auth/security uncertainty, failing baseline, unavailable verification, or no high-confidence next issue
- Update rewrite prompts to classify old prompts into `Prompt`, `Goal Prompt`, or `Batch Prompt`.
- Update validators to reject stale strings and require the modern contract.
- Add/adjust tests so prompt groups and template checks fail if old operator metadata or `masterprompt` wording returns.

Acceptance:

- Prompt Builder generated prompts no longer ask for operator metadata.
- Prompt Builder no longer exposes `Masterprompt` as a group or recommendation.
- Goal Prompt templates include the 4000-character cap.
- Template validation fails on stale `Operator metadata`, `Recommended executor`, `Recommended target`, or visible `masterprompt` contract text.

Suggested verification:

```bash
npm test -- src/tools/promptLoops/PromptLoopsTool.test.tsx
bash scripts/run-ts-check.sh scripts/check-prompt-loops-templates.ts
npm run typecheck
```

If `scripts/run-ts-check.sh` is unavailable or unsuitable, inspect package scripts and run the equivalent repository check. Do not claim it passed unless it was run.

### Phase 2 — Bundled prompt-template docs and registries

Align bundled workspace docs/templates and all registry/check references.

Files likely involved:

- `resources/default-workspace/docs/prompt-templates/standard-prompt.md`
- `resources/default-workspace/docs/prompt-templates/masterprompt.md`
- `resources/default-workspace/docs/prompt-templates/batchprompt.md`
- `resources/default-workspace/templates/prompts/standard-prompt.md`
- `resources/default-workspace/templates/prompts/masterprompt.md`
- `resources/default-workspace/README.md`
- `src-tauri/src/commands/content.rs`
- `src-tauri/src/commands/default_workspace_manifest.rs`
- `scripts/check-default-workspace-copy-list.py`
- `scripts/release-check.sh`

Required changes:

- Prefer renaming docs/templates to modern names when feasible:
  - `standard-prompt.md` -> `prompt.md` or retitle as `Prompt Template`
  - `masterprompt.md` -> `goal-prompt.md`
  - `batchprompt.md` -> `batch-prompt.md` or retitle as `Batch Prompt Template`
- If renaming is too broad, keep filenames but fully update titles, contents, registry labels, and checks so no user-facing stale contract remains.
- Replace all operator metadata scaffolds with a clean prompt-block-only pattern.
- Ensure Goal Prompt docs/templates state the 4000-character copy/paste prompt block cap.
- Update manifest, curated docs registry, copy-list checks, and release-check prompt-template paths/titles to match the chosen file names.
- Preserve the existing rule that docs/skills/agents are user-owned in installed workspaces and are not managed-refresh overwritten.

Acceptance:

- Library docs show modern Prompt, Goal Prompt, and Batch Prompt templates.
- Bundled manifest and copy-list checks agree with the updated paths.
- Release-check no longer requires `masterprompt.md`.
- No bundled prompt template asks for operator metadata.

Suggested verification:

```bash
python3 scripts/check-default-workspace-copy-list.py
python3 scripts/check-curated-library-docs.py
npm run typecheck
```

### Phase 3 — User-facing polish

Only after phases 1 and 2 pass, update user-facing labels if still stale.

Likely changes:

- Consider renaming visible app surface copy from `Prompt Loops` to `Prompts` or `Prompt Builder`.
- Update `README.md` application-surface copy.
- Keep internal `promptLoops` paths/classes unless a rename is already necessary.

Acceptance:

- User-facing copy no longer implies `Prompt Loops` is a separate deprecated workflow if the screen is now a prompt builder.
- No broad UI rewrite.

Suggested verification:

```bash
npm test -- src/tools/promptLoops/PromptLoopsTool.test.tsx
bash scripts/check-ui-regressions.sh
npm run typecheck
```

## Global stop conditions

Stop and report instead of guessing if:

- repo reality differs from this plan in a way that changes scope materially
- a file rename requires complex migration or installed-workspace overwrite behavior
- tests reveal unrelated failures before changes
- release-check guards conflict with the intended taxonomy and the correct contract is unclear
- the change would require touching auth, secrets, install destinations, or unrelated harness config

## Final report requirements

Report:

- commits made
- files changed
- stale terms removed or intentionally preserved with reason
- verification commands run and results
- verification not run and why
- remaining risks
- safest next action
