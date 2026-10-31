# Notices

Some bundled Riggverk skills are adapted from skill work by Matt Pocock (https://github.com/mattpocock/skills).

Original author:
Matt Pocock

Adaptations:
Hugrverk

Adapted material and bundled skills it informs:

- `diagnosing-bugs` informs `diagnose` (redaction, feedback-loop acceptance criteria, the minimise step, ranked falsifiable "if X is the cause" hypotheses, tagged debug logs, regression tests at a seam).
- `tdd` informs `tdd` (seams, tautological-test anti-pattern, mocking at system boundaries).
- `prototype` informs `prototype` (pure logic module, `?variant=` UI hosting, state surfacing, stating the assumed branch).
- `handoff` informs `handoff` (redaction, OS temporary directory, referencing rather than duplicating, suggested skills).
- `writing-for-agents` informs `context-budget` (no-op test, sediment, single source of truth, pointer wording).
- `retro` informs `retro` (its improvement categories and the implementation-versus-review split).

The text of these skills was paraphrased and restructured for Riggverk; the ideas and structure credited above come from the original work.

License of the original work:

MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The root LICENSE applies to this repository. This notice preserves attribution for adapted third-party skill material included in the bundled starter workspace.

## crucible red-team skill

The fresh-critic loop of `adversarial-implementation` and `adversarial-review` draws on the `red-team` skill of [raddue/crucible](https://github.com/raddue/crucible) (`skills/red-team/SKILL.md` and `red-team-prompt.md`, read at commit `3b871d38f216e0dfcb7826fd09b979f3b85dce98`). Used: a fresh critic each round, the steel-man finding format (**Best Defense** and **Why The Defense Fails**), the Fatal, Significant and Minor severities with Minor never blocking, and iterating until the work is clean or the weighted score (Fatal 3, Significant 1) stagnates. The text was reworded and extended for Riggverk; the proof rule, the minimality dimension, frozen tests and the deletion-only round are Riggverk's own.

License of the original work:

MIT License

Copyright (c) 2026 raddue

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## dementev-dev adversarial-review

`adversarial-implementation` and `adversarial-review` also draw on [dementev-dev/adversarial-review](https://github.com/dementev-dev/adversarial-review) (`SKILL.md`, read at commit `584ae8d1c62c75bedfdc191a0a8393c3bbf819fe`), licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0). Used: the read-only critic as "an auditor, not a contributor", the aim to break confidence in the change, and the lead's accept, re-scope or reject adjudication of each finding. Changes: the ideas were reworded for Riggverk, any critic harness was allowed, and rejections were tied to proof (a failing test or command, or a quoted requirement). No files of that work are included.

## superpowers writing-plans

The "Avoid placeholders" step of `implementation-plan` (no placeholder markers, no generic test or error-handling chores, no "similar to the previous task") is adapted from the "No Placeholders" list of `skills/writing-plans/SKILL.md` in [obra/superpowers](https://github.com/obra/superpowers) at commit `5bf4e78011075bcfc0dc295f0724994cd123ee71`. The wording is Riggverk's.

License of the original work:

MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## superpowers dispatching-parallel-agents and using-git-worktrees

`delegate` draws on two skills of [obra/superpowers](https://github.com/obra/superpowers) at commit `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`: from `skills/dispatching-parallel-agents/SKILL.md`, one agent per independent slice with no shared files or state, a focused, self-contained brief with explicit constraints and expected output, and checking the returned work for conflicts before running the full suite; from `skills/using-git-worktrees/SKILL.md`, preferring the harness's native worktree tool over `git worktree add`, and a clean baseline run in the new worktree before work starts. The wording is Riggverk's; the CLI recipes, write confinement and the PR-style review are Riggverk's own. Same MIT license and copyright as in the superpowers writing-plans entry above.

## Cloudflare security-audit-skill

The bundled `security-audit` skill is vendored from [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) at commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`, as recorded in [UPSTREAM.md](resources/default-workspace/skills/security-audit/UPSTREAM.md).

Path: `resources/default-workspace/skills/security-audit/`. Copyright (c) 2025-2026 Cloudflare, Inc. Licensed under MIT; the full [license](resources/default-workspace/skills/security-audit/LICENSE) accompanies the vendored files. Local adaptations are described in `UPSTREAM.md`.

## openai/skills gh-fix-ci

`ci-triage` draws on the `gh-fix-ci` skill of [openai/skills](https://github.com/openai/skills) (`skills/.curated/gh-fix-ci/SKILL.md`, read at commit `49f948faa9258a0c61caceaf225e179651397431`), licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0). Used: checking gh authentication first, finding failed checks with `gh pr checks --json`, reporting a check that is not a GitHub Actions run by its link only, and reading a job's own log when the run is still in progress. Changes: the text is Riggverk's own; the failure classes, the local reproduction, the hand-off to `diagnose`, the redaction rules and the approval-gated rerun are not in that work. No files of that work are included.

## Acknowledgements

These skills share an idea with public work but no text, structure or distinctive method taken from it:

- `zoom-out` takes its name and idea (go up a layer and map the modules and callers before editing) from the former `zoom-out` skill in [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, removed upstream); its text is Riggverk's own.
- `frontend-design` shares the framing of committing to one coherent aesthetic direction, and matching implementation complexity to it, with the late-2025 `frontend-design` skill in [anthropics/skills](https://github.com/anthropics/skills) (Apache-2.0); its text and structure are Riggverk's own.

Bundled skills credit their upstream in `metadata.source` of their `SKILL.md`, and carry `license: MIT` (the root LICENSE).

## Lobe Icons

The vector paths of the agent icons in `src/ui/agentIcons.tsx` (Claude, Codex, Cursor, GitHub Copilot, OpenCode, Pi, Kilo Code, Google Antigravity and Grok) come from [Lobe Icons](https://github.com/lobehub/lobe-icons) (`@lobehub/icons-static-svg` 1.101.0), (c) LobeHub, licensed under the MIT License. The marks themselves belong to their owners and are used only to name the tool each icon stands for; Riggverk is not affiliated with or endorsed by them.
