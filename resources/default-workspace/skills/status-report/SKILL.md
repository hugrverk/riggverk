---
name: status-report
description: Builds a one-file HTML status report of what happened, what is in progress and what comes next in any repository, from cited git, GitHub, CI and doc evidence. Use when asked for a status report or a sprint or weekly summary.
license: MIT
compatibility: Needs git, an authenticated gh CLI and Node.js for the bundled render and verify scripts; the browser check uses Playwright when it resolves.
allowed-tools: Bash(git tag --list *)
metadata:
  category: workflow
  risk: low
  targets: codex, opencode, claude, cursor, copilot, pi, kilo, antigravity, grok
  related: handoff, release-check, browser-qa
---

# Status Report

Produces one HTML file (no dependencies beyond an optional web-font load) that shows a developer, lead or stakeholder what happened, what is happening and what comes next in a project during a period, with every statement backed by cited evidence. Not for release notes, PR descriptions or a short status reply in chat. Requests in any language for a status report mean this skill.

Done when: `report.json` and the HTML pass `verify-report.mjs`, the file is outside version control, and the user has the path plus a three-line summary that names the gaps.

## Bundled files

`<skill-dir>` is the directory that holds this `SKILL.md`.

- `report.schema.json`: the data contract. Read it before writing `report.json`.
- `assets/report-template.html`: the design, dark, with labels in Swedish or English. It loads Fraunces and Inter from Google Fonts when online and falls back to system fonts offline. Never edit it per report; pass `--template <file>` when the user names another.
- `scripts/render-report.mjs` and `scripts/verify-report.mjs`: Node 18+, no dependencies.

## 1. Scope and period

- Repository: the current one unless the user names another. Read from the default branch on the remote (`git fetch --quiet origin`, then `origin/<default>`), never only from a checkout that may be stale.
- Period: what the user says ("this sprint", "since v2.3", "October"). Default: the 14 days ending today, in the user's time zone. A tag or milestone start becomes `period.from`.
- Previous period: the same length directly before; only metric deltas use it.
- Work in a folder outside the repo: `<os-tmp>/status-report/<repo>-<to>/` (`node -p "require('os').tmpdir()"`). Write inside the repo only to a folder `git check-ignore` confirms.

## 2. Gather evidence

Read each source once with bounded output, and record each command or file with the time read as a `sources` entry.

- Commits: `git log origin/<default> --since='<from> 00:00' --until='<to> 23:59:59' --no-merges --format='%h%x09%ad%x09%s' --date=short`; per-day counts with `--format=%ad --date=short`.
- Tags: `git tag --list --sort=-creatordate --format='%(refname:short)%09%(creatordate:short)'`.
- Releases: `gh release list --limit 50 --json tagName,name,publishedAt,isDraft`.
- PRs: `gh pr list --state merged --search "merged:<from>..<to>" --limit 200 --json number,title,mergedAt,labels`, and `--state open --json number,title,isDraft,reviewDecision`.
- Issues and milestones: `gh issue list --state open --json number,title,labels,milestone`, `gh api repos/{owner}/{repo}/milestones`.
- CI: `gh run list --branch <default> --limit 10 --json workflowName,conclusion,createdAt`, `gh workflow list --all`.
- Docs: `git show origin/<default>:<path>` for CHANGELOG, release notes, ROADMAP, TODO, BACKLOG, DECISIONS or ADRs.

Degrade, never guess:

- No `gh`, no login, or another forge: use that forge's CLI if it is installed and logged in, else git only. Take PR numbers from merge subjects (`Merge pull request #12`, `(#12)`) and releases from tags.
- No network: skip the fetch, use the local remote-tracking refs and say how old they are.
- No git: use dated entries in CHANGELOG and docs only; drop metrics and trends that need history.
- Each loss becomes one line in `gaps`, such as "CI not checked: gh is not logged in".

## 3. Verified versus claimed

- A fact enters the report only with a `cite` to a source that shows it. No source, no item.
- What the user, a brief or a chat says without repo evidence is a source of kind `stated`. The template marks items that cite only `stated` sources as claimed.
- Metrics are counts, never estimates. `progress` needs `progress_basis` from a count, such as "7 of 10 milestone issues closed".
- Interpretations (health, risk wording, confidence) cite the facts they rest on.
- An empty section stays empty. Do not pad `happening` or `next`.

## 4. Write report.json

Follow `report.schema.json`. Per section:

- `health`: `blocked` when a high risk or blocked work stops the next release or milestone; `at-risk` for a high risk, failing CI on the default branch, or a dated next step whose dependencies are open; otherwise `on-track`. One-sentence summary.
- `metrics`: at most six counts with a `delta` against the previous period. `trend` has one bucket per day (up to 31 days) or per week, oldest first; a period total equals its trend sum.
- `happened`: at most 20 highlights, newest first. Group related PRs into one item (`ref` "#118–#124"), prefer releases, features, fixes and security over chores, and write titles for the reader instead of pasting commit subjects.
- `happening`: open PRs, active milestones and work a tracked doc or the user marks as in progress.
- `next`: planned items with `when` only if a source states a date or milestone. `confidence`: high = scheduled with no open dependency, medium = planned or stated, low = an idea, research or blocked.
- `risks` and `decisions`: only with evidence. A decision needs a recorded why.
- `sources`: one entry per command or file actually read, with the time it was read.

## 5. Render

```bash
node "<skill-dir>/scripts/render-report.mjs" <work>/report.json --out <work>/<repo>-status-<to>.html
```

All content lands in the markup, so the file reads without JavaScript (Quick Look, mail previews, print).

## 6. Verify

```bash
node "<skill-dir>/scripts/verify-report.mjs" <work>/report.json <work>/<repo>-status-<to>.html [--playwright-dir=<dir>]
```

It checks the schema and cross-field rules (cites resolve, dates in the period, health against risks), leak patterns, external requests, and that every title is in the no-JS markup. The browser pass runs only with `--playwright-dir=<dir>`, a directory you made and the user approved. Never point it at the repository, the current directory or any folder you did not create: the script runs the `playwright` package from there. To run the pass, ask first, then install into a fresh `mktemp -d` outside the repository (`npm init -y` and `npm i playwright` there, then `<dir>/node_modules/.bin/playwright install chromium`). Without the flag it skips the pass, and a `SKIP` line means that pass did not run, so report it as not verified. Fix the data and rerun until it prints `PASS`.

## 7. Deliver

- Never commit the report. Send the file with the harness's file-send tool when it has one; otherwise give the absolute path.
- Reply in the user's language with the health verdict, the two or three facts that matter most, the gaps, and whether the browser pass ran.

## Language

All copy in `report.json` is in the user's language, and `project.language` follows it. The renderer has Swedish and English labels; any other language gets English labels around the user's copy. Write plainly for a reader who is not a developer and explain jargon or avoid it.

## Redaction

- Never include secrets, tokens, cookies, auth headers, `.env` values, private keys or credential-bearing config.
- Reduce remote URLs to `owner/name`; a remote URL can carry a token.
- People appear by handle or role, never by e-mail. Paths are repo-relative or start at `~`.
- No customer data, internal hostnames or private tokenized URLs. Ask before a report from a private repository goes outside the team.

## Harness notes

### Claude Code

Claude Code runs the commands below when the skill loads; in other harnesses they appear as plain text, so run them yourself.

- Default branch ref (this is `origin/<default>`): !`git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null`
- Latest tags: !`git tag --list --sort=-creatordate 2>/dev/null | head -5`
- Recent commits: !`git log --oneline -10 2>/dev/null | head -c 800`
