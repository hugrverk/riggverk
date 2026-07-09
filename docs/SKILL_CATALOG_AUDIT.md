# Skill Catalog Audit

Audit of the 21 canonical bundled skills under `resources/default-workspace/skills/`, produced for the skill-catalog audit and SkillOpt evaluation issue. Companion document: `docs/SKILLOPT_INTEGRATION.md`.

**No raw private history was committed.** All local usage evidence in this document is aggregate counts only. No transcripts, prompts, model outputs, session identifiers, or private file paths were copied into this repository or into the audit process output.

## Methodology

Evidence classes, strongest first:

1. **Repo routing reality.** Every canonical `SKILL.md` was read in full. Frontmatter (name, description, category, risk, targets, related) and body size were captured. References were cross-checked against `resources/default-workspace/docs/SKILLS.md`, `resources/default-workspace/templates/global-agent-rules.md`, `resources/default-workspace/templates/cursor/user-rules.md`, `src/lib/brainSetup.ts`, `resources/default-workspace/metadata/agents.json`, and generated adapters.
2. **Repo-wide reference counts.** Each skill name was grepped across the repository excluding canonical sources, generated adapters, `node_modules`, `.git`, `target`, and `dist`. Every skill has 12–40 live non-source references; there are no orphaned skills.
3. **Git history.** Catalog lifecycle commits were inspected (`61610d0d` finalized the catalog at 21; `cb441291` added `prototype`/`handoff`; recent commits `f9f9d8f1`, `8883ed65`, `350c72cd` show deliberate investment in `frontend-design` and routing boundaries). Deep `git log -S` mining per name was abandoned as too slow on this repository; the pinned removed-name set in `scripts/check-skill-routing.py` (12 names) is treated as authoritative for removals.
4. **Local opt-in aggregate usage scan (weak signal).** A read-only script scanned local Codex session files (586 JSONL files, ~1.4 GB) and Claude Code project transcripts (32 JSONL files, ~69 MB) for skill-invocation markers, emitting only per-skill session counts and month buckets. Findings and limits are below. The scanner lives outside the repo in session scratch space and mutated nothing.

### Limits of the local usage scan

- **Codex counts measure catalog presence, not invocation.** Counts are near-uniform (~180–360 of 586 sessions per skill) and step up exactly when a skill entered the installed catalog (e.g. kretsverket skills appear only from 2026-06, matching their addition). Codex sessions embed installed skill paths, so path markers cannot distinguish "listed" from "used". No per-skill invocation ranking can be honestly derived.
- **Claude Code counts are genuine invocation markers but sparse.** 32 transcripts, almost all skills at 1 session (2026-07), consistent with a single health-check-style session touching the whole catalog. Only `frontend-design` shows multi-session invocation (3 sessions).
- Consequence: **no skill can be classified keep/prune on usage frequency.** Usage evidence is recorded as `no-data` unless stated. Repo routing evidence carries the classification.

## Inventory and classification

Sizes are body lines / approximate words (tokens ≈ words × 1.3). All 21 skills target all four harnesses (codex, opencode, claude, cursor) and are referenced by live routing sources; none are orphaned.

| Skill | Category | Risk | Lines / words | Status | Rationale |
| --- | --- | --- | --- | --- | --- |
| `accessibility-review` | accessibility | low | 79 / 503 | keep | Clear specialist boundary vs `frontend-design`/`browser-qa`, documented both in-file and in SKILLS.md routing table. |
| `browser-qa` | frontend | medium | 80 / 573 | keep | Distinct runtime-evidence role; owns dev-server lifecycle rules used by agents. Contains a small "vs screenshot-review" section that duplicates SKILLS.md boundaries — acceptable, self-contained adapters need it. |
| `context-budget` | workflow | low | 86 / 418 | keep | Only skill covering instruction-surface audits; used by this audit itself. |
| `current-docs` | docs | low | 68 / 424 | keep | Unique freshness-routing role; wired as `scribe` agent default skill. |
| `database-migrations` | database | high | 84 / 534 | keep | High-risk domain, no overlap; explicit DB-push reporting contract is referenced by rules. |
| `diagnose` | diagnosis | medium | 60 / 442 | keep | Boundary vs `tdd` is sharp and stated in both descriptions after prior tightening. |
| `frontend-design` | frontend | medium | 109 / 704 | keep | Largest skill. Three recent commits deliberately strengthened it; multi-session Claude invocation evidence (3 sessions) — the only skill with usage signal above noise. Do not churn. |
| `handoff` | workflow | low | 37 / 174 | keep | Lean; wired as default skill for `architect` and `inspector` agents. |
| `implementation-plan` | planning | low | 68 / 341 | keep | Sharp non-implementing boundary vs `minimal-implementation`; `architect` default skill. |
| `kretsverket-editor-change` | kretsverket | high | 42 / 189 | keep | Quartet kept separate by documented design (SKILLS.md routing table): triggers and invariants differ. Merging would blur high-risk invariants for marginal token savings (~700 words total across four skills). |
| `kretsverket-electrical-drawing` | kretsverket | high | 38 / 162 | keep | See above. |
| `kretsverket-file-compatibility` | kretsverket | high | 46 / 168 | keep | See above. |
| `kretsverket-symbol-system` | kretsverket | high | 42 / 194 | keep | See above. |
| `minimal-implementation` | implementation | low | 38 / 246 | keep | Default implementation skill in rules and `architect`/`inspector` agents. |
| `prototype` | workflow | low | 49 / 286 | tightened (this audit) | Frontmatter description was the weakest trigger in the catalog ("Use for throwaway prototype work…") and lagged the richer SKILLS.md routing language. Description aligned; body unchanged. |
| `release-check` | workflow | medium | 44 / 206 | keep | Highest repo reference count (name collides with `scripts/release-check.sh`, which inflates the raw count, but routing references are real). |
| `screenshot-review` | frontend | low | 42 / 208 | keep | Diagnose-only boundary vs `frontend-design` is explicit in both files. |
| `security-review` | security | high | 84 / 594 | keep | High-risk anchor; `sentinel` agent default skill; boundary vs the agent documented in SKILLS.md. |
| `tdd` | testing | low | 44 / 255 | keep | Anti-overlap language vs `diagnose` present in both descriptions. |
| `wordpress-woocommerce` | commerce | high | 77 / 485 | keep | Only shared-domain skill; self-contained; no generic-skill overlap beyond deliberate security/i18n reminders scoped to WP APIs. |
| `zoom-out` | architecture | low | 29 / 123 | keep | Smallest skill; `disable-model-invocation: true` makes it user/agent-routed only; `repo-scout` default skill. |

Catalog totals: ~1,240 body lines, ~6,700 words, roughly 9k tokens for the full canonical catalog. Per-session cost is far lower because harnesses load skills on demand and rules instruct selecting 1–3 skills per task.

## Overlap review

High-adjacency pairs were checked for duplicated guidance:

- `diagnose` / `tdd`: boundary stated bidirectionally in descriptions; bodies do not duplicate process steps. No action.
- `frontend-design` / `screenshot-review` / `browser-qa` / `accessibility-review`: `frontend-design` carries an explicit "Routing boundaries" block naming the other three. This repeats SKILLS.md, but generated adapters are installed standalone per harness, so in-file boundaries are load-bearing. No action.
- `implementation-plan` / `minimal-implementation`: complementary by design; descriptions cross-reference. No action.
- `handoff` / `release-check`: distinct roles (session compaction vs merge readiness), documented in SKILLS.md routing table. No action.
- Kretsverket quartet: deliberate separation; each file is already minimal (38–46 lines). Merge rejected — would couple unrelated high-risk invariants.

No merge or prune candidates were identified. Every skill has live routing references in rules, agents metadata, brainSetup prompt text, and SKILLS.md; the catalog was already pruned from a larger set to 21 in commit `61610d0d`, and the 12 removed names remain pinned and guarded by `scripts/check-skill-routing.py` (`REMOVED_SKILLS`), which fails on any reintroduced reference.

## Changes made by this audit

- `resources/default-workspace/skills/prototype/SKILL.md`: frontmatter description sharpened to match the SKILLS.md routing language (triggers on UI variants, state-machine/data-model checks, and interaction experiments). Body unchanged.
- Generated adapters and `metadata/skill-adapters.json` regenerated via `python3 scripts/generate-skill-adapters.py --write`.

## Recommendations (no action taken)

- **Keep the catalog at 21.** No usage evidence supports pruning, and every skill has live routing consumers.
- **If invocation-level telemetry is ever wanted**, it must come from an explicit opt-in local scan (as done here) — Codex session files cannot distinguish listing from use, so any future frequency claims need harness-level invocation markers, not path greps.
- **Re-run this audit only on catalog change**, not on a schedule; `scripts/check-skill-routing.py` already guards drift continuously.
- SkillOpt-based optimization: see `docs/SKILLOPT_INTEGRATION.md` (recommendation: documentation only; no dependency, no transcript harvesting).

## Reproducibility

The aggregate scanner logic: for each local session file, test for harness invocation markers per skill name (`"skill":"<name>"` tool-use markers for Claude Code; installed `skills/<name>/SKILL.md` path markers for Codex), count matching sessions, bucket by file mtime month, and print counts only. Anyone re-running it should treat Codex counts as catalog-presence, per the limits above.
