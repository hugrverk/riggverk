# Skills

The bundled default workspace contains **25 skills**: 25 canonical semantic skill sources. Source layout may be root-level (`skills/<skill>/SKILL.md`) or grouped one level deep (`skills/<group>/<skill>/SKILL.md`). The app installs the same `SKILL.md`, flat (`<skills-folder>/<name>/SKILL.md`), into the folders the enabled harnesses read.

Do not duplicate full `SKILL.md` content here. This file is an index for choosing the right skill.

## General Skills (19)

| Skill | Use When |
| --- | --- |
| `adversarial-implementation` | An adversarial, critic-reviewed or two-agent implementation: an implementer agent against a fresh read-only critic (another model family when possible) each round, until no Fatal or Significant finding remains in the smallest diff that does the job. |
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
| `security-audit` | An explicit full codebase security audit or pen test: Cloudflare's six-phase workflow with independent verification and validated `findings.json`. Vendored (MIT); companion files and validators install next to its `SKILL.md`. |
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
| `minimal-implementation` / `adversarial-implementation` | Minimal-implementation is one bounded patch by the current agent; adversarial-implementation runs that patch through a separate implementer and a fresh hostile critic per round, only when the user asks for it. |
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

Claude-only frontmatter keys sit directly in the skill's frontmatter: `context`, `agent`, `background`, and `allowed-tools` (for example `release-check` runs in a forked `verifier` context on Claude Code, and `handoff` and `release-check` pre-approve the read-only commands behind their `!` state injection). Codex and OpenCode ignore them. A skill that sets one also carries a `### Claude Code` notes section (see below).

`targets` is validated metadata and selects nothing: skills folders are shared between harnesses, so every bundled skill is installed into every folder that is wanted, flat as `<skills-folder>/<name>/`, with its `SKILL.md` and every supporting file in it. Other metadata fields are operator guidance only.

## Description standard

The `description` is the only selection signal Codex, OpenCode, and Cursor see, so it carries the triggers. Format: one plain line of at most 300 characters, `<what>. Use when <concrete triggers>. Not for <nearest sibling> (<sibling-name>).` The `Not for` clause is optional. Avoid `: ` and ` #` in the text, since the value is written as a plain YAML scalar. Each skill also states a one-line `Done when:` exit criterion in its body. `scripts/check-skill-routing.py` lints these rules.

## Supporting files

Files next to a `SKILL.md` (references, schemas, templates, scripts) install with the skill, at the same relative paths, so a skill can say "read `HUNTING.md`" or "run `scripts/verify-report.mjs`" and mean the file next to it. `security-audit` carries 19 such files and `kretsverket-status-report` carries `assets/report-template.html` and `scripts/verify-report.mjs`.

Rules for the files in a skill directory in the bundle: regular files only (no symlinks), names of letters, digits, `.`, `_` and `-` that do not start with a dot, at most four path levels, at most 64 files and 2 MiB in total, at most 1 MiB per file, and no `SKILL.md` below the skill's own. Dot files are ignored. A skill that breaks a rule installs nothing until it is fixed. Write paths in a skill relative to its directory; never point a skill at the workspace folder, since the installed copy lives in a skills folder.

Each file is owned on its own. An update rewrites only the files that differ, a file you edited is reported as a conflict and kept while its siblings still update, and removing a skill removes the app's files and the directories that become empty, not files you added.

## One SKILL.md for every harness

`skills/**/SKILL.md` is the only source. Managed setup copies it byte for byte into every skills folder it installs into, so a skill that two harnesses both read is the same file in both places. There are no generated per-harness copies: `templates/skills/` and `metadata/skill-adapters.json` no longer exist.

Text that only one harness should act on goes at the end of the file under `## Harness notes`, one `###` subsection per harness in this fixed order, only for the harnesses that have notes: `### Claude Code`, `### Codex`, `### OpenCode`, `### Cursor`. Every harness reads the whole file, so write each note so it is clearly meant for that harness. Keep notes short; harness-wide guidance lives in `templates/rules/<harness>.md`, not in a skill.

Claude Code runs `!` followed by a backtick-quoted command (and a fence opened with three backticks and `!`) when the skill loads. Other harnesses show that text literally. It is therefore allowed only inside `### Claude Code`, with a one-sentence plain-text preface saying that other harnesses should run the commands themselves (see `handoff` and `release-check`).

In the source repository `python3 scripts/check-skill-routing.py` validates every `SKILL.md`: frontmatter and names, the notes structure and order, injection syntax only under `### Claude Code`, Claude-only frontmatter keys only with Claude notes, and LF line endings without a BOM.

## Agent Metadata

- `metadata/agents.json` — sidecar metadata for agents under `agents/`. Does not modify agent runtime frontmatter.
- `default_skills` mirrors the skills each Claude agent header preloads (`templates/claude/agents/<role>.header.yaml`), and `targets` mirrors `metadata/agent-adapters.json`; `scripts/check-skill-routing.py` enforces both.
- Claude `repo-scout`, `inspector`, and `sentinel` have no shell (`Read, Grep, Glob`, plan mode), so the parent passes the diff or changed-file list in the prompt. The OpenCode variants read git state through their read-only bash profile.

## Installing skills

In the app, press `u` on a harness page and confirm with `y`. Skills are one global surface: the update installs the whole bundled catalog (the shared `SKILL.md` and its supporting files, flat) into the folders the enabled harnesses read, and the review lists each folder with its skill and file counts. Skills are not gated by target toggles and always come from the app's bundle: a skill you add to the runtime workspace is not installed, and a personal skill belongs directly in a skills folder, where unknown skills are preserved.

### Which folders

| Harness | Reads |
| --- | --- |
| Claude Code | `~/.claude/skills` |
| Codex | `~/.agents/skills`, and `$CODEX_HOME/skills` (deprecated) |
| OpenCode | `~/.claude/skills`, `~/.agents/skills`, `~/.config/opencode/skills` |
| Cursor | `~/.cursor/skills`, `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills` |
| GitHub Copilot (CLI) | `~/.copilot/skills`, `~/.agents/skills` (not `~/.claude/skills`; VS Code's Copilot also reads that one) |
| Pi | `~/.pi/agent/skills`, `~/.agents/skills` (not `~/.claude/skills`) |
| Kilo Code | `~/.kilo/skills`, `~/.agents/skills`, `~/.claude/skills` |

The app installs into the fewest folders that every enabled harness reads, so one skill is not listed twice for a harness: `~/.claude/skills` when Claude Code is enabled, `~/.agents/skills` when Codex is enabled, `~/.agents/skills` for OpenCode, Cursor or Kilo when neither of those two folders is wanted already, and `~/.agents/skills` for Copilot or Pi, which read no other shared folder. The folders named after a harness (`~/.copilot/skills`, `~/.pi/agent/skills`, `~/.kilo/skills`, like `~/.config/opencode/skills`) are the harness's own: they are read to show what it loads and never installed into. With a customised `CODEX_HOME` (or `CODEX_SKILLS_PATH`) Codex's copy lives in `$CODEX_HOME/skills` instead, and nothing is installed in `~/.agents/skills` for Codex. If OpenCode, Cursor or Kilo is enabled with Codex but without Claude Code, `~/.claude/skills` is added for them rather than `~/.agents/skills`, so Codex never reads a copy outside its own home. Copilot and Pi cannot be served that way, so in that corner they are shown as `unserved` and get no skills from the app.

The folders are worked out again on every preview from the enabled harnesses; switching a harness on or off writes nothing by itself. The next update installs what a harness now needs and removes the app's copies from a folder nobody needs any more, in the same reviewed, backed-up and restorable transaction. A copy you edited stays and is reported, and files you added, your own skills and Codex's `.system` are never touched. Older versions installed a copy per harness: `~/.config/opencode/skills`, `~/.cursor/skills` and `$CODEX_HOME/skills` hold the app's copies until the first update removes them. `CLAUDE_SKILLS_PATH` moves the Claude folder (inside your home folder only).

### Where skills load

The folders overlap, and you can add skills of your own anywhere, so each harness page also shows which copies that harness will actually load. Nothing is written for this view: it lists the skills folders the harness reads and opens only the `SKILL.md` of their direct subfolders.

- The runtime facts get a `skill loads` row: `25 skills, 1 copy each` when every name has one copy, `3 names with 2 copies` (a warning) when some have more, then up to five of those names with the folders their copies are in, and `+N more`. The `skills` row of the surfaces list adds the number, for example `current · 3 duplicates`. With the cursor on `skills`, a `reads` row names the folders the harness reads and which of them are missing.
- What a harness does with one name found twice: Claude Code reads one folder, so there is one copy. Codex lists every copy, and a plain `$name` mention then selects none of them (flagged as ambiguous). OpenCode 1.x keeps one copy per name and which one varies from run to run (flagged when the copies differ; byte-identical copies are shown as information only, not as a warning). Cursor may list every copy; that is not verified for every Cursor version, so it is reported as a possible duplicate. Copilot CLI, Pi and Kilo keep one copy by folder order: Copilot's `~/.copilot/skills` beats `~/.agents/skills` without a message, Pi's agent folder beats `~/.agents/skills` and prints a collision, and Kilo ranks `~/.claude/skills` below `~/.agents/skills` below `~/.kilo/skills`, the last one winning with a log line. When their copies differ, the page says the first folder wins and the others are hidden; byte-identical copies are information only.
- A copy is the app's when its skill is in the bundle and the file equals the bundled `SKILL.md`, the hash recorded at the last install, or a version the app shipped before. Anything else, a skill of your own or an edited bundled one, is yours. Duplicates that include a copy of yours are listed apart as `yours, AW cannot fix` and never counted among the app's: the app does not touch your copies. An update removes the app's own copies from folders nobody needs, which clears the duplicates it caused.
- Only personal folders are looked at: project folders (`.claude/skills`, `.agents/skills`, `.codex/skills`, `.cursor/skills` in a repository) and managed policy folders are not. Hidden entries (Codex's `.system`) are skipped. A copy reached through a symlink or by two folders counts once, and a link that leads out of your home folder is not followed. A `SKILL.md` over 1 MiB, folders beyond the first 1000 in one skills folder, and `SKILL.md` text beyond 32 MiB in one skills folder are skipped, and the `reads` row says how many.
- Copies are matched by the `name` in the frontmatter, or the folder name without one. The `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` and `OPENCODE_DISABLE_EXTERNAL_SKILLS` switches change which folders OpenCode reads, and the app cannot see them.
