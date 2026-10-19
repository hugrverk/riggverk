# OpenCode Config

## Supported OpenCode version

Riggverk manages the **OpenCode 1.x** config format (`opencode.json`, `tui.json`, `agents/*.md`) and is verified against OpenCode 1.19.3. Install 1.x with npm (`npm i -g opencode-ai`) or the Homebrew tap (`brew install anomalyco/tap/opencode`). Homebrew core's `opencode` formula installs **2.x**, so check `opencode --version` after installing.

OpenCode 2.x is detected, not supported. It migrates the 1.x config in memory and does not read `tui.json`. The OpenCode runtime pane shows the detected version in its `cli` row and warns on 2.x. A 2.x-native config is a separate future project; until then Riggverk keeps writing the 1.x keys. On 2.x the model list is read with `opencode models --standalone` (2.x has no `--pure`, and without `--standalone` it would use a background service); on 1.x it is `opencode models --pure`.

The CLI is looked up on `PATH`, then in `/opt/homebrew/bin`, `/usr/local/bin` and `~/.opencode/bin` (the official installer's directory), because an app started from Finder has a short `PATH`.

## Config folder

OpenCode reads its global config from `$XDG_CONFIG_HOME/opencode` when `XDG_CONFIG_HOME` is set, else from `~/.config/opencode`, on every OS. Riggverk installs, checks and removes its OpenCode files (`opencode.json`, `tui.json`, `AGENTS.md`, `agents/`) in that same folder, and looks for `config.json` and `opencode.jsonc` there. A relative `XDG_CONFIG_HOME` is ignored, as the XDG specification calls it invalid. A folder outside the home directory is the allowlisted root of these files. The labels say `$XDG_CONFIG_HOME/opencode` while the variable moves the folder; on this page `~/.config/opencode` stands for whichever folder is in effect. Riggverk sees the environment it was launched with, so set the variable where the app starts too (opened from Finder or the Dock it does not see your shell profile).

When `XDG_CONFIG_HOME` changes, the next install writes to the new folder. The files at the old folder stay as they are: the app neither updates nor removes them, uninstall included, so delete them yourself when you no longer need them.

`OPENCODE_CONFIG_DIR` points OpenCode at one more folder, read after the global one. The runtime pane warns while it is set; the app never installs there.

## Runtime health probes

The OpenCode runtime pane compares files, and it also asks the installed CLI three things that files cannot show. Each probe has a timeout and an output cap, runs from a neutral working directory (the system temp folder, so no project config is picked up), and keeps only an exit status or a version number. Raw CLI output is never stored or logged.

| Probe | Result |
|-------|--------|
| `opencode --version` (10 s) | The `cli` row, and the 1.x or 2.x code path below |
| `opencode debug agent <default_agent> --pure` (20 s, 1.x only) | Exit 0 means the default agent parses and resolves. A non-zero exit warns, usually for a frontmatter error in an agent file that OpenCode otherwise skips silently |
| `opencode models --pure` (30 s; `--standalone` on 2.x) | `model`, `small_model` and, when one is installed, the subagent model must be listed. A missing one warns. OpenCode does not pick another small model when `small_model` is set but unknown. A model only appears while its provider is signed in |

A missing CLI, a timeout or a failing probe leaves those checks `unknown`. It never fails the health or changes its status. The rows of the pane: `cli` (version, or "not found" with the install options), `default agent`, `autoupdate`, `rules` (global `AGENTS.md` against the bundled rules), `agents` (`synced` with the installed count, or the count and then the files that differ or are missing), `config` (synced or diverged, with the names of the managed keys that differ, and `has comments` when the file is JSONC), `overrides` (only when something below changes the config OpenCode runs), `mcp playwright` (the pinned version, with `synced` or `diverged`) and `tui` (synced or diverged, with the names of the managed keys that differ). Apart from the default agent and `autoupdate`, the rows show names and statuses, never a value from a file.

## Other config OpenCode reads

OpenCode 1.x does not read `opencode.json` alone. In the global folder it merges `config.json`, then `opencode.json`, then `opencode.jsonc` (a later file wins), and all three may have comments and trailing commas. Environment variables, project files and a system managed config come on top (checked against OpenCode 1.19.3). The runtime pane reports what of that it can see, so `synced` means OpenCode runs the team's values. It shows names only, never values: these files and variables can hold provider keys.

- **A commented `opencode.json`.** Health reads it as JSONC, so the `config` row still says synced or diverged. Install writes strict JSON only, so it leaves such a file as is, and the review and a warning say why. To let the app update it again, move your own settings and their comments to `opencode.jsonc` and keep `opencode.json` strict JSON. A trailing comma or a byte order mark alone only needs removing.
- **`opencode.jsonc` and `config.json` beside it.** When one sets a managed key (a top-level managed key, `mcp.playwright`, `agent.plan.permission`, `agent.explore.permission` or `agent.<role>.model`; `$schema` does not count), the runtime turns diverged, the `overrides` row names the file and the keys, and a warning says what to remove. `opencode.jsonc` wins over the team's values; `config.json` is merged under them, so its permission rules, MCP servers and agent blocks combine with the team's. An install does not fix this: the app never writes these files.
- **Environment variables.** The pane names `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_PERMISSION`, `OPENCODE_DISABLE_PROJECT_CONFIG` and `OPENCODE_DISABLE_CLAUDE_CODE*` when they are set, and `OPENCODE_CONFIG_DIR` gets a warning of its own that names the folder the app installs to. The app sees the environment it was launched with, not your shell's: opened from Finder or the Dock it does not see what your shell profile exports, so check your shell yourself.
- **System managed config.** The pane says when `/Library/Application Support/opencode` or the managed preferences `ai.opencode.managed.plist` (macOS), `/etc/opencode` (Linux) or `%ProgramData%\opencode` (Windows) exists. It overrides your config files, the team's values included. Only the path's existence is checked; nothing there is opened.

Variables, project files and the system managed config do not change the runtime status: the app cannot see what they set.

## Source template

The runtime OpenCode configuration is `templates/opencode.json`. This is a **generated snapshot** — do not edit it directly. The app installs from its bundled copy of these templates, and the Library shows them read-only; edits to the workspace copy made outside the app change what the Library shows, not what OpenCode receives. Runtime health and dashboard config status compare against that same bundled render, including saved model overrides. TUI, rules and agents also use the bundled sources; workspace edits do not cause installed-file drift.

The maintainable source files are:

- **`templates/opencode.base.json`** — non-permission config (model, provider, watcher, compaction, etc.)
- **`templates/opencode.policy.json`** — permission policy in a compact grouped format

To regenerate the snapshot after changing a source file:

```
python3 scripts/generate-opencode-config.py --write
```

To verify the workspace snapshot is current (the release check does the same for the shipped snapshot; the OpenCode runtime pane checks the bundled sources and snapshot with the bundled copy of the generator):

```
python3 scripts/generate-opencode-config.py --check
```

Python 3 must be on `PATH`.

The template defines:

- Share settings (recommended: disabled)
- Model selection via `model` and `small_model`
- Default primary agent via `default_agent`
- Playwright MCP through on-demand `npx` with a pinned package version, user-local MCP config, and shared browser cache (not `@latest`)
- `lsp: true` (built-in language servers, see "Language servers (LSP)"); `formatter` is omitted, so formatters stay off
- Permission model (which operations are allowed, denied, or require asking)
- File-scope read/edit deny rules for secrets and credentials
- Watcher ignore patterns

Playwright MCP is defined in `templates/opencode.base.json` and included in the generated `templates/opencode.json`.

Defaults:

- Package: `@playwright/mcp@0.0.48` (`PLAYWRIGHT_MCP_VERSION` overrides it)
- MCP config: `~/.config/playwright-mcp/config.json` (or `PLAYWRIGHT_MCP_CONFIG_PATH`) from `templates/playwright-mcp.config.json`
- Browser: `browserName: chromium` and `isolated: true` in the MCP config. On `@playwright/mcp@0.0.48` that configuration resolves to the `chrome` channel, that is the system Google Chrome, not Playwright's bundled Chromium (which `--browser chromium` selects); this was read from the resolved configuration, not from a launch. Verify with one real launch before relying on either
- Binaries: shared cache (`~/Library/Caches/ms-playwright` on macOS, `$XDG_CACHE_HOME/ms-playwright` on Linux, `~/AppData/Local/ms-playwright` on Windows; `PLAYWRIGHT_BROWSERS_PATH` overrides)

On macOS, Playwright’s Chromium bundle may still show **Google Chrome for Testing.app** inside the cache. That is expected and is not the same as requiring Chrome Stable/Beta/Dev/Canary.

Do **not** set `PLAYWRIGHT_BROWSERS_PATH=0`. That forces project-local browsers under `node_modules` and defeats the shared-cache default.

The app installs the Playwright MCP config with the OpenCode config target and renders user-specific paths into the OpenCode MCP entry. The Cursor page merges only the `playwright` server into `~/.cursor/mcp.json` (existing servers are preserved; existing files are backed up first). Both entries pass `--config` with that file, and the server fails to start when the file is missing, so with the OpenCode config target off the Cursor entry has no config to read. The GitHub Copilot, Pi and Kilo entries do not depend on it: they pass `--browser chrome --isolated` instead (see `docs/WORKSPACE_CONTRACT.md` in the app repository).

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

OpenCode agent definitions live at `agents/*.md` in the workspace. The bundled agents are:

- `agents/architect.md` — Default coding architect/orchestrator
- `agents/repo-scout.md` — Repository structure explorer
- `agents/inspector.md` — Code inspection/review agent
- `agents/sentinel.md` — Security sentinel/audit review
- `agents/scribe.md` — Documentation writer
- `agents/verifier.md` — Non-destructive verification runner

`architect` is the primary agent. `inspector` and `verifier` are subagents you can run directly: type `@inspector` or `@verifier` in the prompt. `repo-scout`, `sentinel` and `scribe` are `hidden: true`, which removes them from `@` autocomplete; the architect still delegates to them. Hiding only affects the menu, not what the model may delegate to.

`templates/opencode.json` defines global `model`, `small_model`, and `default_agent`. The bundled `small_model` is `opencode-go/deepseek-v4.1-flash` (the earlier `deepseek-v4-flash` is no longer listed by `opencode models opencode-go`). Agents are model-agnostic by default — model selection is centralized in `templates/opencode.json`, and the bundled agent files carry no `model`. The one exception is the optional subagent model override (see "App-level model override"): it pins the subagent roles through managed `agent.<role>.model` entries in the installed `opencode.json`, never in the agent files.

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
- Package-manager `run` scripts and Cargo allow rules use an argument boundary: `npm run build *` allows `npm run build` and `npm run build -- --flag`, while `npm run build-and-deploy` still asks. Deny rules keep their broader patterns
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

The bundled agents (`architect` and the subagents) keep self-contained permission blocks. `build` and `general` follow the global block (including `question: deny`). Both entries are managed sub-entries, so your own `agent.*` keys, including other keys of `agent.plan`, are preserved on install.

### External directories

A bare `external_directory: ask` would cancel OpenCode's built-in allowance for skill folders, so reading a skill's supporting files outside the worktree would prompt every time. The template keeps `"*": "ask"` and restates the allowance for the folders OpenCode loads skills from: `~/.claude/skills/*`, `~/.config/opencode/skills/*` and the `skills` folder under `~/.agents`. Because `*.md` edits are allowed, editing a file in those folders from another worktree still asks. OpenCode's tool-output folder is re-added by OpenCode itself. OpenCode's own temp folder (`<os temp dir>/opencode`) is not restated: its path differs per platform and cannot be written as a stable pattern, so reading there prompts.

## Language servers (LSP)

The template sets `lsp: true`, which enables OpenCode's built-in language servers. A server starts when OpenCode opens a file with a matching extension, and its diagnostics reach the agent after edits. The `lsp` permission (allow) lets the agent query it. Formatters stay off.

Download behaviour in OpenCode 1.19.3: some built-in servers install themselves on first use when their tool is not already available, from npm, GitHub releases or `go install`. Its docs list bash, astro, clangd, kotlin-ls, lua-ls, php intelephense, svelte, terraform, tinymist, vue and yaml-ls as auto-installing; the others (for example gopls, rust-analyzer, pyright, typescript) need their tool on `PATH` or in the project. OpenCode's own docs caution that language servers can use significant memory and slow agent loops, and that running lint or typecheck commands is often the better feedback in some projects.

Opt-outs:

- Stop automatic downloads: set `OPENCODE_DISABLE_LSP_DOWNLOAD=true` in the environment OpenCode starts in. Servers that are already installed still run.
- Turn LSP off for one project: add `"lsp": false` to that project's `opencode.json`. Project config overrides the global file (checked with `opencode debug config` on 1.19.3). To switch off a single server instead, use an object: `"lsp": {"typescript": {"disabled": true}}`.
- `lsp` is a managed key, so editing it in `~/.config/opencode/opencode.json` is reset on the next install. To change the default for everyone, edit `templates/opencode.base.json` in the app source repository.

## TUI config

`templates/tui.json` controls TUI-only preferences such as theme, diff layout, mouse, scroll behavior, and leader timeout. It installs to `~/.config/opencode/tui.json` with the OpenCode config target.

`tui.json` is merged like `opencode.json`, not replaced. Riggverk manages only the top-level keys listed under `tui_top_level` in `metadata/opencode-managed-keys.json`; your own keys (`keybinds`, `plugin`, `scroll_speed` and anything else) keep their values and their place in the file through install, update, rollback and uninstall. A missing file is created with the managed keys. A managed key the bundle no longer has is removed. The `tui` row of the runtime pane is `synced` while the managed keys hold the bundled values, whatever else the file holds.

The file is read and written as strict JSON. A `tui.json` with comments, a trailing comma, a byte order mark or invalid JSON is a conflict that is never rewritten; the reason the review gives never contains the file's text. A managed key you change after the app recorded what it wrote is also a conflict that leaves the file as it is; set the key back to let the next install manage it again. A file the app has no record of gets the managed keys on install, after a backup. Uninstall keeps the file.

Older versions owned `tui.json` as a whole file. A file that is still exactly what such a version installed is managed key by key from the next install on, and a file you edited keeps your extra keys.

## Managed-key merge

Install does **not** overwrite the entire installed `opencode.json`. It merges only the keys listed in `metadata/opencode-managed-keys.json` (model, `lsp`, permissions, the `permission` block of the built-in `plan` and `explore` agents, `agent.<role>.model` of the subagents while a subagent model override is set, Playwright MCP, compaction, watcher, and related settings). User `provider` blocks, non-Playwright MCP servers and other `agent` entries and keys are preserved. Managed keys are reset to the bundled values on every update, so keep your own settings in unmanaged keys.

A managed key or sub-entry absent from the bundled render is removed from the installed config. Empty MCP and agent containers are removed only when that removal empties them. Unrelated user fields and their order are preserved. Managed-projection rollback applies the same rule against the backup: it restores prior managed values and removes managed entries added by the update, while keeping later user edits.

Legacy `~/.config/opencode/agents/scout.md` files from the pre-rename scout agent are removed on agent sync when frontmatter is `name: scout`.

## Install workflow

1. Open the OpenCode tab. The `opencode_config`, `opencode_agents`, and `opencode_rules` targets decide what is installed (Space toggles).
2. Press `p` to preview or `u` to review, then `y` to apply.
3. The install merges the managed keys into `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`, and writes the Playwright MCP config and `~/.config/opencode/agents/*.md`. Extra agent files already in that directory are not deleted.

Both JSON files are validated before and after the write. Existing files that differ are backed up first.

## App-level model override

The OpenCode tab has a model override in its runtime pane. It holds three values:

- `model` and `small model`: the global `model` and `small_model` of `opencode.json`.
- `subagent model` (optional): the model the read-only subagent roles run on. Unset (shown as `inherit main model`), the subagents use the main model, as before.

Keys in the pane: `e` edit, `s` save, `x` reset to the bundled default, `R` reload the model list (read with the arguments of the installed OpenCode major).

### Source, state and reset

Each value has a line under it:

- `source: override | bundled default`. `override` means the app-level file below holds the value. `bundled default` means the bundled `opencode.base.json` value, or for the subagent model "inherit the main model". Workspace template edits do not change these defaults. Each of the three values has its own source: only a value you changed is an override.
- `state: applied | pending apply (u to update)`. The saved override (or the bundled default) is compared with the installed `opencode.json`: `pending apply` means an install (`u`, then `y`) would still change that value, for the subagent model when any of the role entries differs. The state is left out while runtime health is not loaded.
- Saving (`s`) stores only the values that differ from the current bundled default. A `model` or `small model` equal to it is left out of the file and keeps following the template, so a later change of the bundled default (a model that is no longer listed, say) reaches you with the next install. Setting a value back to the bundled default and saving drops it from the file again. When nothing is left, the file is deleted instead of being written empty. Saving only a new subagent model therefore leaves `model` and `small model` on the bundled default.
- `x` deletes the override file in one step and returns all three rows to the bundled default (unsaved edits are dropped too). The installed config keeps its values until the next install, which writes the bundled models and removes the subagent entries. `x` is offered only while an override exists.

The options of each field are grouped by provider (`<optgroup>`). A value that `opencode models` does not list (a provider that is not signed in, a removed model, a typed custom one) stays selectable but is marked `(not in opencode models)`; nothing is marked while the list is unavailable or incomplete. For a custom provider choose `custom provider/model…`, which turns the field into a text input (Esc returns to the list). The text input is also used while no model list is available.

### Where the override is stored

A saved selection is stored in an app-level override file:

| Platform | Override file |
|----------|---------------|
| macOS | `~/Library/Application Support/se.hugrverk.riggverk/opencode-model-selection.json` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/se.hugrverk.riggverk/opencode-model-selection.json` |
| Windows | `%APPDATA%\se.hugrverk.riggverk\opencode-model-selection.json` |

This file is **not** part of the workspace templates. It is an app-preference file stored outside the workspace source tree. It does not affect `templates/opencode.base.json` or `templates/opencode.json`. It holds `schema_version` and, only for the values you chose, `model`, `small_model` and `subagent_model`. A file written by an earlier app version has both `model` and `small_model` and no `subagent_model`: it reads as two explicit overrides (and "inherit" for the subagents) and keeps applying both until you change them back to the bundled default or press `x`. A value that is not `provider/model` is ignored on its own; the others still apply.

The override takes effect on the next OpenCode install (`u`, `y`). The installed `~/.config/opencode/opencode.json` receives the `model`, `small_model` and subagent entries the override file holds; every other value comes from the template. Workspace templates are not mutated.

A value the override does not hold is read from the bundled `templates/opencode.base.json` (or the built-in defaults) as the source of truth for model selection.

### Subagent model

With a subagent model set, the install writes `agent.<role>.model` for exactly `repo-scout`, `inspector`, `sentinel`, `verifier` and `scribe`; the bundled agent files stay as they are. `architect`, OpenCode's own agents and every other `agent.*` entry are not touched. Like the `plan` and `explore` permission entries, these are managed sub-entries: only the `model` field is owned, so a role's other keys (`description`, `temperature`, your own `permission` edits ...) and every other agent survive, and a model you set on the primary or on your own agents is left alone. When the override is cleared (or saved without a subagent model), the next install removes those `model` fields again, and an `agent.<role>` or `agent` object that held nothing else goes with them.

The runtime pane's `config` row names a role whose entry differs as `agent.<role>.model`. The model probes also check the subagent model against `opencode models` when one is installed (`subagent_model` check and warning). A model that is not listed leaves the roles pinned to it, so sign in to its provider or pick another model.

Checked on OpenCode 1.19.3: a managed `agent.<role>.model` in `opencode.json` is applied to the markdown agents in `~/.config/opencode/agents` (`opencode debug agent <role> --pure` resolves the model from the config entry while the agent's permission ruleset is unchanged), and an agent without an entry resolves no model of its own and uses the session's. The tools a subagent gets can follow its provider: on that version `debug agent sentinel` lists the `websearch` tool under the default `opencode-go` model and not when the role is pinned to an `anthropic` model.

### Removing the override

Press `x` in the pane, then install again (`u`, `y`). Deleting the file by hand does the same:

| Platform | Command |
|----------|---------|
| macOS | `rm "$HOME/Library/Application Support/se.hugrverk.riggverk/opencode-model-selection.json"` |
| Linux | `rm "${XDG_CONFIG_HOME:-$HOME/.config}/se.hugrverk.riggverk/opencode-model-selection.json"` |

The override is safe to delete; the app falls back to workspace template defaults.

## Customization

Installed OpenCode config and agent files are yours to change, but managed keys and bundled agent files are reset or reported as conflicts on update. For lasting changes use unmanaged keys (providers, other MCP servers) and your own agent files with different names in `~/.config/opencode/agents/`. To change the bundled policy or agents for everyone, edit the sources (`templates/opencode.base.json`, `templates/opencode.policy.json`, `agent-specs/`) in the app source repository. Avoid weakening the secret-file deny rules in the `read`, `edit`, and `bash` sections.
