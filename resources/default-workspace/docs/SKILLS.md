# Skills

The bundled default workspace contains 28 skills at `skills/<skill>/SKILL.md`: 24 generic starter skills and 4 shared domain workflow skills. Use canonical root-level layout only (`skills/<skill>/SKILL.md`).

Do not duplicate full `SKILL.md` content here. This file is an index for choosing the right skill and understanding source layout.

## Generic Starter Skills

| Skill | Use When |
| --- | --- |
| `accessibility-review` | Reviewing UI for WCAG 2.2 AA risks, semantics, controls, keyboard, focus, labels, contrast, and responsive usability. |
| `agent-report-review` | Reviewing a coding agent final report for completeness, verification quality, risk, and safest next action. |
| `browser-qa` | Verifying frontend changes with live browser checks, route smoke tests, interactions, responsive checks, console/network review, and evidence. |
| `caveman` | Producing intentionally terse technical communication. |
| `context-budget` | Reducing duplicated rules, docs, prompts, skills, and token overhead without removing essential safety guidance. |
| `current-docs` | Checking official/current docs for version-specific APIs, SDKs, CLIs, config, hooks, or platform behavior. |
| `database-migrations` | Planning or reviewing schema/data changes with migration, rollback, and DB push reporting. |
| `dependency-evaluation` | Evaluating whether to add packages, SDKs, MCP servers, CLIs, or internal abstractions. |
| `diagnose` | Debugging bugs, failures, flakes, slowness, and regressions with a reproduce-to-regression-test loop. |
| `frontend-design` | Designing or improving frontend UI with coherent aesthetic direction, accessibility, and verification. |
| `grill-me` | Stress-testing a plan with bounded high-value questions before execution. |
| `grill-with-docs` | Stress-testing a plan against repo docs, ADRs, and captured decisions. |
| `handoff` | Compacting long sessions, paused workflows, branch state, or agent chains into a durable handoff. |
| `implementation-plan` | Creating small verifiable implementation slices with exact files, steps, commands, and risks. |
| `improve-codebase-architecture` | Finding bounded architecture improvements that reduce maintenance cost without broad rewrites. |
| `prototype` | Validating throwaway UI variants, state-machine/data-model checks, and interaction experiments before production implementation. |
| `release-check` | Running pre-merge or pre-deploy readiness checks, including tests, migrations, env risk, smoke routes, and rollback. |
| `screenshot-review` | Reviewing supplied UI screenshots before implementation or for responsive/layout critique. |
| `security-review` | Reviewing auth, authorization, input, secrets, uploads, API endpoints, payments, shell execution, or sensitive data. |
| `tdd` | Using a narrow red-green-refactor loop for behavior changes, fixes, regressions, and tests. |
| `to-prd` | Converting current context into a concise solo-developer PRD, feature brief, or product spec. |
| `triage` | Reviewing, classifying, prioritizing, or preparing issues before implementation. |
| `write-a-skill` | Creating or revising agent skills with minimal structure. |
| `zoom-out` | Explaining unfamiliar code in broader system context before editing. |

## Shared Domain Skills

| Skill | Use When |
| --- | --- |
| `nextjs-product-slice` | Implementing small Next.js product slices with clear route, component, and server boundaries. |
| `supabase-rls-review` | Reviewing Supabase RLS, auth boundaries, storage policies, service-role usage, and data access risk. |
| `woocommerce-pdp-review` | Reviewing or improving WooCommerce product detail pages while preserving gallery, variation, stock, price, add-to-cart, tabs, reviews, and responsive behavior. |
| `wordpress-woocommerce` | Working on WordPress/WooCommerce themes, templates, hooks, filters, plugins, REST/AJAX, checkout/cart/product UI, security, i18n, and frontend integration. |

## Common Combinations

- Bugs or regressions: `diagnose`; add `tdd` when a narrow regression test is useful.
- Unfamiliar code: `zoom-out`, then `implementation-plan` if edits are needed.
- Frontend implementation: `frontend-design`; add `browser-qa` for runtime verification and `accessibility-review` for UI risk.
- Screenshot-driven UI: `screenshot-review`, then `frontend-design`.
- Security-sensitive changes: `security-review`; add `database-migrations` for schema/data work or `supabase-rls-review` for Supabase.
- WooCommerce work: `wordpress-woocommerce`; add `woocommerce-pdp-review` for PDP-specific work.
- Next.js/Supabase: `nextjs-product-slice`; add `supabase-rls-review` for auth/RLS/storage/service-role/data access.
- Prototyping before implementation: `prototype`; add `frontend-design` for UI prototypes or `zoom-out` / `implementation-plan` when repo context is needed.
- Pausing or transferring work: `handoff`; add `agent-report-review` if the handoff is based on an executor report, and `release-check` before merge/deploy handoff.
- Release readiness: `release-check`; add `agent-report-review` when reviewing another agent's report.
- Planning and scoping: `to-prd` to convert context into a spec; `grill-me` or `grill-with-docs` to stress-test the plan before implementation.
- Architecture debt: `improve-codebase-architecture` for bounded improvements without broad rewrites.
- Docs, rules, or prompt consolidation: `context-budget`; add `implementation-plan` for explicit old-to-new maps.

## Skill Metadata

Each `SKILL.md` frontmatter may include optional metadata fields:
- `category` — functional area: accessibility, architecture, commerce, database, dependency, diagnosis, docs, frontend, planning, review, security, testing, workflow.
- `risk` — low, medium, or high.
- `targets` — comma-separated supported tools: codex, opencode, claude, cursor.
- `related` — comma-separated related skill names.

These fields are operator guidance only. They do not change runtime behavior, skill loading, or install destinations.

## Agent Metadata

- `metadata/agents.json` — sidecar metadata for agents under `agents/`. Does not modify agent runtime frontmatter.

## Installing skills

```bash
./scripts/install-skills.sh --dry-run --agent opencode --global
./scripts/install-skills.sh --dry-run --agent cursor --global
```

The app installs skills globally only. Cursor skill installation targets `~/.cursor/skills` as part of the global Cursor profile model.
