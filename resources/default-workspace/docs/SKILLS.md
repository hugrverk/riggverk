# Skills

The starter workspace includes a generic baseline skill set suitable for most software engineering tasks.

Each skill lives in its own directory under `skills/` and must contain a `SKILL.md` file:

```
skills/
  diagnose/
    SKILL.md
  tdd/
    SKILL.md
```

The directory name is the skill identifier. `SKILL.md` contains the skill instructions loaded by the agent tool at runtime.

## Bundled starter skills

All bundled skills are treated as core starter skills. There is no core vs add-on split.

### Engineering

- accessibility-review — review UI accessibility risks
- browser-qa — verify frontend changes in a live browser
- current-docs — check current primary docs for version-specific APIs
- database-migrations — plan and review safe schema changes
- diagnose — debug with a reproducible loop
- dependency-evaluation — evaluate build-vs-buy and dependency risk
- frontend-design — design or improve frontend UI
- grill-with-docs — stress-test a plan against repo docs
- implementation-plan — turn approved direction into small verifiable slices
- improve-codebase-architecture — find bounded architecture improvements
- release-check — check readiness before merge, deploy, or handoff
- screenshot-review — review UI screenshots before implementation
- security-review — review security risks
- tdd — red-green-refactor with narrow behavior tests
- to-prd — convert context into a concise PRD or feature brief
- triage — review an issue and recommend next action
- zoom-out — explain local code in broader system context

### Productivity

- agent-report-review — review executor reports for evidence and risk
- caveman — compressed technical communication
- context-budget — audit skills, rules, docs for token overhead
- grill-me — bounded plan stress-test
- write-a-skill — edit or add skills with minimal structure

## Adding or removing skills

Users can add, edit, or remove skills under `skills/`. Domain-specific skills can be added later.

1. Create a new directory under `skills/`
2. Add a `SKILL.md` file with the skill instructions
3. Install the skill to your agent tool folders

## Installing skills

Skills can be installed globally (available in all projects) or per-project (scoped to a specific project folder).

Use dry-run to preview installations before applying:

```bash
./scripts/install-skills.sh --dry-run --agent opencode --global
```

Skills from the workspace are installed directly as filesystem copies. No external package managers are used.
