# OpenCode Config

## Source template

The runtime OpenCode configuration is `templates/opencode.json`. This is a **generated snapshot** — do not edit it directly. The app installs from its bundled copy of these templates; edits to the workspace copy change what the Library shows, not what OpenCode receives.

The maintainable source files are:

- **`templates/opencode.base.json`** — non-permission config (model, provider, watcher, compaction, etc.)
- **`templates/opencode.policy.json`** — permission policy in a compact grouped format

To regenerate the snapshot after changing a source file:

```
python3 scripts/generate-opencode-config.py --write
```

To verify the snapshot is current (used by CI/release checks and by the OpenCode runtime pane, which runs the bundled copy of the generator):

```
python3 scripts/generate-opencode-config.py --check
```

Python 3 must be on `PATH`.

The template defines:

- Share settings (recommended: disabled)
- Model selection via `model` and `small_model`
- Default primary agent via `default_agent`
- Playwright MCP through on-demand `npx` with a pinned package version, user-local MCP config, and shared browser cache (not `@latest`)
- Permission model (which operations are allowed, denied, or require asking)
- File-scope read/edit deny rules for secrets and credentials
- Watcher ignore patterns

Playwright MCP is defined in `templates/opencode.base.json` and included in the generated `templates/opencode.json`.

Defaults:

- Package: `@playwright/mcp@0.0.48` (`PLAYWRIGHT_MCP_VERSION` overrides it)
- MCP config: `~/.config/playwright-mcp/config.json` (or `PLAYWRIGHT_MCP_CONFIG_PATH`) from `templates/playwright-mcp.config.json`
- Browser: **Chromium** via MCP config (`browserName: chromium`, `isolated: true`) — not the Chrome channel
- Binaries: shared cache (`~/Library/Caches/ms-playwright` on macOS, `$XDG_CACHE_HOME/ms-playwright` on Linux, `~/AppData/Local/ms-playwright` on Windows; `PLAYWRIGHT_BROWSERS_PATH` overrides)

On macOS, Playwright’s Chromium bundle may still show **Google Chrome for Testing.app** inside the cache. That is expected and is not the same as requiring Chrome Stable/Beta/Dev/Canary.

Do **not** set `PLAYWRIGHT_BROWSERS_PATH=0`. That forces project-local browsers under `node_modules` and defeats the shared-cache default.

The app installs the Playwright MCP config with the OpenCode config target and renders user-specific paths into the OpenCode MCP entry. The Cursor page merges only the `playwright` server into `~/.cursor/mcp.json` (existing servers are preserved; existing files are backed up first).

Security note: Playwright MCP provides privileged browser automation tools. Its documented default tool list includes an unsafe code execution tool, and no stable server-side option to disable only that tool is currently documented. Do not use it on private or authenticated sites unless the runtime agent permissions and prompt scope are appropriate. Isolated sessions do not persist logged-in browser state between runs.

Local MCP checks:

```
npx -y @playwright/mcp@0.0.48 --help
opencode mcp list
```

If browser binaries are missing, install Chromium with:

```
npx -y playwright install chromium
```

## OpenCode agents

OpenCode agent definitions live at `agents/*.md` in the workspace. Six bundled agents are provided:

- `agents/architect.md` — Default coding architect/orchestrator
- `agents/repo-scout.md` — Repository structure explorer
- `agents/inspector.md` — Code inspection/review agent
- `agents/sentinel.md` — Security sentinel/audit review
- `agents/scribe.md` — Documentation writer
- `agents/verifier.md` — Non-destructive verification runner

`templates/opencode.json` defines global `model`, `small_model`, and `default_agent`. Agents are model-agnostic by default — model selection is centralized in `templates/opencode.json`. Per-agent model pinning is intentionally avoided unless a future runtime constraint requires it.

## Permission model

OpenCode agent permissions are composed at generation time from `templates/opencode.policy.json` (base policy and shared secret matrix) plus `templates/opencode/agents/*.role.json` (small role overrides). Restrictive roles declare `composition.replace_sections` so bash or edit profiles replace inherited sections instead of shallow-merging them. Shared secret denials stay in the base policy; role files do not duplicate the full matrix.

Role boundaries:

- **architect** — implementation edits, bounded bash, approved subagent delegation
- **repo-scout**, **inspector**, **sentinel** — read-only by policy (no edit, no task delegation, exact inspection bash only; no argument wildcards, and redirects and shell composition are denied by rule — see "Limits of bash rules" for what a rule cannot see)
- **verifier** — exact non-destructive test/lint/build/cargo commands only; no source edit, git staging/commits, fix modes, snapshot updates, or arbitrary trailing arguments. Project-owned verification scripts are a deliberate trust boundary: they may create disposable build/test artifacts, but the Verifier profile must not receive arbitrary arguments beyond the reviewed exact command forms.
- **scribe** — documentation paths only (`README.md`, `docs/**`, and related doc files); no source-code edit or mutating bash

In the app source repository, `scripts/validate_opencode_permissions.py` asserts the composed contract and `scripts/generate-agent-adapters.py --check` verifies deterministic generated adapters; neither ships in the installed workspace. The validator evaluates rules the way OpenCode 1.19.3 does (worktree-relative read/edit paths, one bash pattern per command of a compound, built-in agent rulesets); the shell splitting was checked against the installed OpenCode with `opencode debug agent <name> --pure --tool bash`.

The default template is conservative:

- Sharing is disabled
- Most operations default to "ask"
- Read access is broadly allowed except for secret-bearing files (`.env` files, SSH private keys, kubeconfig, Terraform state/vars, Ansible vaults, shell history, local credential files)
- The native `read` tool honors read-deny rules. `grep` does not: it only asks the `grep` permission (allowed) and then returns matching lines from every file ripgrep reads, so it can show the contents of any file that is not gitignored, even one that `read` denies. Keep secrets gitignored or outside the project. `glob` and `list` return names only
- Bash content commands (`cat`, `head`, `tail`, `sed`, `grep`, `rg`, `git grep`) are ask-gated because bash permissions are separate from read permissions
- Secret-file protections exist in read, edit, and bash permissions for: `.env` files, SSH private keys (`id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`), `kubeconfig` and `.kube/**`, Terraform state/vars (`terraform.tfstate*`, `terraform.tfvars`, `*.tfvars`), Ansible vault files (`vault.yml`, `secrets.yml`), shell history (`.bash_history`, `.zsh_history`), and local credential files (`master.key`, `.pgpass`, `.my.cnf`, `.envrc`, `*.ppk`, `*.jks`, `Pulumi.*.yaml`)
- OpenCode matches read and edit rules against the path relative to the worktree, and `**/P` needs a `/` before `P`. Every `**/P` secret rule therefore has a root twin `P`, so `wp-config.php`, `.npmrc`, `server.key`, `.git/config` and `secrets/**` are protected at the worktree root and nested; files outside the worktree match `**/P` through their `../` prefix
- Edits are allowed under common source directories (`src/**`, `app/**`, `lib/**`, `tests/**`, `docs/**`, `scripts/**`, WordPress themes, ...) and for `*.md`, `*.ts`, `*.tsx`, `*.js`, `*.jsx`, `*.css` and `*.scss` files anywhere in the worktree. Everything else asks, as do package manifests and lock files, `AGENTS.md`, `opencode.json`, `.opencode/**`, workflows and skill folders outside the worktree. Secret files are denied
- Destructive commands (`sudo`, `rm -rf`, `git reset --hard`, `git clean -fdx`) are denied globally and in each agent. So is piping into a shell (see "Compound commands"); other interpreters such as `python3` or `node` still ask
- Cargo verification commands (`cargo fmt`, `cargo check`, `cargo clippy`, `cargo test`) are allow-listed where verification is expected
- `git checkout` and `git pull` are ask-gated because they can change working-tree state at runtime
- `npm run dev` and other dev server commands are ask-gated in the bundled default starter template

### Compound commands

OpenCode 1.19.3 parses a bash call with tree-sitter and asks the `bash` permission once per command node, with that node's own text: `a | b`, `a && b`, `a || b`, `a ; b`, `a & b`, a newline, a subshell and the contents of `$( )`, backticks and `<( )` are separate commands, and the strictest answer wins (deny, then ask, then allow). `cd`, `export`, `declare`, `readonly`, `local`, `unset` and `[ ]` tests are not matched. Consequences for the rules:

- `curl … | bash` is the two commands `curl …` (ask) and `bash`. A rule like `*|bash` can never match it, so the bare shells are denied instead: `bash`, `sh`, `zsh`, their `-` forms and `-s*` forms. `bash script.sh` and `bash -c …` are different commands and keep asking
- Rules that look for an operator inside a command (`*|*`, `*&&*`, `*;*`, `*||*`) only match when the operator is quoted or inside a substitution. The read-only profiles keep them as defense in depth; what actually stops `git status && touch x` there is that `touch x` is evaluated on its own and the profile denies by default
- A redirect stays in the command it follows (`git status > f` matches `*>*`), but a redirect after a later `|`, `&&` or `||` element is not part of any command (`git status && git status > f` is evaluated as `git status` twice)

### Limits of bash rules

- The redirect gap above is OpenCode behaviour, not something a rule can see: an allow-listed command can write a file when a redirect hides behind a second command, in every bash profile, including the read-only roles. Treat those roles as read-only by policy, and review what they run
- `bash -c "…"`, `eval` and scripts run commands that no rule sees; they ask by default
- `grep` ignores read-deny rules (see above)
- The permission rules are not an OS sandbox

### Built-in agents (`plan`, `explore`)

OpenCode builds its built-in agents as defaults, then the agent's own restriction, then the global `permission`, so the global block of this template would re-open `plan` ("Disallows all edit tools") and `explore` (read-only) for edits and delegation. The template therefore carries `agent.plan.permission` and `agent.explore.permission`, which OpenCode appends after the global block:

- **plan** — `edit` is denied except plan files (`.opencode/plans/*.md` and `*opencode/plans/*.md`, which covers the plan folder in OpenCode's data dir); `question` and `plan_exit` are allowed; `task` is limited to `explore`, `repo-scout`, `inspector`, `sentinel` and `verifier`, so plan cannot delegate to `general` or `scribe` and edit that way. Bash follows the global profile
- **explore** — the `repo-scout` read-only profile with a deny default: no edit tools, no `task`, no `todowrite`, no MCP tools, the read-only bash profile and the same secret read denies

The bundled agents (`architect` and the five subagents) keep self-contained permission blocks. `build` and `general` follow the global block (including `question: deny`). Both entries are managed sub-entries, so your own `agent.*` keys, including other keys of `agent.plan`, are preserved on install.

### External directories

A bare `external_directory: ask` would cancel OpenCode's built-in allowance for skill folders, so reading a skill's supporting files outside the worktree would prompt every time. The template keeps `"*": "ask"` and restates the allowance for the folders OpenCode loads skills from: `~/.claude/skills/*`, `~/.config/opencode/skills/*` and the `skills` folder under `~/.agents`. Because `*.md` edits are allowed, editing a file in those folders from another worktree still asks. OpenCode's tool-output folder is re-added by OpenCode itself. OpenCode's own temp folder (`<os temp dir>/opencode`) is not restated: its path differs per platform and cannot be written as a stable pattern, so reading there prompts.

## TUI config

`templates/tui.json` controls TUI-only preferences such as theme, diff layout, mouse, scroll behavior, and leader timeout. It installs to `~/.config/opencode/tui.json` with the OpenCode config target.

## Managed-key merge

Install does **not** overwrite the entire installed `opencode.json`. It merges only the keys listed in `metadata/opencode-managed-keys.json` (model, permissions, the `permission` block of the built-in `plan` and `explore` agents, Playwright MCP, compaction, watcher, and related settings). User `provider` blocks, non-Playwright MCP servers and other `agent` entries are preserved. Managed keys are reset to the bundled values on every update, so keep your own settings in unmanaged keys.

Legacy `~/.config/opencode/agents/scout.md` files from the pre-rename Agent Workspace scout are removed on agent sync when frontmatter is `name: scout`.

## Install workflow

1. Open the OpenCode tab. The `opencode_config`, `opencode_agents`, and `opencode_rules` targets decide what is installed (Space toggles).
2. Press `p` to preview or `u` to review, then `y` to apply.
3. The install merges the managed keys into `~/.config/opencode/opencode.json`, writes `tui.json`, the Playwright MCP config, and `~/.config/opencode/agents/*.md`. Extra agent files already in that directory are not deleted.

Both JSON files are validated before and after the write. Existing files that differ are backed up first.

## App-level model override

The OpenCode tab has a model override in its runtime pane (`e` edit, `s` save, `R` reload the model list). A saved selection is stored in an app-level override file:

| Platform | Override file |
|----------|---------------|
| macOS | `~/Library/Application Support/ai.agentworkspace.app/opencode-model-selection.json` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/ai.agentworkspace.app/opencode-model-selection.json` |
| Windows | `%APPDATA%\ai.agentworkspace.app\opencode-model-selection.json` |

This file is **not** part of the workspace templates. It is an app-preference file stored outside the workspace source tree. It does not affect `templates/opencode.base.json` or `templates/opencode.json`.

The override takes effect on the next OpenCode install (`u`, `y`). The installed `~/.config/opencode/opencode.json` receives the selected model and small_model from the override file. Workspace templates are not mutated.

If no override exists, the workspace `templates/opencode.base.json` values are used as the source of truth for model selection.

To remove the override, delete the file for your platform and install again:

| Platform | Command |
|----------|---------|
| macOS | `rm "$HOME/Library/Application Support/ai.agentworkspace.app/opencode-model-selection.json"` |
| Linux | `rm "${XDG_CONFIG_HOME:-$HOME/.config}/ai.agentworkspace.app/opencode-model-selection.json"` |

The override is safe to delete; the app falls back to workspace template defaults.

## Customization

Installed OpenCode config and agent files are yours to change, but managed keys and bundled agent files are reset or reported as conflicts on update. For lasting changes use unmanaged keys (providers, other MCP servers) and your own agent files with different names in `~/.config/opencode/agents/`. To change the bundled policy or agents for everyone, edit the sources (`templates/opencode.base.json`, `templates/opencode.policy.json`, `agent-specs/`) in the app source repository. Avoid weakening the secret-file deny rules in the `read`, `edit`, and `bash` sections.
