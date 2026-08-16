# Skills

The bundled default workspace contains **21 skills**: 21 canonical semantic skill sources. Source layout may be root-level (`skills/<skill>/SKILL.md`) or grouped one level deep (`skills/<group>/<skill>/SKILL.md`). Harness-specific adapters are generated under `templates/skills/<harness>/<skill>/SKILL.md`. Installed harness skills are always flat (`<harness-skill-root>/<name>/SKILL.md`).

Do not duplicate full `SKILL.md` content here. This file is an index for choosing the right skill.

## General Skills (16)

| Skill | Use When |
| --- | --- |
| `accessibility-review` | Reviewing UI for WCAG 2.2 AA risks, semantics, controls, keyboard, focus, labels, contrast, and responsive usability. |
| `browser-qa` | Verifying frontend changes with live browser checks, route smoke tests, interactions, responsive checks, console/network review, and evidence. |
| `context-budget` | Reducing duplicated rules, docs, prompts, skills, and token overhead without removing essential safety guidance. |
| `current-docs` | Checking official/current docs for version-specific APIs, SDKs, CLIs, config, hooks, or platform behavior. |
| `database-migrations` | Planning or reviewing schema/data changes with migration, rollback, and DB push reporting. |
| `diagnose` | Debugging bugs, failures, flakes, slowness, and regressions with a reproduce-to-regression-test loop. |
| `frontend-design` | Designing or improving frontend UI across repositories with coherent aesthetic direction, accessibility, and verification. |
| `handoff` | Reviewing executor evidence or compacting paused work into a trustworthy handoff with verified state and next action. |
| `implementation-plan` | Creating small verifiable implementation slices with exact files, steps, commands, and risks. |
| `minimal-implementation` | Implementing or refactoring with the smallest complete diff that fits existing ownership. |
| `prototype` | Validating throwaway UI variants, state-machine/data-model checks, and interaction experiments before production implementation. |
| `release-check` | Running pre-merge or pre-deploy readiness checks, including tests, migrations, env risk, smoke routes, and rollback. |
| `screenshot-review` | Reviewing supplied UI screenshots before implementation or for responsive/layout critique. |
| `security-review` | Reviewing auth, authorization, input, secrets, uploads, API endpoints, payments, shell execution, or sensitive data. |
| `tdd` | Using a narrow red-green-refactor loop for behavior changes, fixes, regressions, and tests. |
| `zoom-out` | Explaining unfamiliar code in broader system context before editing. |

## Shared Domain Skill (1)

| Skill | Use When |
| --- | --- |
| `wordpress-woocommerce` | Working on WordPress/WooCommerce themes, templates, hooks, filters, plugins, REST/AJAX, checkout/cart/product UI, security, i18n, and frontend integration. |

## Kretsverket Skills (4)

Grouped source: `skills/kretsverket/<skill>/SKILL.md`.

| Skill | Use When |
| --- | --- |
| `kretsverket-editor-change` | Changes cross Kretsverket editor layers: types, state, canvas, keyboard, selection, rendering, undo, persistence, export. |
| `kretsverket-file-compatibility` | `.krets` / `.kretsym` persistence, parsing, migrations, defaults, and untrusted imports. |
| `kretsverket-symbol-system` | Symbol Editor sandbox, definitions, instances, imports, nested symbols, anchors, and placed-instance updates. |
| `kretsverket-electrical-drawing` | Wire semantics, terminal bindings, crossings, references, and drawing-versus-netlist boundaries. |

## Routing boundaries

| Pair | Distinct roles |
| --- | --- |
| `diagnose` / `tdd` | Diagnose finds root cause; TDD locks behavior with a narrow test once the contract is clear. |
| `implementation-plan` / `minimal-implementation` | Plan defines slices; minimal-implementation executes one bounded patch. |
| `frontend-design` / `screenshot-review` | Screenshot-review diagnoses static images; frontend-design chooses direction and implements. |
| `frontend-design` / `accessibility-review` | Frontend-design includes baseline a11y during implementation; accessibility-review is a specialist audit. |
| `frontend-design` / `browser-qa` | Frontend-design owns visual direction; browser-qa supplies runtime verification evidence. |
| `handoff` / `release-check` | Handoff compacts session state; release-check validates merge/deploy readiness. |
| `security-review` / `sentinel` (agent) | Skill guides implementation-time review; sentinel agent performs read-only specialist security review. |
| `zoom-out` / repo-scout (agent) | Zoom-out explains code context in chat; repo-scout agent maps unfamiliar repos read-only before implementation. |
| Kretsverket quartet | `kretsverket-editor-change` (editor layers), `kretsverket-file-compatibility` (persistence), `kretsverket-symbol-system` (symbols), `kretsverket-electrical-drawing` (wiring semantics)—kept separate because triggers and invariants differ. |

## Common Combinations

- Bugs or regressions: `diagnose`; add `tdd` when a narrow regression test is useful.
- Code implementation: `minimal-implementation`; add `implementation-plan` for larger slices.
- Unfamiliar code: `zoom-out`, then `implementation-plan` if edits are needed.
- Frontend implementation: `frontend-design`; add `browser-qa` for runtime verification and `accessibility-review` for UI risk.
- Screenshot-driven UI: `screenshot-review`, then `frontend-design`.
- Security-sensitive changes: `security-review`; add `database-migrations` for schema/data work.
- WooCommerce work: `wordpress-woocommerce` plus generic implementation, QA, accessibility, security, or release skills as relevant.
- Kretsverket editor or canvas: `kretsverket-editor-change`.
- Kretsverket persistence or files: `kretsverket-file-compatibility`.
- Kretsverket symbols: `kretsverket-symbol-system`.
- Kretsverket electrical drawing: `kretsverket-electrical-drawing`.
- Prototyping before implementation: `prototype`; add `frontend-design` for UI prototypes.
- Pausing, executor reports, or context transfer: `handoff`; add `context-budget` for large reports.
- Release readiness: `release-check`.
- Docs, rules, or prompt consolidation: `context-budget`; add `implementation-plan` for explicit maps.

## Skill Metadata

Each `SKILL.md` frontmatter may include optional metadata fields:

- `category` — functional area or `kretsverket`.
- `risk` — low, medium, or high.
- `targets` — comma-separated supported tools: codex, opencode, claude, cursor.
- `related` — comma-separated related skill names.

`targets` drives generated adapter output under `templates/skills/<harness>/` and expands the managed skill surface for each harness. Destination paths remain fixed per harness: generated adapters install flat to each harness skill root as `<harness-skill-root>/<name>/SKILL.md`. Other metadata fields are operator guidance only.

## Generated Adapters

- `skills/**/SKILL.md` — canonical semantic source files.
- `templates/skills/_overlays/` — compact global and skill-specific harness overlays.
- `templates/skills/<harness>/<skill>/SKILL.md` — generated adapter files installed by managed setup and `scripts/install-skills.sh`.
- `metadata/skill-adapters.json` — generated adapter manifest.

Generated adapter files are not hand-maintained. In the source repository, run `python3 scripts/generate-skill-adapters.py --write` after changing canonical skills or overlays.

Two harness-specific transforms apply during generation:

- Claude adapters hoist a canonical `## When To Use` section into `when_to_use` frontmatter (Claude Code appends it to the description in the skill listing, where invocation decisions happen; combined description + when_to_use is capped at 1,536 characters).
- An overlay file may open with a `---` frontmatter block whose `key: value` lines merge into the adapter frontmatter (for example `release-check`'s Claude overlay sets `context: fork`, `agent: verifier`, `background: false`). Collisions with canonical fields fail generation.

## Agent Metadata

- `metadata/agents.json` — sidecar metadata for agents under `agents/`. Does not modify agent runtime frontmatter.

## Installing skills

```bash
./scripts/install-skills.sh --dry-run --agent opencode --global
./scripts/install-skills.sh --dry-run --agent cursor --global
```

Agent Workspace syncs generated adapters for the canonical bundled skill set to every enabled harness. Skills install globally to harness-native skill roots in flat single-file layout.
