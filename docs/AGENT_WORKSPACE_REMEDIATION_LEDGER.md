# Agent Workspace Remediation Ledger

Remediation record. The June 2026 sections below are historical (audit input `agent-workspace-deep-audit-2026-06-06.md`, which is not stored in the repository). The October 2026 overhaul section is the current state; where the two disagree, October wins. The Repo Dashboard, and the Prompt Builder's repository context that depended on it, were removed afterwards; entries below that name them record what was true at the time.

## 2026-10 overhaul (branch `feat/hugrverk-overhaul`, from `main` at `66768375`)

Inputs: seven read-only audits (Rust, frontend, IPC contract, docs versus code, scripts and CI, harness templates, tests and dead code) and a skill-catalog audit. Findings were fixed in bounded slices, one commit per logical change. Release evidence for the branch comes from `./scripts/release-check.sh` and `docs/APP_RELEASE_SMOKE.md`, not from this table.

| Area | What changed | Supersedes |
|---|---|---|
| Install | Reviewed install: `u` previews, a plan table lists every create, update, remove, and conflict, `y` applies, `n` cancels. Preview and apply run off the main thread. | The one-click "install" that previewed and applied in one task. |
| Target toggles | `enabled_target_ids` now gates preview, apply, and status in the backend and the UI. `codex_config` is off by default. Settings files without `target_defaults_version` migrate once and keep every target that was enabled or already managed. | Toggles that only affected removed legacy actions and status counters. |
| Rules | Rules files are merge-managed through a marked base block. Edited blocks and unmarked files are conflicts with diff, **Convert** (changed sections move below the block, previewed, backed up) and **Leave as is** (`rules-preferences.json`). Every shipped base is kept by digest in `metadata/rules-history/`. Codex health warns about a non-empty `AGENTS.override.md`. WordPress left the shared base. | Whole-file overwrite of `AGENTS.md` and `CLAUDE.md`. |
| Setup transactions | Reconcile keeps user edits and finished manifests, one failed bootstrap adoption no longer drops the others, records that match the source refresh, JSON digests hash sorted keys, atomic writes keep file modes and use unique temp names, failed-apply rollback and retired-file removal have tests. | |
| Backups | Created owner-only (0700 dirs, 0600 files on Unix). Setup, docs, install-script, and Cursor backups are all listed. Cursor backup dirs are unique and UTC. | A list that ignored `setup/` and `docs/` backups. |
| Codex | `model` and `model_reasoning_effort` are create-only (`gpt-6.1-sol`, `xhigh`), then user-owned. Destinations resolve under `CODEX_HOME`. The TOML fallback parses inline tables and arrays. | The pinned `gpt-5.6-sol` overwrite and hard-coded `~/.codex` writes. |
| OpenCode | Permission order and quoting preserved, nested model ids accepted, subprocesses bounded, override file written atomically. | |
| CLI scripts | `install-skills.sh` defaults to dry-run and backs up before overwrite. Installers back up before overwriting and leave the target unchanged when the backup fails, pass paths to Python by argv, and guard agents and backup directories. Git Bash and MSYS are refused. Installer safety is checked in release-check. | `install-skills.sh` writing immediately without a backup. |
| Repo Dashboard | Subprocesses bounded with process-group kill. Git runs with fsmonitor and hooks disabled and no optional locks or prompts. Branches validated. `gh` lists use `--limit`, failures become warnings. History is one bounded `git log`. Pane layout, warnings strip, section keys. | The 500-record paged history and a `gh` flag that does not exist. |
| Library | Reads refuse symlinks and containment escapes, writes are atomic, loaders guard against selection races, dirty drafts survive source changes. An items list and one document pane (rendered, or its source while editing) with `:w` and `:q`. | Unguarded reads that followed symlinks. |
| Removed code | The 21 unreachable `run_action` arms and their helpers. `release_check` is the only remaining action. | |
| Keyboard UI | Terminal-style shell: tabs `1`-`9`, `h`/`l` panes, `j`/`k` lists, `/` filter, `:` command line, `?` help, `Mod+,` settings, `<` `>` and `[` `]` sections. Settings, dialogs, harness, workspace, Library, Prompt Builder, and Repo pages rebuilt as panes. Browser-only mock backend for visual QA. | Button-per-action pages and docs that named buttons which did not exist. |
| Skills and agents | 22 skills including the user-invoked `retro`. Description standard with triggers and exit criteria, semantic routing checks (`check-skill-routing.py`), proactive Claude agent descriptions with enforced tool boundaries, harness boilerplate moved from skill overlays to rules. | The 21-skill catalog. |
| Checks and CI | Skill counts derived, Rust shell spawns scanned, pinned toolchain, timeouts and `--locked`, LF enforced for bundled sources, placeholder tests replaced with assertions that can fail, tests and scripts type-checked, secret redaction extended (Basic auth, AWS secrets, npm tokens). | |
| Docs | README, contract, security model, release and smoke checklists, and the bundled user docs rewritten against the code. | The audit's FALSE and PARTIAL items (see `git log` for the docs commits). |

Superseded or corrected June items:

| ID | Status now |
|---|---|
| AW-RD-001, "Post-audit product change" | Superseded again: history is a single bounded `git log` (limit 100,000 commits, 48 MB, 120 s) instead of 500-record `--skip` pages. A shallow clone is still reported as incomplete. |
| AW-LOAD-001 | Not true: `App.tsx` loads the Brain Setup seed on mount and when the workspace path changes. |
| AW-RD-005 | Fetch now overrides the upload-pack command, forces the user's own ssh command, allows only https/http/ssh/git transports and neutralizes repo proxy commands. Repo filter drivers, credential helpers and `url.*.insteadOf` still apply, so the dashboard is for trusted repositories (see SECURITY_MODEL.md). |
| AW-RD-007 | Moot after the single `git log`; per-commit `git show` for file lists is unchanged and still unmeasured. |
| AW-REL-001 | Gates now live in `scripts/release-check/frontend-gate.sh` and `rust-gate.sh`; `release-check.sh` still holds the contract checks. |
| Test counts (25, 30, 371, 375) | Historical only. |

Open after the overhaul: `AW-CONFIG-001` and `AW-CONFIG-002` (blocked, operator decisions), wave-2 items (WordPress to a personal layer, the rules UI and workspace picker landing in the harness and Settings pages), and native webview smoke.

---

## June 2026 pass (historical)

## Session

| Field | Value |
|---|---|
| Audited commit | `53d9d2b245a41caddff3cc4961e335166ded85b4` |
| Prior remediation HEAD | `07cb1b1cd08e4f5261cf9746cbaa5d649efbaeea` |
| Follow-up pass start HEAD | `07cb1b1cd08e4f5261cf9746cbaa5d649efbaeea` |
| Correctness closure start HEAD | `0a1f69cd555f350b79e11d8cabf5fda881c9a452` |
| Implementation HEAD (verified) | `4f9bbc03967f432d7464bfd3f12f427fded64336` |
| Remote HEAD | Obtain from Git: `git rev-parse origin/main` (do not embed the evidence commit SHA here) |
| Branch | `main` |
| Verdict (June, at that HEAD) | READY FOR MANUAL WEBVIEW SMOKE; native webview smoke was blocked in the agent environment |

## Baseline (pre-edit, correctness closure)

| Gate | Result |
|---|---|
| `npm test` | pass (25 tests) |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `cargo fmt/check/clippy/test` | pass (371 tests) |
| `./scripts/release-check.sh` | pass |
| `bash ./scripts/check-ui-regressions.sh` | pass |
| `git diff --check` | pass |

## Finding status

| ID | Severity | Status | Notes |
|---|---|---|---|
| AW-CFG-001 | P1 | completed | Single OpenCode read path; draft identity + load-seq guards |
| AW-ASYNC-001 | P1 | completed | Resource ID + monotonic save-operation tokens on doc/agent/config saves |
| AW-SET-001 | P1 | completed | `mutateAppSettings` in `useAppSettingsController`; Tools uses canonical path |
| AW-SET-002 | P1 | completed | `SETTINGS_WRITE_MUTEX` single-owner recovery; read-only `load()`; corrupt backup; Rust regression tests |
| AW-TOOLS-001 | P2 | completed | `savedRepoEntriesFromSettings` view adapter; no separate backend snapshot |
| AW-PL-001 | P2 | completed | `isEditableEventTarget` |
| AW-TEST-001 | P2 | completed | Vitest + RTL; 30 tests; `npm test` in release-check |
| AW-PROC-001 | P2 | completed | `run_cmd_bounded` with caps + timeout polling |
| AW-RD-001 | P1 | superseded | Product requirement changed after audit: load every locally available commit through bounded 500-record pages, not a 500-record total cap |
| AW-RD-002 | P1 | completed | Bounded capture in process runner for repo git |
| AW-RD-003 | P1 | completed | UTF-8 byte truncation; doc listing warning |
| AW-RD-004 | P2 | completed | NUL-delimited name-status parsing |
| AW-RD-005 | P2 | completed | Noninteractive git env + 60s fetch timeout |
| AW-RD-006 | P3 | completed | 60s sync clock tick while snapshot exists |
| AW-RD-008 | P3 | completed | Component-based path validation |
| AW-TIMER-001 | P3 | completed | `useTransientStatus` with unmount cleanup |
| AW-MD-001 | P2 | completed | `SafeMarkdown` single-`pre` fenced blocks + component tests |
| AW-FONT-001 | P2 | completed | Removed `#root` zoom; font size via `--app-font-size` tokens |
| AW-DEAD-001 | P3 | completed | Removed unreachable `save_config_template` fallback |
| AW-DEAD-002 | P3 | completed | Removed unused workspace contract load/state |
| AW-LOAD-001 | P3 | completed | Removed duplicate `fetchStatus` + startup `loadBrainSetupSeed` |
| AW-DOC-001 | P3 | completed | Historical labels on prior audit docs |
| AW-REL-002 | P3 | completed | Codex apply log + UI regressions script use mktemp + trap |
| AW-REL-001 | P3 | completed | Extracted `frontend-gate.sh` + `rust-gate.sh`; release-check delegates (not fully modularized) |
| AW-ARCH-001 | P2 | completed | `useLibraryController` + prior extractions |
| AW-RD-007 | P3 | deferred | N+1 git show retained; optimize only if measured |
| AW-TYPES-001 | P3 | deferred | Contract fixture tests via Vitest; no generated bindings |
| AW-CONFIG-001 | Decision | blocked | Bundle id `.app` migration needs operator plan |
| AW-CONFIG-002 | Decision | blocked | Schema URL needs official Tauri 2 verification |

## Verification (cumulative, correctness closure)

| Gate | Result |
|---|---|
| `npm test` | pass (30) |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `cargo fmt --check` | pass |
| `cargo check` | pass |
| `cargo clippy -D warnings` | pass |
| `cargo test` | pass (375 unit + 1 runtime smoke in release-check) |
| `./scripts/release-check.sh` | pass |
| `bash ./scripts/check-ui-regressions.sh` | pass |
| `./scripts/smoke-tauri-runtime.sh` | pass (backend IPC only) |
| `git diff --check` | pass |
| Native Tauri webview smoke (`docs/APP_RELEASE_SMOKE.md`) | **BLOCKED** — no macOS Tauri webview automation in agent environment |

## Post-audit product change: complete commit history

The previous 500-record total cap was intentionally removed after operator review. Repo Dashboard now reloads the full commit history available in the local checkout using bounded 500-record `git log` pages against a frozen `HEAD`. Each subprocess keeps timeout and output limits. A shallow clone is reported as incomplete because commits absent from the local object database cannot be displayed.

This post-audit change was written directly through the GitHub connector. It required local Rust formatting, check, Clippy, tests, release-check, and manual Repo Dashboard smoke before the audit could be marked fully closed. Superseded in October 2026 by a single bounded `git log` (see the table above).

## Native webview smoke (manual checklist)

Operator must run before sharing builds:

- [ ] App launch; Start and Workspace health
- [ ] Library document, agent, and OpenCode config source switching
- [ ] Save and dirty-state behavior after fast selection changes
- [ ] Fenced code blocks and copy controls
- [ ] Small, medium, and large font settings
- [ ] No console errors; no credential-bearing output

## Deferred / blocked (no further autonomous work)

| ID | Action needed |
|---|---|
| AW-CONFIG-001 | Operator plan for bundle id `.app` migration |
| AW-CONFIG-002 | Verify Tauri 2 schema URL against official docs |
| AW-RD-007 | Optimize N+1 `git show` only if measured in production |
| AW-TYPES-001 | Generated TS bindings — optional future work |
| Webview smoke | Operator runs `docs/APP_RELEASE_SMOKE.md` |

## Commit log (correctness closure)

Chronological order from `3e5a78cf` through implementation HEAD `4f9bbc03`. The docs commit `0a1f69cd` also contained minor verification-driven code cleanup.

```
07cb1b1c docs(audit): finalize remediation ledger at ARCH completion
04d5d24d fix(settings): unify repo mutations through app settings controller
c57329db fix(settings): lock read-modify-write and recover corrupt settings safely
54229d88 fix(library): bind save completion to editor operation identity
41fb2b20 fix(markdown): render fenced code through react-markdown pre boundary
0a1f69cd docs(audit): record follow-up remediation evidence and gate results
a812d496 fix(settings): serialize recovery under SETTINGS_WRITE_MUTEX
9b1de77d fix(settings): preserve corrupt-file recovery warning in UI
604436c3 fix(library): make save-operation tokens monotonic and checkable
4f9bbc03 fix(settings): satisfy clippy in concurrent recovery test
```

After push, confirm remote alignment with `git rev-parse origin/main`.
