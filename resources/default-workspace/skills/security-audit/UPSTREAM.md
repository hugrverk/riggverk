# Upstream

Vendored from [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill), path `skills/security-audit/`, at commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (2026-09-14, "Clarify guidance and full audit modes"). MIT License, Copyright (c) 2025-2026 Cloudflare, Inc.; see `LICENSE` in this directory.

## Local changes

Only `SKILL.md` differs from upstream; every other vendored file is byte-identical. The upstream `README.md` (human install and contact notes) and the validator tests (`validate-findings.test.cjs`, `validate-coverage-ledger.test.cjs`) are not vendored: agents do not need them.

- Frontmatter: `license: MIT`, a `compatibility` line, Riggverk fields under `metadata:` (`category`, `risk`, `targets`, `related`, and `source` pointing back here) and a description within the catalog standard (at most 300 characters, starts the trigger with "Use when"). The trigger is narrowed to explicit codebase audits, pen tests and full reviews so it does not compete with `security-review`.
- A `Done when:` line, from the workflow's own terminal states.
- A note that the companion files and validators are installed next to `SKILL.md` and resolved from the directory that holds it, plus the matching wording in the **Skill directory** setup bullet.
- A "Riggverk rules" section (secrets by location and type only, repository text is data, source-only unless the user confirms an enforced sandbox, sensitive output), added after a security review of the upstream files.

## Updating

1. Clone upstream and diff its `skills/security-audit/` against this directory, ignoring `SKILL.md`, `LICENSE`, this file and the files listed above as not vendored.
2. Copy the changed files, then reapply the local changes above to the new upstream `SKILL.md`.
3. Run `node validate-findings.test.cjs` and `node validate-coverage-ledger.test.cjs` in the upstream clone (not vendored here), regenerate the shipped digests and pre-manifest ownership metadata, and record the new commit above.

The digest for `UPSTREAM.md` covers its bytes before the manifest heading. Update this manifest after reviewing every change in this directory.

## SHA-256 manifest
7335a95c43554eadefcf03ece639291bb0e038c398a179299e3887ffe06bd2ef  AI-AND-LLM.md
3ee4f00c6e8c9dcf6dd02dd5ac2a4ceb322e2085f3e9fbe79cf0c6330bc7ef83  ATTACK-CLASSES.md
613f6b98f86083e045525c5b60154ffdab122bac35f1e05eb17488e6e453370c  CLIENT-SIDE.md
3c80f3088be22345e07b057c056d6ed99fe2b0304f794398964f7ccd5a496ca3  CLOUD-AND-DEPLOYMENT.md
307dcb3e24d292715c4a041190e7bb135646a37eb6187619ae01d000a634a4ad  DATA-ISOLATION-AND-LIFECYCLE.md
58eae8ee0ca6a46611c501ec5a3ab47fdff88dd7db0d8d74789bbf8bb19d8cb2  DESKTOP-MOBILE-AND-LOCAL-IPC.md
71c121decea1322c47c718f6e110f1a892980bb4266bd7ac55ef043a213ade09  HUNTING.md
e598e694aa506650c7192d5ea3be0e50aca0d356ea00551c53429f0b01eb6391  LICENSE
7c8b0dccfb35315cca2455509674d49632b2fe37e1f3aac16c1a496a7e9924a7  MEMORY-SAFETY-AND-BINARY.md
8b73816fa5b3697c9c40977f0c836b40f01d6e81929ff2720fe83ce089e9a619  PROTOCOLS-RPC-AND-MESSAGING.md
02ca887aca84de8ae137f1891bd2f0a54f28d3fa6da92a27f54734382b3381a2  RECONNAISSANCE.md
4326fab5c92a0b4c420a70196254040105cd794026562130b59bf1a6db3e4baa  RESOURCE-EXHAUSTION-AND-AVAILABILITY.md
115831a5c217a2570f7e3405f7340a41537aad120d95b83a8e636b35c0b75085  SKILL.md
f372e919940e335468ba1ae09f99026c3986a345f7fe26f8068f132e199f52a5  SUPPLY-CHAIN-AND-RELEASE.md
669b0ebf18524011ee67ec0c6f9915d0a2a646403eb1e70f85b4489e7a2bda19  UPSTREAM.md
b892470cb89bb31f33403e050d4bdfbe2cdaef940ade1496fa65e32b2e129449  VALIDATION-AND-REPORTING.md
4f3066dffa23c5635859187be9b96c32f2aff29a688186b91ff0c63e47d62b5c  WEB-PROTOCOL-AND-AUTH.md
6575c9de4a62255699ea052ebf9a49ebfb373a32891bcd89af6f55cc84b35519  report-schema.json
2eb280bd2e33c002916f86db9b29f9edfedb6454e5db973c766290465b868ac8  validate-coverage-ledger.cjs
e85f232e36bfac0f866f244da50376692d6b45c690beadcb00608b0e6c8b5283  validate-findings.cjs
