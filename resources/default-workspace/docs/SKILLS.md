# Skills

The bundled default workspace contains the skills listed below. Source layout may be root-level (`skills/<skill>/SKILL.md`) or grouped one level deep (`skills/<group>/<skill>/SKILL.md`). The app installs the same `SKILL.md`, flat (`<skills-folder>/<name>/SKILL.md`), into the folders the enabled harnesses read.

Do not duplicate full `SKILL.md` content here. This file is an index for choosing the right skill.

## General Skills

| Skill | Use When |
| --- | --- |
| `adversarial-implementation` | Only when the user explicitly asks for it, in plain words ("run an adversarial implementation", "have a critic review it") or with `/adversarial-implementation`; it is kept out of the routing rules: an adversarial, critic-reviewed or two-agent implementation. A delegated implementer works against a fresh read-only critic chosen by capability first; only findings whose proof the lead re-runs count, the judging tests are frozen, and a deletion-only round ends the loop. Roles work with no setup and change with one phrase in chat or an `Adversarial roles:` line below END in the rules. |
| `adversarial-review` | Only on an explicit request (`/adversarial-review`, or plain language such as "run an adversarial review" or "review the plan adversarially"): a fresh read-only critic chosen by capability attacks an existing diff, or a plan in plan mode, and only findings whose proof the lead re-runs are reported, in Fatal, Significant, Minor and Pre-existing buckets. It fixes nothing and offers a re-review of later changes at most once. Roles work as in `adversarial-implementation`. |
| `adversarial-test` | Only when the user explicitly asks for it, in plain words ("write adversarial tests", "let an adversary write the tests") or with `/adversarial-test`; it is kept out of the routing rules: a fresh read-only adversary, chosen by capability first, proposes failing tests tied to the acceptance criteria. The lead keeps only tests it ran and saw fail for the stated reason, freezes them, and the implementer changes production code only or reports `BLOCKED`. At most two rounds; only tests that protect a criterion stay. Roles as for `adversarial-implementation`. |
| `agents-md` | Creating or refreshing a repository's `AGENTS.md` from commands that actually ran, the real layout and sourced invariants, with an optional `CLAUDE.md` that only holds `@AGENTS.md`. Writes only on request, after showing the diff. Ships `assets/AGENTS.template.md`. |
| `accessibility-review` | Reviewing UI for WCAG 2.2 AA risks, semantics, controls, keyboard, focus, labels, contrast, and responsive usability. |
| `browser-qa` | Verifying frontend changes with live browser checks, route smoke tests, interactions, responsive checks, console/network review, and evidence. |
| `ci-triage` | A red CI run or failing PR checks: reads the failed job logs with `gh run view --log-failed` (bounded, secrets never printed), classifies each failure as code, flaky test, environment or infra, reproduces it with the repo's own command, then hands root cause to `diagnose`. Reruns only infra failures, with the user's ok. Works from a pasted log without gh. |
| `context-budget` | Reducing duplicated rules, docs, prompts, skills, and token overhead without removing essential safety guidance. |
| `current-docs` | Checking official/current docs for version-specific APIs, SDKs, CLIs, config, hooks, or platform behavior. |
| `database-migrations` | Planning or reviewing schema/data changes with migration, rollback, and DB push reporting. |
| `delegate` | Handing a well-specified mechanical or parallel slice to another installed agent CLI (`codex exec`, `claude -p`, `opencode run`) or a subagent, only when the user wants other agents used. Each slice runs in its own git worktree with a self-contained brief, a time budget and the user's configured model; the lead reviews the branch like a PR, re-runs every check itself and integrates by merge or cherry-pick. Ships `delegate-recipes.md` (preflight, timeout, environment and write confinement per CLI). |
| `diagnose` | Debugging bugs, failures, flakes, slowness, and regressions with a red-capable feedback loop and falsifiable hypotheses. |
| `frontend-design` | Designing or improving frontend UI across repositories with coherent aesthetic direction, accessibility, and verification. |
| `grill-me` | Only on explicit request: interviews the user in decision rounds to sharpen an idea, plan or design; writes no files. |
| `handoff` | Reviewing executor evidence or compacting paused work into a trustworthy handoff with verified state and next action. |
| `implementation-plan` | Creating small verifiable implementation slices with exact files, steps, commands, and risks. |
| `minimal-implementation` | Implementing or refactoring with the smallest complete diff that fits existing ownership. |
| `pr-modernize` | An old or inherited PR: decides modernize, rework or close from its goal and what changed on the base, rebases in a disposable worktree with the PR's hooks off, compares the series with `git range-diff`, and keeps the original authors' credit. |
| `pr-workflow` | Turning finished work into logical commits that follow the repo's own convention, running the gate, pushing a branch and opening or updating a PR with gh. Never force-pushes; each commit, push and PR step needs an explicit ok. On request it also watches a PR through CI with `gh pr checks --watch`, sends red checks to `ci-triage` and open threads to `review-response`, and reports readiness without merging. Ships `assets/pr-body.template.md`. |
| `prototype` | Validating throwaway UI variants, state-machine/data-model checks, and interaction experiments before production implementation. |
| `retro` | User-invoked only (`/retro`, `$retro` in Codex): reviewing a named coding session and proposing ranked, evidence-traced improvements to steering files, checks, and tooling. Proposals only. |
| `review-response` | Working through review comments on a PR (fetched with `gh api` or pasted): verifies each claim against the code, sorts it into fix, push back with evidence, or ask, declines as follow-ups only the findings that widen the PR (never a regression, a security or data-loss finding), prefers the smaller of two fixes that both close the claim, asks before running an outside contributor's code, commits one theme at a time, and drafts one reply per thread without performative agreement. Posts replies only after explicit approval, confirms each posted URL and never resolves threads. |
| `release-check` | Running pre-merge or pre-deploy readiness checks, including tests, migrations, env risk, smoke routes, and rollback. |
| `release-notes` | Drafting user-facing release notes or a changelog section from commits and merged PRs since the last tag, in the project's own format and language: breaking changes first, internal chores excluded with reasons, human curation required. Writes into the repo's notes file only when asked, after showing the diff. |
| `screenshot-review` | Reviewing supplied UI screenshots before implementation or for responsive/layout critique. |
| `security-audit` | An explicit full codebase security audit or pen test: Cloudflare's six-phase workflow with independent verification and validated `findings.json`. Vendored (MIT); companion files and validators install next to its `SKILL.md`. |
| `security-review` | Reviewing auth, authorization, input, secrets, uploads, API endpoints, payments, shell execution, or sensitive data. |
| `status-report` | A one-file HTML status report for any repository: what happened, what is in progress and what comes next, with every item citing git, GitHub, CI or doc evidence. Ships `report.schema.json`, `assets/report-template.html` and `scripts/render-report.mjs` and `scripts/verify-report.mjs`. |
| `tdd` | Using a narrow red-green-refactor loop for behavior changes, fixes, regressions, and tests. |
| `zoom-out` | Explaining unfamiliar code in broader system context before editing. |

Domain skills for a team's own projects and stack are not bundled: keep them in a skill pack (see Skill packs below), which can also carry their routing lines.

## Routing boundaries

| Pair | Distinct roles |
| --- | --- |
| `ci-triage` / `diagnose` | Ci-triage turns a red CI run into a classified failure and a local reproduction; diagnose finds the root cause from that loop. |
| `diagnose` / `tdd` | Diagnose finds root cause; TDD locks behavior with a narrow test once the contract is clear. |
| `minimal-implementation` / `adversarial-implementation` | Minimal-implementation is one bounded patch by the current agent; adversarial-implementation runs that patch through a separate implementer and a fresh hostile critic per round, only when the user asks for it. |
| `adversarial-implementation` / `adversarial-review` | Adversarial-implementation writes a change through a critic loop; adversarial-review attacks work that already exists, or a plan, and fixes nothing. "Have a critic review it" about finished work or a plan means adversarial-review. |
| `adversarial-review` / `/code-review` | `/code-review` (or the `inspector` agent) is the routine review; adversarial-review runs a fresh critic from another route and reports only findings the lead proved, only when the user asks for it. |
| `tdd` / `adversarial-test` | TDD has the current agent write each test and then the code; adversarial-test has a separate adversary write the tests and a separate implementer fix the code against them frozen, only when the user explicitly asks for it. |
| `delegate` / `adversarial-implementation` | Delegate hands a slice to another agent and the lead reviews and verifies it once; adversarial-implementation adds a fresh hostile critic every round and runs only when the user asks for it. |
| `delegate` / `handoff` | Delegate runs another agent on a slice and verifies its branch; handoff compacts state or reviews a report another agent already produced. |
| `grill-me` / `implementation-plan` | Grill-me clarifies decisions through an explicit user-requested interview; implementation-plan turns settled scope into verifiable implementation slices. |
| `grill-me` / `prototype` | Grill-me identifies decisions that need something to react to; prototype builds throwaway variants to test them. |
| `implementation-plan` / `minimal-implementation` | Plan defines slices; minimal-implementation executes one bounded patch. |
| `frontend-design` / `screenshot-review` | Screenshot-review diagnoses static images; frontend-design chooses direction and implements. |
| `frontend-design` / `accessibility-review` | Frontend-design includes baseline a11y during implementation; accessibility-review is a specialist audit. |
| `frontend-design` / `browser-qa` | Frontend-design owns visual direction; browser-qa supplies runtime verification evidence. |
| `agents-md` / global rules | `agents-md` writes a repository's own `AGENTS.md` from verified facts; it never edits or repeats the user's global rules, which the project file complements. |
| `handoff` / `release-check` | Handoff compacts session state; release-check validates merge/deploy readiness. |
| `pr-workflow` / `release-check` | Pr-workflow commits, pushes and opens the PR, and runs the repo's gate before the push; release-check owns the go/no-go verdict on merge or deploy readiness. |
| `pr-workflow` / `ci-triage` | Pr-workflow's watch waits for the checks and reports them; ci-triage takes over when one is red or canceled. |
| `pr-workflow` / `review-response` | Pr-workflow's watch reports the open threads; review-response verifies them and drafts the replies. |
| `pr-workflow` / `pr-modernize` | Pr-workflow turns finished work into a new or updated PR and never rewrites pushed commits; pr-modernize judges an existing old or inherited PR and may rewrite its branch, only after an ok for the exact command. |
| `handoff` / `pr-modernize` | Handoff compacts state for whoever picks the work up; pr-modernize treats such a handoff as context, verifies it against the code and takes the PR forward. |
| `release-notes` / `release-check` | Release-notes drafts what changed for users; release-check decides whether the branch is ready to ship. |
| `security-review` / `security-audit` | Security-review checks a change or answers a focused question in the current context; security-audit runs a full multi-agent audit of a whole codebase only when one is explicitly asked for. |
| `security-review` / `sentinel` (agent) | Skill guides the review in the current context; where the harness has the sentinel agent (OpenCode, Claude), it performs an independent read-only review of a finished diff, otherwise the review stays inline. |
| `retro` / `context-budget` | Retro mines one named session for environment fixes; context-budget audits instruction surfaces without a session. |
| `zoom-out` / repo-scout (agent) | Zoom-out explains code context in chat; repo-scout agent maps unfamiliar repos read-only before implementation. |
| `review-response` / `/code-review` | `/code-review` (or the `inspector` agent) reviews a diff; review-response answers someone else's review of the user's PR, claim by claim. |

## Common Combinations

- Bugs or regressions: `diagnose`; add `tdd` when a narrow regression test is useful.
- Red CI run or failing PR checks: `ci-triage`, then `diagnose` for root cause.
- Code implementation: `minimal-implementation`; add `implementation-plan` for larger slices.
- Unfamiliar code: `zoom-out`, then `implementation-plan` if edits are needed.
- Frontend implementation: `frontend-design`; add `browser-qa` for runtime verification and `accessibility-review` for UI risk.
- Screenshot-driven UI: `screenshot-review`, then `frontend-design`.
- Security-sensitive changes: `security-review`; add `database-migrations` for schema/data work.
- Full codebase security audit or pen test: `security-audit`.
- Prototyping before implementation: `prototype`; add `frontend-design` for UI prototypes.
- Pausing, executor reports, or context transfer: `handoff`; add `context-budget` for large reports.
- Project status report or weekly summary: `status-report`.
- Commit, push and open or update a PR: `pr-workflow`; add `release-check` before the push.
- Watching a PR through CI, on request: `pr-workflow`; it hands a red check to `ci-triage` and open threads to `review-response`.
- Old, stale or inherited PR: `pr-modernize`; add `pr-workflow` to open a replacement and `review-response` for its open threads.
- Release readiness: `release-check`.
- Onboarding agents to a repo, or a missing or stale `AGENTS.md`: `agents-md`.
- Release notes or a changelog section: `release-notes`; add `release-check` for the gate.
- Docs, rules, or prompt consolidation: `context-budget`; add `implementation-plan` for explicit maps.
- Session retrospective: `retro`, only when the user invokes `/retro` or `$retro` (it is not routed by the rules).
- Adversarial implementation: `adversarial-implementation`, only when the user asks for it (it is not routed by the rules).
- Adversarial review of a diff or plan: `adversarial-review`, only when the user explicitly asks for it (it is not routed by the rules).
- Adversarial tests: `adversarial-test`, only when the user explicitly asks for adversarial tests (it is not routed by the rules).
- Review passes: Claude Code uses the built-in `/code-review` and `/simplify`; other harnesses use the `inspector` agent.
- Review comments on the user's PR: `review-response`; add `minimal-implementation` for the fixes.

## Skill Metadata

Bundled `SKILL.md` frontmatter follows the [Agent Skills spec](https://agentskills.io/specification): `name`, `description`, `license: MIT`, optional `compatibility` and `allowed-tools`, and Riggverk's own fields under `metadata:` as plain string values:

```yaml
---
name: browser-qa
description: Verifies frontend changes in a real browser ... Use when ...
license: MIT
compatibility: Needs browser automation, such as the Playwright MCP server Riggverk installs or the Playwright CLI (npx playwright).
metadata:
  category: frontend
  risk: medium
  targets: codex, opencode, claude, cursor, copilot, pi, kilo, antigravity, grok
  related: screenshot-review, accessibility-review, frontend-design
---
```

- `license` — `MIT` on every bundled skill, so the license travels with a copy taken out of the bundle. Third-party credits are in the repository's `NOTICE.md`.
- `compatibility` — only where a skill needs something beyond reading and editing files: subagents or another agent CLI (`adversarial-*`, full `security-audit`), browser automation (`browser-qa`), `gh` and Node.js (`status-report`).
- `metadata.category` — functional area.
- `metadata.risk` — low, medium, or high.
- `metadata.targets` — comma-separated harnesses that get the skill. Every harness reads the skills folders Riggverk installs into, so bundled skills list all nine: codex, opencode, claude, cursor, copilot, pi, kilo, antigravity, grok.
- `metadata.related` — comma-separated related skill names; the routing check verifies each name exists.
- `metadata.source` — upstream work a skill adapts or draws on (see `NOTICE.md`).
- `disable-model-invocation` — optional `true` for user-invoked skills (currently `retro`). Claude Code and Cursor then hide the skill from the model; Codex, OpenCode and the light harnesses ignore the flag, so such a skill must not be referenced in routing bullets, its description says it runs only on an explicit request and names the invocation (`/retro`, `$retro` in Codex), and its body repeats the rule.

The `adversarial-*` skills keep model invocation so plain words can start them, but each run spends several agents, so the routing check also keeps them out of routing bullets.

Claude-only frontmatter keys sit directly in the skill's frontmatter, because Claude Code reads them only there: `context`, `agent`, `background`, `disable-model-invocation`, and `allowed-tools` (for example `release-check` runs in a forked `verifier` context on Claude Code). `allowed-tools` pre-approves a command prefix, so a bundled skill lists only exact read forms (`git remote -v`, `git config --get commit.template`, `git tag --list *`, `gh auth status`, `gh pr diff *`) and never a prefix that can write, run code or print a secret (`git config *`, `git log *`, `jq *`, or a gh read command, which takes `--jq env`); `scripts/check-skill-routing.py` refuses those, and Claude Code's built-in read-only handling covers `git status`, `git log`, `git diff`, `head` and `tail` without a prompt. Codex and OpenCode ignore them. A skill that sets one of `context`, `agent`, `background` or `allowed-tools` also carries a `### Claude Code` notes section (see below).

The spec allows `allowed-tools` (experimental). The other four are outside it, and a strict validator (`skills-ref validate`, a skill upload to claude.ai or the Skills API) refuses them: today that is `retro` (`disable-model-invocation`) and `release-check` (`context`, `agent`, `background`). They stay because moving them under `metadata:` would turn the behaviour off; remove them from a copy you upload elsewhere. Every other bundled skill passes a strict validator, and `scripts/check-skill-routing.py` refuses any other top-level key in a bundled skill.

Packs and personal skills may keep `category`, `risk`, `targets` and `related` at the top level, as older releases wrote them; the app reads both layouts. When a file sets a key in both places, the non-empty `metadata.<key>` wins. A Library save writes the text as you typed it and never moves keys between the layouts.

`targets` is validated metadata and selects nothing: skills folders are shared between harnesses, so every bundled skill is installed into every folder that is wanted, flat as `<skills-folder>/<name>/`, with its `SKILL.md` and every supporting file in it. A pack or personal skill may leave `targets` out, as a skill that follows the Agent Skills spec does: it is then for every harness Riggverk supports. A target it does name must be one of the nine; an unknown one makes the skill an error. Other metadata fields are operator guidance only.

## Description standard

The `description` is the only selection signal Codex, OpenCode, and Cursor see, so it carries the triggers. Format: one plain line of at most 300 characters, `<what>. Use when <concrete triggers>. Not for <nearest sibling> (<sibling-name>).` The `Not for` clause is optional. Avoid `: ` and ` #` in the text, since the value is written as a plain YAML scalar. Each skill also states a one-line `Done when:` exit criterion in its body. `scripts/check-skill-routing.py` lints these rules.

## Supporting files

Files next to a `SKILL.md` (references, schemas, templates, scripts) install with the skill, at the same relative paths, so a skill can say "read `HUNTING.md`" or "run `scripts/verify-report.mjs`" and mean the file next to it. `security-audit` carries its reference files, `status-report` carries its schema, template and `scripts/render-report.mjs` and `scripts/verify-report.mjs`, `browser-qa` carries `playwright-cli.md` (its route when no browser tool is available), and each `adversarial-*` skill carries its own identical copy of `adversarial-roles.md` (how roles are chosen) and `critic-recipes.md` (CLI recipes for external critics). A skill is installed on its own, so it never reads another skill's files; `scripts/check-skill-routing.py` fails on a `../other-skill/` or `skills/other-skill/` reference and on adversarial copies that differ.

Rules for the files in a skill directory in the bundle: regular files only (no symlinks), names of letters, digits, `.`, `_` and `-` that do not start with a dot, at most four path levels, at most 64 files and 2 MiB in total, at most 1 MiB per file, and no `SKILL.md` below the skill's own. Dot files are ignored. A skill that breaks a rule installs nothing until it is fixed. Write paths in a skill relative to its directory; never point a skill at the workspace folder, since the installed copy lives in a skills folder.

Each file is owned on its own. An update rewrites only the files that differ, a file you edited is reported as a conflict and kept while its siblings still update, and removing a skill removes the app's files and the directories that become empty, not files you added.

## One SKILL.md for every harness

`skills/**/SKILL.md` is the only source. Managed setup copies it byte for byte into every skills folder it installs into, so a skill that two harnesses both read is the same file in both places. There are no generated per-harness copies: `templates/skills/` and `metadata/skill-adapters.json` no longer exist.

Text that only one harness should act on goes at the end of the file under `## Harness notes`, one `###` subsection per harness in this fixed order, only for the harnesses that have notes: `### Claude Code`, `### Codex`, `### OpenCode`, `### Cursor`, `### Light harnesses` (Copilot, Pi, Kilo, Antigravity and Grok together). Every harness reads the whole file, so write each note so it is clearly meant for that harness. Keep notes short and add a light-harness note only where behaviour differs, for example where a skill needs a subagent or a browser tool those harnesses may lack; harness-wide guidance lives in `templates/rules/<harness>.md`, not in a skill.

Claude Code runs `!` followed by a backtick-quoted command (and a fence opened with three backticks and `!`) when the skill loads. Other harnesses show that text literally. It is therefore allowed only inside `### Claude Code`, with a one-sentence plain-text preface saying that other harnesses should run the commands themselves (see `handoff` and `release-check`). The skill's `## Process` must already name those commands as plain steps, so the injection only saves a step on Claude Code and no other harness depends on it. The same holds for the Claude-only frontmatter keys: a harness that ignores `context`, `agent`, `background` or `allowed-tools` runs the skill inline with the same steps.

In the source repository `python3 scripts/check-skill-routing.py` validates every `SKILL.md`: frontmatter and names, spec-valid top-level keys (plus the documented Claude keys), `license` and `metadata`, the notes structure and order, injection syntax only under `### Claude Code`, Claude-only frontmatter keys only with Claude notes, and LF line endings without a BOM.

## Agent Metadata

- `metadata/agents.json` — sidecar metadata for agents under `agents/`. Does not modify agent runtime frontmatter.
- `default_skills` mirrors the skills each Claude agent header preloads (`templates/claude/agents/<role>.header.yaml`), and `targets` mirrors `metadata/agent-adapters.json`; `scripts/check-skill-routing.py` enforces both.
- Claude `repo-scout`, `inspector`, and `sentinel` have no shell (`Read, Grep, Glob`, plan mode), so the parent passes the diff or changed-file list in the prompt. The OpenCode variants read git state through their read-only bash profile.

## Installing skills

In the app, press `u` on a harness page and confirm with `y`. Skills are one global surface: the update installs the whole bundled catalog (the shared `SKILL.md` and its supporting files, flat) into the folders the enabled harnesses read, and the review lists each folder with its skill and file counts. Skills are not gated by target toggles. They come from the app's bundle and from your skill packs (below); a skill you add anywhere else in the workspace folder is not installed, and a one-off personal skill can also sit directly in a skills folder, where unknown skills are preserved.

### Skill packs

A pack is a folder of your own skills that Riggverk installs, updates and rolls back like the bundled ones. Put it in the data folder (`~/.config/riggverk/`, shown in the Workspace folder cell of the Overview):

```text
~/.config/riggverk/packs/<pack>/skills/<skill>/SKILL.md
~/.config/riggverk/packs/<pack>/skills/<group>/<skill>/SKILL.md
```

The pack name is lowercase letters, digits and hyphens. A `git clone` into `packs/` works (a skill repository with the usual `skills/<name>/SKILL.md` layout is a pack as it is), and `git pull` plus Install updates it; keep the folder writable by you only (`chmod go-w`). The skill format is the Agent Skills spec's, as the bundle uses it: `SKILL.md` with `name` and `description`, and optionally `targets` (under `metadata:` or, as older packs have it, at the top level; without it the skill is for every harness), supporting files beside it, no symlinks. `name` and `description` count only at the top level, and keys are read as YAML reads them (quotes, `|` and `>` block scalars); a key given twice, or supporting files whose names differ only in case, refuse the skill. Dot entries (`.git`, `.venv`) are skipped and never installed. Packs add skills, and a pack may add routing lines for its own skills to the rules (below); they cannot change anything else in the rules, nor agents or configs.

A pack may also hold `routing.md`: up to 30 lines like the base's "Skill routing" lines, each a `- ` bullet that names one or more of the pack's own skills in backticks, for example ``- Canvas or editor work: `my-canvas-change`.`` The next Install shows them in the rules files under `## Pack skill routing`, with a diff, before anything is written. A line that names a bundled skill or another pack's skill, or holds markup, a heading or a code fence, keeps the whole file out, and the Library's Packs view says which line.

Read a whole repository before you clone it into `packs/`: all its skills reach your agents at the next update. The app refuses a skill that breaks the rules above and flags what acts by itself, but it cannot judge what the instructions tell an agent to do. [t3dotgg/tstack](https://github.com/t3dotgg/tstack) is one example. At commit `1085050` all its skills work as a pack and through **Import skill…**, which flags only its script and its `agents/openai.yaml` files. The instructions go further: `full-stop` also triggers on a closing "Full stop." and allows force-pushes with lease on the task's branch, `full-send` also merges the PR, both replace a project's rule to ask before certain test methods, `council` and `sol-loop` use reviewers on other providers' models, and `babysit-pr` passes comments from other accounts to the agent. To take only some skills, tick them in **Import skill…** instead of cloning.

#### Importing a skill

Library → Packs → **Import skill…** takes a skill you found elsewhere into the app-owned pack `imported` (`~/.config/riggverk/packs/imported/skills/<name>/`). Drop onto the window, or give the path of, a skill folder with a `SKILL.md`, a `SKILL.md` on its own (its folder is named after its `name`), or a folder that holds several skills as `<name>/SKILL.md` or `skills/<name>/SKILL.md` (no deeper); you tick which to import. Zip files, URLs and GitHub are not read: unpack the zip first (Finder does), or clone a repository into `packs/` yourself (the dialog shows the command).

The preview copies the source into a private staging folder, never through a link, and shows what that copy holds: name, description, licence, the files with their sizes, dot entries it skipped, the whole `SKILL.md` as plain text, and flags at the top for what acts without asking or hides text: `allowed-tools`, `hooks`, `context`, `agent`, `background`, `model`, `!` commands in the body (Claude Code runs them when the skill loads), `agents/openai.yaml` (Codex), scripts and executables, binary files, and invisible format characters. Flags never refuse a skill. A skill is refused when its folder holds a link, a hard link, a special file or a second `SKILL.md`, breaks the pack limits (`SKILL.md` up to 1 MiB; 64 supporting files, 2 MiB together, 1 MiB each, four levels; ASCII file names), has a `name` that is not 1–64 lowercase letters, digits and single dashes or differs from its folder's name, has no `description`, sets a key twice, names an unknown target, is not UTF-8, or holds Unicode tag characters or bidi overrides. A skill named like a bundled one is imported only under another name (the dialog rewrites `name`); one named like a skill of another pack is refused.

**Import** publishes exactly the previewed copy, all at once, and records where it came from in `packs/imported/.riggverk-imports.json` (the source as `~/...`, the time, a SHA-256 per file and one for the whole skill). Nothing reaches an agent before the next **Update all**, where pack skills that act without asking get rows of their own in the review again. Imports are read-only in the Library: **Edit as my copy** copies one into `pack:personal`. Importing the same source again shows a diff against the import in place and replaces it with a backup; there are no background checks for updates. **Remove import** moves the skill into a backup (`backups/imports/<name>-<time>/`), and the next Update removes the installed copies, with a backup. **Undo import** takes back the last import, replacement or removal from those backups.

In the Library, Skills lists them under `pack:<name>`. A pack skill named like a bundled one is *shadowed*: the bundle's wins. When two packs both provide a skill of the same name, neither is used and both show an *error*. If a pack's folder disappears, the skills you installed from it stay as they are and show *pack missing*; **Forget pack** (Library, Skills) lets the next Install remove them, with a backup.

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

- The runtime facts get a `skill loads` row: `N skills, 1 copy each` when every name has one copy, `3 names with 2 copies` (a warning) when some have more, then up to five of those names with the folders their copies are in, and `+N more`. The `skills` row of the surfaces list adds the number, for example `current · 3 duplicates`. With the cursor on `skills`, a `reads` row names the folders the harness reads and which of them are missing.
- What a harness does with one name found twice: Claude Code reads one folder, so there is one copy. Codex lists every copy, and a plain `$name` mention then selects none of them (flagged as ambiguous). OpenCode 1.x keeps one copy per name and which one varies from run to run (flagged when the copies differ; byte-identical copies are shown as information only, not as a warning). Cursor may list every copy; that is not verified for every Cursor version, so it is reported as a possible duplicate. Copilot CLI, Pi and Kilo keep one copy by folder order: Copilot's `~/.copilot/skills` beats `~/.agents/skills` without a message, Pi's agent folder beats `~/.agents/skills` and prints a collision, and Kilo ranks `~/.claude/skills` below `~/.agents/skills` below `~/.kilo/skills`, the last one winning with a log line. When their copies differ, the page says the first folder wins and the others are hidden; byte-identical copies are information only.
- A copy is the app's when its skill is in the bundle and the file equals the bundled `SKILL.md`, the hash recorded at the last install, or a version the app shipped before. Anything else, a skill of your own or an edited bundled one, is yours. Duplicates that include a copy of yours are listed apart as `yours, Riggverk cannot fix` and never counted among the app's: the app does not touch your copies. An update removes the app's own copies from folders nobody needs, which clears the duplicates it caused.
- Only personal folders are looked at: project folders (`.claude/skills`, `.agents/skills`, `.codex/skills`, `.cursor/skills` in a repository) and managed policy folders are not. Hidden entries (Codex's `.system`) are skipped. A copy reached through a symlink or by two folders counts once, and a link that leads out of your home folder is not followed. A `SKILL.md` over 1 MiB, folders beyond the first 1000 in one skills folder, and `SKILL.md` text beyond 32 MiB in one skills folder are skipped, and the `reads` row says how many.
- Copies are matched by the `name` in the frontmatter, or the folder name without one. The `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` and `OPENCODE_DISABLE_EXTERNAL_SKILLS` switches change which folders OpenCode reads, and the app cannot see them.
