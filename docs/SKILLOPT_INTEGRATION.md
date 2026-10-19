# SkillOpt Integration Evaluation

Decision record for whether Riggverk should integrate `microsoft/SkillOpt` (including its `skillopt-sleep` mode). Companion document: `docs/SKILL_CATALOG_AUDIT.md`.

> Historical snapshot: numbers and counts are as of when this was written and are not maintained.

## Decision

**Documentation only. No integration now.** No runtime dependency, no bundled helper script, no scheduler, no transcript harvesting. Re-evaluate only if a concrete, scoreable skill-quality problem appears that manual editing plus `scripts/check-skill-routing.py` cannot address.

## What SkillOpt is

SkillOpt (MIT, PyPI `skillopt`, Python 3.10+, v0.2.0 as of July 2026) is a text-space optimizer: it treats a skill document as trainable state for a frozen LLM agent. It runs the agent on scored task batches, has a separate optimizer model propose bounded add/delete/replace edits to the skill document, and accepts an edit only when a held-out validation score strictly improves. The deployable artifact is a compact `best_skill.md` (~300–2,000 tokens). It supports direct-chat, Codex CLI, and Claude Code CLI harnesses and reports large accuracy lifts on its six built-in benchmarks.

A custom environment requires three components under `skillopt/envs/<name>/`: `dataloader.py` (tasks), `rollout.py` (execution), and `initial.md` (seed skill). Runs require API keys in `.env` for both the target agent and the optimizer model.

`skillopt-sleep` (v0.2.0) is a nightly offline self-evolution engine for local coding agents: harvest local experience → mine → replay → consolidate skill updates behind a validation gate.

## Why not integrate now

| Concern | Assessment |
| --- | --- |
| **Security model conflict** | `skillopt-sleep` harvests local agent transcripts and runs a background scheduler. `docs/SECURITY_MODEL.md` commits Riggverk to no transcript/credential-surface inspection, no background mutation, and opt-in writes only. Bundling or recommending sleep mode inside the app would break that contract. |
| **No objective scorer exists** | SkillOpt's core requirement is a scoring function over rollouts. AW skills are process-guidance documents (routing, invariants, reporting contracts), not benchmark tasks. There is currently no dataset or scorer for "did `minimal-implementation` produce better patches", so the validation gate — the part that makes SkillOpt trustworthy — cannot be built cheaply. Without it, SkillOpt degenerates to an LLM rewriting prompts. |
| **Cost** | Each optimization run is many agent rollouts × optimizer-model calls against paid APIs, per skill. For 21 skills this is a recurring, non-trivial spend with unquantified benefit. |
| **Maintenance** | A Python dependency tree (plus `.env`-based API credentials, Gradio UI) added to a Tauri/TypeScript/Rust repo with a deliberately small script surface. v0.x project churn would land on a solo maintainer. |
| **Privacy** | Optimization rollouts send task content to configured model APIs. Any AW-derived dataset must be built from synthetic or repo-public tasks only — never local session history. |
| **Time-to-value** | The catalog audit found no skill-quality problem that SkillOpt would fix: all 21 skills have live routing consumers, sharp boundaries, and recent manual investment. The binding constraint is evidence about *when skills fire*, which SkillOpt does not provide. |

## Rejected alternatives

- **Runtime/app dependency** — rejected; violates the no-runtime-dependency constraint and the security model, and the app has no execution role for optimization.
- **`skillopt-sleep` nightly mode** — rejected; automatic local-transcript harvesting and unattended skill mutation contradict AW's opt-in, no-transcript, human-reviewed-change contracts, even though its validation gate is well designed.
- **Bundled optional helper script in `scripts/`** — rejected for now; anything in `scripts/` becomes part of the maintained contract surface (release checks, docs), which is not justified before a scorer exists.
- **Vendoring or forking** — rejected; strictly worse maintenance than the PyPI package.

## If a future spike happens (design sketch)

Preconditions: a concrete skill with a scoreable outcome, budget approval, and explicit maintainer intent. Then:

1. **Isolation**: separate throwaway repo or ignored local directory; `pip install skillopt` in a venv; never imported by app code; no scheduler.
2. **Environment adapter**: `dataloader.py` over a small synthetic task set derived from repo-public material (e.g. routing decisions: given a task description, which of the 21 skills should fire — labels derivable from `docs/SKILLS.md` and `templates/global-agent-rules.md`); `rollout.py` running Codex CLI or Claude Code CLI with the candidate skill installed in a sandbox home, never the real `~/.codex` / `~/.claude`; a deterministic scorer (exact-match routing accuracy is the cheapest viable first target).
3. **Validation gate**: held-out task split; accept only strict improvement, per SkillOpt's own discipline.
4. **Deployment path**: an accepted `best_skill.md` is *never* auto-installed. It becomes a human-reviewed proposal diff against the canonical `resources/default-workspace/skills/<name>/SKILL.md`, followed by the normal pipeline: `python3 scripts/check-skill-routing.py`, `python3 scripts/generate-pre-manifest-ownership.py`, `./scripts/release-check.sh`, review, commit.
5. **Exit criteria**: if the spike cannot show a validated improvement on the routing scorer within a bounded budget, stop and record the result here.

## Sources

- microsoft/SkillOpt repository and docs site (README, guideline, v0.2.0 release notes), reviewed 2026-07-10.
