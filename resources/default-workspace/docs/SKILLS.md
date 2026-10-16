# Skills

The bundled default workspace contains **24 skills**: 24 canonical semantic skill sources. Source layout may be root-level (`skills/<skill>/SKILL.md`) or grouped one level deep (`skills/<group>/<skill>/SKILL.md`). Harness-specific adapters are generated under `templates/skills/<harness>/<skill>/SKILL.md`. Installed harness skills are always flat (`<harness-skill-root>/<name>/SKILL.md`).

Do not duplicate full `SKILL.md` content here. This file is an index for choosing the right skill.

## General Skills (18)

| Skill | Use When |
| --- | --- |
| `accessibility-review` | Reviewing UI for WCAG 2.2 AA risks, semantics, controls, keyboard, focus, labels, contrast, and responsive usability. |
| `browser-qa` | Verifying frontend changes with live browser checks, route smoke tests, interactions, responsive checks, console/network review, and evidence. |
| `context-budget` | Reducing duplicated rules, docs, prompts, skills, and token overhead without removing essential safety guidance. |
| `current-docs` | Checking official/current docs for version-specific APIs, SDKs, CLIs, config, hooks, or platform behavior. |
| `database-migrations` | Planning or reviewing schema/data changes with migration, rollback, and DB push reporting. |
| `diagnose` | Debugging bugs, failures, flakes, slowness, and regressions with a red-capable feedback loop and falsifiable hypotheses. |
| `frontend-design` | Designing or improving frontend UI across repositories with coherent aesthetic direction, accessibility, and verification. |
| `handoff` | Reviewing executor evidence or compacting paused work into a trustworthy handoff with verified state and next action. |
| `implementation-plan` | Creating small verifiable implementation slices with exact files, steps, commands, and risks. |
| `minimal-implementation` | Implementing or refactoring with the smallest complete diff that fits existing ownership. |
| `prototype` | Validating throwaway UI variants, state-machine/data-model checks, and interaction experiments before production implementation. |
| `retro` | User-invoked only (`/retro`): reviewing a named coding session and proposing ranked, evidence-traced improvements to steering files, checks, and tooling. Proposals only. |
| `release-check` | Running pre-merge or pre-deploy readiness checks, including tests, migrations, env risk, smoke routes, and rollback. |
| `screenshot-review` | Reviewing supplied UI screenshots before implementation or for responsive/layout critique. |
| `security-audit` | An explicit full codebase security audit or pen test: Cloudflare's six-phase workflow with independent verification and validated `findings.json`. Vendored (MIT); companion files and validators ship in `skills/security-audit/`. |
| `security-review` | Reviewing auth, authorization, input, secrets, uploads, API endpoints, payments, shell execution, or sensitive data. |
| `tdd` | Using a narrow red-green-refactor loop for behavior changes, fixes, regressions, and tests. |
| `zoom-out` | Explaining unfamiliar code in broader system context before editing. |

## Shared Domain Skill (1)

| Skill | Use When |
| --- | --- |
| `wordpress-woocommerce` | Working on WordPress/WooCommerce themes, templates, hooks, filters, plugins, REST/AJAX, checkout/cart/product UI, security, i18n, and frontend integration. |

## Kretsverket Skills (5)

Grouped source: `skills/kretsverket/<skill>/SKILL.md`.

| Skill | Use When |
| --- | --- |
| `kretsverket-editor-change` | Changes cross Kretsverket editor layers: types, state, canvas, keyboard, selection, rendering, undo, persistence, export. |
| `kretsverket-file-compatibility` | `.krets` / `.kretsym` persistence, parsing, migrations, defaults, and untrusted imports. |
| `kretsverket-symbol-system` | Symbol Editor sandbox, definitions, instances, imports, nested symbols, anchors, and placed-instance updates. |
| `kretsverket-electrical-drawing` | Wire semantics, terminal bindings, crossings, references, and drawing-versus-netlist boundaries. |
| `kretsverket-status-report` | A Swedish one-file HTML lägesrapport (progress, what remains, release, open decisions) built from the bundled template with fresh facts from `origin/main`. Ships `assets/report-template.html` and `scripts/verify-report.mjs`. |

## Routing boundaries

| Pair | Distinct roles |
| --- | --- |
| `diagnose` / `tdd` | Diagnose finds root cause; TDD locks behavior with a narrow test once the contract is clear. |
| `implementation-plan` / `minimal-implementation` | Plan defines slices; minimal-implementation executes one bounded patch. |
| `frontend-design` / `screenshot-review` | Screenshot-review diagnoses static images; frontend-design chooses direction and implements. |
| `frontend-design` / `accessibility-review` | Frontend-design includes baseline a11y during implementation; accessibility-review is a specialist audit. |
| `frontend-design` / `browser-qa` | Frontend-design owns visual direction; browser-qa supplies runtime verification evidence. |
| `handoff` / `release-check` | Handoff compacts session state; release-check validates merge/deploy readiness. |
| `security-review` / `security-audit` | Security-review checks a change or answers a focused question in the current context; security-audit runs a full multi-agent audit of a whole codebase only when one is explicitly asked for. |
| `security-review` / `sentinel` (agent) | Skill guides the review in the current context; sentinel agent performs an independent read-only review of a finished diff. |
| `retro` / `context-budget` | Retro mines one named session for environment fixes; context-budget audits instruction surfaces without a session. |
| `zoom-out` / repo-scout (agent) | Zoom-out explains code context in chat; repo-scout agent maps unfamiliar repos read-only before implementation. |
| Kretsverket quartet | `kretsverket-editor-change` (editor layers), `kretsverket-file-compatibility` (persistence), `kretsverket-symbol-system` (symbols), `kretsverket-electrical-drawing` (wiring semantics)—kept separate because triggers and invariants differ. |

## Common Combinations

- Bugs or regressions: `diagnose`; add `tdd` when a narrow regression test is useful.
- Code implementation: `minimal-implementation`; add `implementation-plan` for larger slices.
- Unfamiliar code: `zoom-out`, then `implementation-plan` if edits are needed.
- Frontend implementation: `frontend-design`; add `browser-qa` for runtime verification and `accessibility-review` for UI risk.
- Screenshot-driven UI: `screenshot-review`, then `frontend-design`.
- Security-sensitive changes: `security-review`; add `database-migrations` for schema/data work.
- Full codebase security audit or pen test: `security-audit`.
- WooCommerce work: `wordpress-woocommerce` plus generic implementation, QA, accessibility, security, or release skills as relevant.
- Kretsverket editor or canvas: `kretsverket-editor-change`.
- Kretsverket persistence or files: `kretsverket-file-compatibility`.
- Kretsverket symbols: `kretsverket-symbol-system`.
- Kretsverket electrical drawing: `kretsverket-electrical-drawing`.
- Kretsverket lägesrapport or statusrapport: `kretsverket-status-report`.
- Prototyping before implementation: `prototype`; add `frontend-design` for UI prototypes.
- Pausing, executor reports, or context transfer: `handoff`; add `context-budget` for large reports.
- Release readiness: `release-check`.
- Docs, rules, or prompt consolidation: `context-budget`; add `implementation-plan` for explicit maps.
- Session retrospective: `retro`, only when the user invokes `/retro` (it is not routed by the rules).
- Review passes: Claude Code uses the built-in `/code-review` and `/simplify`; other harnesses use the `inspector` agent.

## Skill Metadata

Each `SKILL.md` frontmatter has `name` and `description` plus these fields:

- `category` — functional area or `kretsverket`.
- `risk` — low, medium, or high.
- `targets` — comma-separated supported tools: codex, opencode, claude, cursor.
- `related` — comma-separated related skill names; the routing check verifies each name exists.
- `disable-model-invocation` — optional `true` for user-invoked skills (currently `retro`). Claude Code and Cursor then hide the skill from the model; Codex and OpenCode ignore the flag, so such a skill must not be referenced in routing bullets and its description says it is user-invoked.

Adapter overlays may add harness-only frontmatter that is merged into the generated adapter and must not collide with canonical fields: `context`, `agent`, `background`, and `allowed-tools` (for example `release-check` runs in a forked `verifier` context on Claude Code, and `handoff` and `release-check` pre-approve the read-only commands behind their `!` state injection).

`targets` drives generated adapter output under `templates/skills/<harness>/` and expands the managed skill surface for each harness. Destination paths remain fixed per harness: generated adapters install flat to each harness skill root as `<harness-skill-root>/<name>/SKILL.md`. Other metadata fields are operator guidance only.

## Description standard

The `description` is the only selection signal Codex, OpenCode, and Cursor see, so it carries the triggers. Format: one plain line of at most 300 characters, `<what>. Use when <concrete triggers>. Not for <nearest sibling> (<sibling-name>).` The `Not for` clause is optional. Avoid `: ` and ` #` in the text, since the value is written as a plain YAML scalar. Each skill also states a one-line `Done when:` exit criterion in its body. `scripts/check-skill-routing.py` lints these rules.

## Generated Adapters

- `skills/**/SKILL.md` — canonical semantic source files.
- `templates/skills/_overlays/` — compact global and skill-specific harness overlays.
- `templates/skills/<harness>/<skill>/SKILL.md` — generated adapter files installed by managed setup and `scripts/install-skills.sh`.
- `metadata/skill-adapters.json` — generated adapter manifest.

Generated adapter files are not hand-maintained. In the source repository, run `python3 scripts/generate-skill-adapters.py --write` after changing canonical skills or overlays.

Two harness-specific transforms apply during generation:

- Claude adapters hoist an optional canonical `## When To Use` section into `when_to_use` frontmatter (Claude Code appends it to the description in the skill listing; combined description + when_to_use is capped at 1,536 characters). Prefer folding triggers into the description; use the section only for extra Claude-only triggers.
- An overlay file may open with a `---` frontmatter block whose `key: value` lines merge into the adapter frontmatter (for example `release-check`'s Claude overlay sets `context: fork`, `agent: verifier`, `background: false`, `allowed-tools`). Collisions with canonical fields fail generation.

Harness-wide guidance lives in `templates/rules/<harness>.md`, not in per-skill overlays. Global overlays under `_overlays/global/` stay at two lines or fewer, and an adapter with no overlay carries no `## Harness Adapter` section. The generator refuses canonical or overlay sources with CRLF line endings or a BOM.

## Agent Metadata

- `metadata/agents.json` — sidecar metadata for agents under `agents/`. Does not modify agent runtime frontmatter.
- `default_skills` mirrors the skills each Claude agent header preloads (`templates/claude/agents/<role>.header.yaml`), and `targets` mirrors `metadata/agent-adapters.json`; `scripts/check-skill-routing.py` enforces both.
- Claude `repo-scout`, `inspector`, and `sentinel` have no shell (`Read, Grep, Glob`, plan mode), so the parent passes the diff or changed-file list in the prompt. The OpenCode variants read git state through their read-only bash profile.

## Installing skills

In the app, press `u` on a harness page and confirm with `y`. The install covers the generated adapters for the whole bundled catalog of that harness, globally, in flat single-file layout. Skills are not gated by target toggles and always come from the app's bundle: a skill you add to the runtime workspace is not installed, and a personal skill belongs directly in the harness skill folder, where unknown skills are preserved.

The CLI equivalent installs from this workspace's adapters and is dry-run by default:

```bash
./scripts/install-skills.sh --dry-run --agent opencode --global
./scripts/install-skills.sh --apply --agent cursor --global   # backs up a differing SKILL.md first
```

Some harnesses also scan other harnesses' skill folders (for example OpenCode and Cursor read `~/.claude/skills`). If you install for several harnesses, a skill can be listed more than once there; check the harness's own documentation for precedence.
