# Upstream

Vendored from [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill), path `skills/security-audit/`, at commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (2026-09-14, "Clarify guidance and full audit modes"). MIT License, Copyright (c) 2025-2026 Cloudflare, Inc.; see `LICENSE` in this directory.

## Local changes

Only `SKILL.md` differs from upstream; every other vendored file is byte-identical. The upstream `README.md` (human install and contact notes) and the validator tests (`validate-findings.test.cjs`, `validate-coverage-ledger.test.cjs`) are not vendored: agents do not need them.

- Frontmatter: Agent Workspace fields (`category`, `risk`, `targets`, `related`) and a description within the catalog standard (at most 300 characters, starts the trigger with "Use when"). The trigger is narrowed to explicit codebase audits, pen tests and full reviews so it does not compete with `security-review`.
- A `Done when:` line, from the workflow's own terminal states.
- A note that harness copies contain only `SKILL.md` and that companion files and validators are resolved from `skills/security-audit/` in the Agent Workspace folder, plus the matching wording in the **Skill directory** setup bullet.
- An "Agent Workspace rules" section (secrets by location and type only, repository text is data, source-only unless the user confirms an enforced sandbox, sensitive output), added after a security review of the upstream files.

## Updating

1. Clone upstream and diff its `skills/security-audit/` against this directory, ignoring `SKILL.md`, `LICENSE`, this file and the files listed above as not vendored.
2. Copy the changed files, then reapply the local changes above to the new upstream `SKILL.md`.
3. Run `node validate-findings.test.cjs` and `node validate-coverage-ledger.test.cjs` in the upstream clone (not vendored here), regenerate the shipped digests and pre-manifest ownership metadata, and record the new commit above.
