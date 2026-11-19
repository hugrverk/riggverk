# OpenCode Config

## Supported OpenCode version

Riggverk manages the **OpenCode 1.x** config format (`opencode.json`, `tui.json`, `agents/*.md`) and is verified against OpenCode 1.19.3. Install 1.x with npm (`npm i -g opencode-ai`) or the Homebrew tap (`brew install anomalyco/tap/opencode`). Homebrew core's `opencode` formula installs **2.x**, so check `opencode --version` after installing.

OpenCode 2.x is compatible, tested with 2.3.2. It reads the 1.x config Riggverk writes and converts it in memory. Riggverk writes only the 1.x format, because 1.x cannot read the 2.x one. The OpenCode Runtime cell shows the detected version in its `cli` row, marked `compatible` on 2.x. OpenCode 3.x and later are unsupported, and the cell warns. On 2.x the model list is read with `opencode models --standalone` (2.x has no `--pure`, and without `--standalone` it would use a background service); on 1.x it is `opencode models --pure`.

The CLI is looked up on `PATH`, then in `/opt/homebrew/bin`, `/usr/local/bin` and `~/.opencode/bin` (the official installer's directory), because an app started from Finder has a short `PATH`.

### What differs on OpenCode 2.x

- **TUI settings.** 2.x does not read `tui.json`. It reads one global `cli.json` in the same folder, and when that file is missing its first start migrates `tui.json` into it once (the key shapes differ, and not every value carries over). Later changes to `tui.json` do not reach 2.x. Riggverk keeps writing `tui.json` for 1.x and does not manage `cli.json`. On 2.x the `tui` row says "not read by OpenCode 2", which is information, not drift.
- **Other config files and variables.** 2.x ignores `config.json` and `OPENCODE_PERMISSION`, and adds `OPENCODE_CONFIG_PROJECT_DISABLE` (see "Other config OpenCode reads").
- **Settings with no effect.** Agent `temperature` (the bundled agents set one) is kept but not sent to the model, so the roles run at the model's default. `lsp` starts no language servers, so the agent gets no diagnostics after edits. `compaction.prune` stays for 1.x, and 2.x warns that it does not support it. `small_model` only names the model of the built-in `title` agent.
- **Subagents.** On 2.3 and later a subagent runs in the background: the caller gets its session at once and the result when the subagent finishes.
- **Allow always.** Choosing "Allow always" saves a durable allow rule for the project, so it holds in later sessions. It never beats a configured deny.
- **External directories.** 2.x would allow `external_directory` by default (1.x asks). The template sets `"*": "ask"`, so 2.x asks too (see "External directories").
- **Code Mode (`execute`).** 2.x adds the `execute` permission. The template asks for it in the global block and in every role; only the built-in `explore` denies it. Code Mode programs have `fetch`, so one "Allow always" on `execute` lets Code Mode reach the network without a `webfetch` prompt. To get the 1.x shape, without Code Mode, set `execute` to `deny`. Set it at the top level of `templates/opencode.policy.json` in the app source repository and regenerate: the global block and every role take it from there. In the installed `opencode.json` it does not hold: `permission` is a managed key, reset on install, and the bundled agents set `execute: ask` in their own blocks, which OpenCode applies after the global one.
- **Plan folder.** The built-in `plan` agent writes its plans to `~/.opencode/plan/`, which the template allows (see "Built-in agents").
- **Native 2.x keys.** 2.x also reads its own keys beside the 1.x ones, and they win over the team's values (see "Other config OpenCode reads").
- **Paths in read and edit rules.** 2.x matches `read` and `edit` paths relative to the folder the session starts in, not to the worktree root. Started at the root, nothing changes. Started in a subfolder, rules anchored at the root stop matching. For the scribe that fails closed: its `docs/**` and `README.md` allows no longer match, and those edits fall to its default deny. For the architect it cuts both ways. An allowed path outside the extension rules, such as `scripts/run.sh` started in `scripts/`, now asks. The asks for `AGENTS.md`, `opencode.json(c)`, `.opencode/**` and `.github/workflows/**` have `**/` twins, so they still ask from a subfolder (and also for nested copies such as `src/AGENTS.md`). A session started inside `.opencode/` or a folder below it is the exception: it sees that folder's files without the `.opencode` part (`agent/x.md`, or `x.md` from `.opencode/agent/`), the same path a project file has from the root, so no rule can make them ask there without also asking for ordinary project files. `opencode.json(c)` still asks there, but files the architect may edit by extension (`*.md`, `*.ts`, `*.js` and the others) or by folder (`scripts/**` and the others) are edited without a prompt. Start OpenCode 2 at the worktree root to keep the rules as written. Every secret deny still holds, because each `**/P` rule also matches `../P`.
- **Shell rules.** 2.x checks shell commands with its own scanner, not tree-sitter, and like 1.x asks once per command it finds, with that command's text: the commands inside `$( )`, backticks and `<( )` are asked on their own, a command with a heredoc includes its body, and `export`, `declare`, `typeset`, `readonly`, `local` and `unset` are not asked. Ordinary `$( )`, heredocs and compound commands are analysed, so a heredoc commit message is asked like any other command, and "Compound commands" and "Limits of bash rules" below hold on 2.x with three differences. A redirect stays with the command it follows, and a redirect after a `{ …; }` or `( … )` group is asked on its own, so the redirect gap is closed in every form checked (chains, pipes, groups, loops, `if`, `case`, functions): `git status && ls > out.txt` asks. A `[ … ]` test, and a `cd` whose folder is not literal (`cd $HOME`), are commands and are asked. And the scanner refuses to run what it cannot analyse, before any rule is read: an unterminated quote, substitution or heredoc, a `$( )` and a heredoc that overlap, whitespace other than space, tab and newline (a carriage return), and builtins that change how later words are read (`alias x=y`, `set -k`). Checked against the 2.3.2 scanner source; the validator decides its 2.x shell rows on that scanner's recorded output.
- **Critic and delegate recipes.** The OpenCode route of the critic recipes (adversarial skills) and of the `delegate` recipe runs on 1.x and 2.x. On 2.x every command passes `--standalone`, so OpenCode starts a private server that reads the recipe's variables instead of using its shared background service. With no login, OpenCode 2.3.2 answered through OpenCode's free hosted model instead of failing, so pass `-m` with the model you chose. The 2.x delegate route was checked through its preflight, not a full run.

## Config folder

OpenCode reads its global config from `$XDG_CONFIG_HOME/opencode` when `XDG_CONFIG_HOME` is set, else from `~/.config/opencode`, on every OS. Riggverk installs, checks and removes its OpenCode files (`opencode.json`, `tui.json`, `AGENTS.md`, `agents/`) in that same folder, and looks for `config.json` and `opencode.jsonc` there. A relative `XDG_CONFIG_HOME` is ignored, as the XDG specification calls it invalid. A folder outside the home directory is the allowlisted root of these files. The labels say `$XDG_CONFIG_HOME/opencode` while the variable moves the folder; on this page `~/.config/opencode` stands for whichever folder is in effect. Riggverk sees the environment it was launched with, so set the variable where the app starts too (opened from Finder or the Dock it does not see your shell profile).

When `XDG_CONFIG_HOME` changes, the next install writes to the new folder. The files at the old folder stay as they are: the app neither updates nor removes them, uninstall included, so delete them yourself when you no longer need them.

`OPENCODE_CONFIG_DIR` points OpenCode at one more folder, read after the global one. The Runtime cell warns while it is set; the app never installs there.

## Runtime health probes

The OpenCode Runtime cell compares files, and it also asks the installed CLI three things that files cannot show. Each probe has a timeout and an output cap, runs from a new owner-only folder in the system temp folder, removed afterwards, with `OPENCODE_DISABLE_PROJECT_CONFIG=1` (OpenCode also looks for project config in every folder above the working directory), so no project config is picked up, and keeps only an exit status, a version number or, on 2.x, whether the default agent's id is listed. Raw CLI output is never stored or logged.

| Probe | Result |
|-------|--------|
| `opencode --version` (10 s) | The `cli` row, and the 1.x or 2.x code path below |
| `opencode debug agent <default_agent> --pure` (20 s, 1.x) | Exit 0 means the default agent parses and resolves. A non-zero exit warns, usually for a frontmatter error in an agent file that OpenCode otherwise skips silently |
| `opencode debug agents --standalone` (20 s, 2.x) | The default agent must be listed by its id. 2.x leaves out an agent file it cannot read and still exits 0, so a missing id warns, usually for a frontmatter error. Output that is not the agent list leaves the check `unknown` |
| `opencode models --pure` (30 s; `--standalone` on 2.x) | `model`, `small_model` and, when installed, the subagent and critic models must be listed. A missing one warns. OpenCode does not pick another small model when `small_model` is set but unknown. A model only appears while its provider is signed in |

A missing CLI, a timeout or a failing probe leaves those checks `unknown`. It never fails the health or changes its status. On another major the default agent is not probed. The rows of the cell: `cli` (version, `compatible` on 2.x, or "not found" with the install options), `default agent`, `autoupdate`, `rules` (global `AGENTS.md` against the bundled rules), `agents` (`synced` with the installed count, or the count and then the files that differ or are missing), `config` (synced or diverged, with the names of the managed keys that differ, and `has comments` when the file is JSONC), `overrides` (only when something below changes the config OpenCode runs), `mcp playwright` (the pinned version, with `synced` or `diverged`) and `tui` (synced or diverged, with the names of the managed keys that differ; "not read by OpenCode 2" on 2.x). Apart from the default agent and `autoupdate`, the rows show names and statuses, never a value from a file.

## Other config OpenCode reads

OpenCode 1.x does not read `opencode.json` alone. In the global folder it merges `config.json`, then `opencode.json`, then `opencode.jsonc` (a later file wins), and all three may have comments and trailing commas. Environment variables, project files and a system managed config come on top (checked against OpenCode 1.19.3). OpenCode 2.x reads only `opencode.json` and `opencode.jsonc` in the global folder (checked against 2.3.2), so on 2.x the cell leaves `config.json` out. The Runtime cell reports what of that it can see, so `synced` means OpenCode runs the team's values. It shows names only, never values: these files and variables can hold provider keys.

- **A commented `opencode.json`.** Health reads it as JSONC, so the `config` row still says synced or diverged. Install writes strict JSON only, so it leaves such a file as is, and the review and a warning say why. To let the app update it again, move your own settings and their comments to `opencode.jsonc` and keep `opencode.json` strict JSON. A trailing comma or a byte order mark alone only needs removing.
- **`opencode.jsonc` and `config.json` (1.x only) beside it.** When one sets a managed key (a top-level managed key, `mcp.playwright`, `agent.plan.permission`, `agent.explore.permission` or `agent.<role>.model`; `$schema` does not count), the runtime turns diverged, the `overrides` row names the file and the keys, and a warning says what to remove. `opencode.jsonc` wins over the team's values; `config.json` is merged under them, so its permission rules, MCP servers and agent blocks combine with the team's. An install does not fix this: the app never writes these files.
- **Native OpenCode 2 keys.** 2.x also reads its own keys (`permissions`, `agents`, `mcp.servers`, `update`, `snapshots`, `plugins`, `providers`) in `opencode.json` and `opencode.jsonc`, and applies them after the 1.x keys Riggverk manages, so they win over the team's values. OpenCode 1.x refuses to load a file with `permissions`, so a config converted to the 2.x format breaks 1.x. Whichever version runs, when one of these keys is set the cell warns, names the file and the keys, and reports diverged. Move these settings to their 1.x keys or remove them; an install does not touch them.
- **Environment variables.** The cell names `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_PERMISSION` (read by 1.x only), `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_CONFIG_PROJECT_DISABLE` (2.x's name for it) and `OPENCODE_DISABLE_CLAUDE_CODE*` when they are set, and `OPENCODE_CONFIG_DIR` gets a warning of its own that names the folder the app installs to. The app sees the environment it was launched with, not your shell's: opened from Finder or the Dock it does not see what your shell profile exports, so check your shell yourself.
- **System managed config.** The cell says when `/Library/Application Support/opencode` or the managed preferences `ai.opencode.managed.plist` (macOS), `/etc/opencode` (Linux) or `%ProgramData%\opencode` (Windows) exists. It overrides your config files, the team's values included. Only the path's existence is checked; nothing there is opened.

Variables, project files and the system managed config do not change the runtime status: the app cannot see what they set.

## Source template

The runtime OpenCode configuration is `templates/opencode.json`. This is a **generated snapshot** — do not edit it directly. The app installs from its bundled copy of these templates, and the Library shows them read-only; the app keeps no copy of them in your workspace folder. Runtime health and dashboard config status compare against that same bundled render, including saved model overrides. TUI, rules and agents also use the bundled sources.

The maintainable source files are:

- **`templates/opencode.base.json`** — non-permission config (provider, watcher, compaction, etc.)
- **`templates/opencode.policy.json`** — permission policy in a compact grouped format

To regenerate the snapshot after changing a source file:

```
python3 scripts/generate-opencode-config.py --write
```

In the app source repository, to verify the snapshot is current (the release check does the same for the shipped snapshot; the OpenCode Runtime cell checks the bundled sources and snapshot with the bundled copy of the generator):

```
python3 scripts/generate-opencode-config.py --check
```

Python 3 must be on `PATH`.

The template defines:

- Share settings (recommended: disabled)
- Default primary agent via `default_agent`
- Playwright MCP through on-demand `npx` with a pinned package version, user-local MCP config, and shared browser cache (not `@latest`)
- `lsp: true` (built-in language servers on OpenCode 1.x, see "Language servers (LSP)"); `formatter` is omitted, so formatters stay off
- Permission model (which operations are allowed, denied, or require asking)
- File-scope read/edit deny rules for secrets and credentials
- Watcher ignore patterns

Playwright MCP is defined in `templates/opencode.base.json` and included in the generated `templates/opencode.json`.

Defaults:

- Package: `@playwright/mcp@0.0.83` (`PLAYWRIGHT_MCP_VERSION` overrides it)
- npm project: the entry starts `/bin/sh -c 'cd -- "$1" && shift && exec npx --prefix "$0" -y "$@"' <npx-prefix> <playwright-output> @playwright/mcp@0.0.83 ...`, which runs `npx --prefix <npx-prefix> -y ...` from `playwright-output`. Both are owner-only folders in the app data folder, and `npx-prefix` stays empty. So npx never uses the `.npmrc`, a `node_modules/@playwright/mcp` or the `node_modules/.bin` (`sh`, `node`) of the repository the agent works in, any of which could run code as the server starts. When the client sends no MCP roots, the server's `.playwright-mcp` outputs and the files it saves under a name land in `playwright-output`, not in the project
- MCP config: `~/.config/playwright-mcp/config.json` (or `PLAYWRIGHT_MCP_CONFIG_PATH`) from `templates/playwright-mcp.config.json`
- Browser: the entry passes `--browser chrome --isolated --no-webmcp` after `--config`, so the server opens the system Google Chrome in a profile kept in memory, and the tools a page registers through WebMCP stay off. The MCP config holds `browserName: chromium` and `isolated: true`; on the command line the flags win over it. On `@playwright/mcp@0.0.83` a browser named in the config file alone gets no channel and would resolve to Playwright's own Chromium, which needs a download; the flag avoids that. Read from the source of that release, not from a launch
- Binaries: shared cache (`~/Library/Caches/ms-playwright` on macOS, `$XDG_CACHE_HOME/ms-playwright` on Linux, `~/AppData/Local/ms-playwright` on Windows; `PLAYWRIGHT_BROWSERS_PATH` overrides). The entry uses the installed Google Chrome, so nothing is downloaded into it unless you install a Playwright browser yourself

Do **not** set `PLAYWRIGHT_BROWSERS_PATH=0`. That forces project-local browsers under `node_modules` and defeats the shared-cache default.

The app installs the Playwright MCP config with the OpenCode config target and renders user-specific paths into the OpenCode MCP entry. The Cursor page merges only the `playwright` server into `~/.cursor/mcp.json` (existing servers are preserved; existing files are backed up first). Both entries pass `--config` with that file, and the server fails to start when the file is missing, so with the OpenCode config target off the Cursor entry has no config to read. The GitHub Copilot, Pi and Kilo entries do not depend on it: they pass `--browser chrome --isolated --no-webmcp` without it (see `docs/WORKSPACE_CONTRACT.md` in the app repository).

Security note: Playwright MCP provides privileged browser automation tools. Its documented default tool list includes an unsafe code execution tool, and no stable server-side option to disable only that tool is currently documented. Do not use it on private or authenticated sites unless the runtime agent permissions and prompt scope are appropriate. Isolated sessions do not persist logged-in browser state between runs. Tools that a page registers through WebMCP are off (`--no-webmcp`): their names, descriptions and results come from the page, not from Playwright.

Local MCP checks. Run the first from an empty folder, as shown: npx reads the `.npmrc` and `node_modules` of the folder it starts in.

```
(cd "$(mktemp -d)" && npx -y @playwright/mcp@0.0.83 --help)
opencode mcp list
```

If the browser tools report that Google Chrome is missing, install Google Chrome. The entry selects the system Chrome (`--browser chrome`); it does not use a Playwright browser download.

## OpenCode agents

OpenCode agent definitions live at `agents/*.md` in the workspace. The bundled agents are:

- `agents/architect.md` — Default coding architect/orchestrator
- `agents/repo-scout.md` — Repository structure explorer
- `agents/inspector.md` — Code inspection/review agent
- `agents/sentinel.md` — Security sentinel/audit review
- `agents/scribe.md` — Documentation writer
- `agents/verifier.md` — Non-destructive verification runner

`architect` is the primary agent. `inspector` and `verifier` are subagents you can run directly: type `@inspector` or `@verifier` in the prompt. `repo-scout`, `sentinel` and `scribe` are `hidden: true`, which removes them from `@` autocomplete; the architect still delegates to them. Hiding only affects the menu, not what the model may delegate to.

`templates/opencode.json` defines `default_agent` and no model. Riggverk sets no model; your agent's own default applies. Existing `model` and `small_model` values stay yours, including values written by earlier releases. Optional saved model overrides can explicitly set them or pin subagent and critic roles; bundled agent files carry no model.

## Permission model

OpenCode agent permissions are composed at generation time from `templates/opencode.policy.json` (base policy and shared secret matrix) plus `templates/opencode/agents/*.role.json` (small role overrides). Restrictive roles declare `composition.replace_sections` so bash or edit profiles replace inherited sections instead of shallow-merging them. Shared secret denials stay in the base policy; role files do not duplicate the full matrix.

Role boundaries:

- **architect** — implementation edits, bounded bash, approved subagent delegation
- **repo-scout**, **inspector**, **sentinel**, and built-in **explore** — read-only by policy, with no edit, task delegation, or shell. Include the diff or changed-file list in the prompt when needed
- **verifier** — exact non-destructive test/lint/build/cargo commands only; no source edit, git staging/commits, fix modes, snapshot updates, or arbitrary trailing arguments. Project-owned verification scripts are a deliberate trust boundary: they may create disposable build/test artifacts, but the Verifier profile must not receive arbitrary arguments beyond the reviewed exact command forms.
- **scribe** — documentation paths only (`README.md`, `docs/**`, and related doc files); no source-code edit or shell; include the diff or changed-file list in the prompt when needed

In the app source repository, `scripts/validate_opencode_permissions.py` asserts the composed contract and `scripts/generate-agent-adapters.py --check` verifies deterministic generated adapters; neither ships with the app. The validator evaluates rules the way OpenCode 1.19.3 does (worktree-relative read/edit paths, one bash pattern per command of a compound, built-in agent rulesets); the shell splitting follows OpenCode's source at tag `v1.19.3` (`tool/shell.ts`) and was checked against the installed OpenCode with `opencode debug agent <name> --pure --tool bash`. It also checks that every bash deny naming a command denies that command alone and inside pipes, `&&`, `||`, `;` and `&` chains, newlines, subshells, `$( )` and backticks, for each bundled agent and for OpenCode's `build`, `plan` and `explore`. By default the validator also decides a set of rows the OpenCode 2.x way: renamed actions, read and edit paths relative to the session folder (a subfolder included), and shell calls over what the 2.3.2 scanner reports for them, refusals included, recorded from its source. `--opencode2 BINARY` (or `RIGGVERK_OPENCODE2_BIN`) adds an opt-in cross-check of those rows against the rules a real 2.x binary resolves; the binary cannot run its scanner without a model, so the shell rows use the recorded scans there too.

The default template is conservative:

- Sharing is disabled
- Most operations default to "ask"
- Read access is broadly allowed except for secret-bearing files (`.env` files, SSH private keys, kubeconfig, Terraform state/vars, Ansible vaults, shell history, local credential files)
- The native `read` tool honors read-deny rules. `grep` does not: it only asks the `grep` permission (allowed) and then returns matching lines from every file ripgrep reads, so it can show the contents of any file that is not gitignored, even one that `read` denies. Keep secrets gitignored or outside the project. `glob` and `list` return names only
- Bash content commands (`cat`, `head`, `tail`, `sed`, `grep`, `rg`, `git grep`) are ask-gated because bash permissions are separate from read permissions
- Secret-file protections exist in read, edit, and bash permissions for: `.env` files, SSH private keys (`id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`), `kubeconfig` and `.kube/**`, Terraform state/vars (`terraform.tfstate*`, `terraform.tfvars`, `*.tfvars`), Ansible vault files (`vault.yml`, `secrets.yml`), shell history (`.bash_history`, `.zsh_history`), and local credential files (`master.key`, `.pgpass`, `.my.cnf`, `.envrc`, `*.ppk`, `*.jks`, `Pulumi.*.yaml`). Credential-bearing config (`mcp.json`, `.claude.json`, `.codex/config.toml`, `.git-credentials`, `.git/config`) is denied to read and bash, not to edit
- The bash secret denies are generated from the `read` deny list, so the two cannot drift. For each content command in `opencode.policy.json` (`cat`, `head`, `tail`, `sed`, `less`, `more`, `bat`, `grep`, `rg`, `git grep`) a secret is denied as a bare name (`cat .env`), behind any path prefix (`cat ./id_rsa`, `cat ~/.ssh/id_rsa`, `cat $HOME/.netrc`, `cat /srv/site/wp-config.php`, `less config/.env.local`), after options or other files (`head -n 5 .env`), followed by more words or a redirect (`cat ~/.ssh/id_rsa > key`), and inside any compound command. OpenCode does not expand `~` or `$HOME` in the command text, so each spelling is a rule of its own. The first operand of `grep`, `rg` and `git grep` is the search pattern, so they are denied a secret as a path (`rg -n KEY ./.env`, `grep url ~/.git/config`). A bare name as their last word is denied only for the secret files that are also edit-denied (`rg -n id_rsa`), not for the credential-bearing config that code names, so `rg -n mcp.json`, `git grep mcp.json`, `grep -r "id_rsa" docs/` and `grep -r id_rsa docs/` keep asking. `*.env*` stays a read deny only, because in a command it would match every `process.env`. `ls ~/.ssh` and `find . -name .env` print names only and keep their result, like the `glob` and `list` tools
- OpenCode 1.x matches read and edit rules against the path relative to the worktree (2.x: relative to the folder the session starts in, see "What differs on OpenCode 2.x"), and `**/P` needs a `/` before `P`. Every `**/P` secret rule therefore has a root twin `P`, so `wp-config.php`, `.npmrc`, `server.key`, `.git/config` and `secrets/**` are protected at the worktree root and nested; files outside the worktree match `**/P` through their `../` prefix
- Edits are allowed under common source directories (`src/**`, `app/**`, `lib/**`, `tests/**`, `docs/**`, `scripts/**`, ...) and for `*.md`, `*.ts`, `*.tsx`, `*.js`, `*.jsx`, `*.css` and `*.scss` files anywhere in the worktree. Everything else asks, as do package manifests and lock files, `AGENTS.md`, `opencode.json`, `.opencode/**`, workflows and skill folders outside the worktree. Secret files are denied
- Destructive commands are denied globally and in each agent in the spellings the rules name: `sudo …`, `rm -rf …`, `rm -fr …`, `git reset --hard …`, `git clean -fd…`, `git push --force…` and `git push -f…`. Other spellings, such as `rm -r -f`, `/bin/rm -rf` or `git clean -xfd`, are not matched and ask in `architect`, `build` and `plan` (the restrictive profiles deny them by default). Piping into a bare `bash`, `sh` or `zsh` is denied as well (see "Compound commands"); other interpreters such as `python3` or `node` still ask
- Cargo verification commands (`cargo fmt`, `cargo check`, `cargo clippy`, `cargo test`) are allow-listed where verification is expected
- Package-manager `test` and `run <script>` (`test`, `lint`, `typecheck`, `build`, `verify`) and the Cargo verification commands are allowed as fixed forms. Free arguments are allowed only after a literal `--` (`npm run build -- --flag`, `cargo test -- --nocapture`), which the runner passes on to the script; `bun` and `cargo fmt`, `check` and `clippy` take none. An option before the script or before `--` (`--script-shell`, `--userconfig`, `--preload`, `--config`, `-Z`) can swap the program that runs or load config, and shell quoting hides it from a literal pattern, so those ask, as does `npm run build-and-deploy`. Deny rules keep their broader patterns
- `find` always asks: `-exec`, `-ok`, `-delete` and `-fprint` run code or write files, and `-ex''ec` hides them from a literal pattern. Use OpenCode's `glob` and `grep` tools for file search. `ls` is allowed with arguments only as the command `ls` (not `lsof`)
- `git add` and `git commit` ask, like `git checkout` and `git pull`, because they change repository state, and because `git commit --file=.env` or `git add -f .env` would bring a secret into the history where an allowed `git log -1` or `git diff --cached` prints it
- `npm run dev` and other dev server commands are ask-gated in the bundled default starter template

### Compound commands

This section describes OpenCode 1.x. It holds on 2.x too, except for redirects, `[ ]` tests and the commands 2.x refuses (see "What differs on OpenCode 2.x").

OpenCode 1.19.3 parses a bash call with tree-sitter and asks the `bash` permission once per command node, with that node's own text: `a | b`, `a && b`, `a || b`, `a ; b`, `a & b`, a newline, a subshell and the contents of `$( )`, backticks and `<( )` are separate commands, and the strictest answer wins (deny, then ask, then allow). `cd`, `export`, `declare`, `readonly`, `local`, `unset` and `[ ]` tests are not matched. Consequences for the rules:

- A deny holds wherever the denied command sits: `git status && rm -rf /`, `echo $(cat .env)` and `cat .env | base64` are denied in every agent, because `rm -rf /` and `cat .env` are commands of their own
- Commands that are each allowed run together without a prompt: `git status && git diff` is allowed in profiles that allow both commands
- `curl … | bash` is the two commands `curl …` (ask) and `bash`. A rule like `*|bash` can never match it, so the bare shells are denied instead: `bash`, `sh`, `zsh`, their `-` forms and `-s*` forms. `bash script.sh` and `bash -c …` are different commands and keep asking, and so do `bash <(curl …)`, `sh -c "$(curl …)"`, `/bin/bash`, `env bash` and other shells such as `dash` (the restrictive profiles deny them by default)
- Rules that look for shell syntax inside a command (`*|*`, `*&&*`, `*||*`, `*;*`, `*&*`, `*$(*`, a backtick, a newline) never see an unquoted operator, because the split has already removed it. They still match a quoted operator, a heredoc body and the substitution text that the outer command keeps (`grep 'a|b' notes.txt`, `echo $(…)`), so the verifier profile keeps them as defense in depth. What stops `git status && touch x` there is that `touch x` is evaluated on its own and the profile denies by default
- A redirect stays in the command it follows (`git status > f` matches `*>*`), but a redirect after a later `|`, `&&` or `||` element is not part of any command (`git status && git status > f` is evaluated as `git status` twice)

### Limits of bash rules

These limits describe OpenCode 1.x and hold on 2.x, except where a line names 2.x.

- The redirect gap above is OpenCode 1.x behaviour, not something a rule can see: an allow-listed command can write a file when a redirect hides behind a second command, in profiles that allow the command. The no-shell roles deny those commands. 2.x keeps the redirect with its command, so there it asks
- `export`, `declare`, `typeset`, `readonly`, `local` and `unset` are never checked. OpenCode 1.19.5 builds its bash patterns from `descendantsOfType("command")` only (the `collect` function of the bash tool), and the tree-sitter-bash grammar gives these builtins their own node types (`declaration_command`, `unset_command`), so no rule, `export *` or otherwise, can match them; the 2.x scanner skips them as well. An environment change therefore reaches the next allowed command unasked: `export GIT_CONFIG_PARAMETERS="'core.fsmonitor=/tmp/x'"; git status` runs `/tmp/x`, `export GIT_EXTERNAL_DIFF=sh; git diff` runs the changed file as a script, `export PATH=…; ls` runs another `ls`. What is a command is checked and asks by default: the prefix form (`GIT_EDITOR=x git commit`), `env`, `alias`, `source`, `.`, `eval` and `set -a` (2.x refuses `alias x=y` outright)
- Bash permissions in OpenCode are therefore a convenience filter that keeps an honest agent from running the wrong thing by mistake. They are not a containment boundary against injected instructions in text the agent reads (a PR comment, an issue, a log, a cloned repository). For untrusted content, run OpenCode inside an OS sandbox (a container or VM, or the Seatbelt or bubblewrap sandbox of a route that has one) and keep secrets out of its reach
- `bash -c "…"`, `eval` and scripts run commands that no rule sees; they ask by default
- A rule matches the command's text, not the file it touches. The bash secret denies cover the spellings listed above; these still ask in `architect`, `build` and `plan`: a quoted path that ends right at a fixed name (`cat ".env"`, `cat "$HOME/.netrc"`; a quoted path into `.ssh/`, `.aws/` or another secret folder is denied), globs and variables (`cat .en*`, `cat $f`), and readers outside the listed commands (`awk`, `base64`, `cp`, `python3`). The allow-listed `git show` and `git diff` print tracked files, so a committed secret is readable through them. `git diff`, `git log` and `git show` are allowed only in a short list of fixed forms (`git diff`, `git diff --stat`, `git diff --cached`, `git diff HEAD~1`, `git log --oneline -20`, `git show --stat HEAD`, and similar, where `?` stands for one character); every other spelling asks. A broader allow cannot be made safe: OpenCode matches the command's source text, not the words the shell passes to git, so `git diff --out''put=/dev/null` would match `git diff*` while git sees `--output=/dev/null`, and OpenCode's wildcard matcher reads a backslash as `/`, so an ask pattern cannot separate `--out\put` from a path. The same fixed-form rule keeps `--output`, `--ext-diff`, `--textconv`, `git difftool` and `--no-index` from running unasked, and it covers the implicit no-index mode git enters when an operand lies outside the worktree (`git diff /dev/null .env` prints an untracked `.env` that `cat .env` cannot). `git fetch` is allowed only bare or with `origin` or `upstream`; any other form (a URL, a path, `--upload-pack`, `--all`) asks. `tree` is allowed bare or with `-a`, `-d` and `-L <digit>`, because `-o` writes a file. For a path outside the worktree OpenCode 1.x also asks `external_directory`; 2.x asks it only for the working folder and a `cd` target, not for a file a command names
- `grep` ignores read-deny rules (see above)
- On OpenCode 2.x, "Allow always" saves a durable allow rule for the project, so a command approved that way stays approved in later sessions. It never beats a configured deny
- The permission rules are not an OS sandbox

### Built-in agents (`plan`, `explore`)

OpenCode builds its built-in agents as defaults, then the agent's own restriction, then the global `permission`, so the global block of this template would re-open `plan` ("Disallows all edit tools") and `explore` (read-only) for edits and delegation. The template therefore carries `agent.plan.permission` and `agent.explore.permission`, which OpenCode appends after the global block:

- **plan** — `edit` is denied except plan files: `.opencode/plans/*.md` and `*opencode/plans/*.md` on 1.x, which covers the plan folder in OpenCode's data dir, and `~/.opencode/plan/*` on 2.x, which `external_directory` also allows; `question` and `plan_exit` (1.x; 2.x has no such tool) are allowed; `task` is limited to `explore`, `repo-scout`, `inspector`, `sentinel` and `verifier`, so plan cannot delegate to `general` or `scribe` and edit that way. Bash follows the global profile
- **explore** — the `repo-scout` read-only profile with a deny default: no edit tools, no `task`, no `todowrite`, no MCP tools, no Code Mode (`execute`, 2.x), the read-only bash profile and the same secret read denies

The bundled agents (`architect` and the subagents) keep self-contained permission blocks. `build` and `general` follow the global block (including `question: deny`). Both entries are managed sub-entries, so your own `agent.*` keys, including other keys of `agent.plan`, are preserved on install.

### External directories

OpenCode 2.x would allow `external_directory` by default, where 1.x asks; the template's `"*": "ask"` keeps both asking. A bare `external_directory: ask` would cancel OpenCode's built-in allowance for skill folders, so reading a skill's supporting files outside the worktree would prompt every time. The template keeps `"*": "ask"` and restates the allowance for the folders OpenCode loads skills from: `~/.claude/skills/*`, `~/.config/opencode/skills/*` and the `skills` folder under `~/.agents`. Because `*.md` edits are allowed, editing a file in those folders from another worktree still asks. OpenCode's tool-output folder is re-added by OpenCode itself. OpenCode's own temp folder (`<os temp dir>/opencode`) is not restated: its path differs per platform and cannot be written as a stable pattern, so reading there prompts.

## Language servers (LSP)

The template sets `lsp: true`, which enables the built-in language servers of OpenCode 1.x. OpenCode 2.x keeps the key but runs no language servers, so on 2.x the agent gets no diagnostics after edits, and the rest of this section does not apply. On 1.x a server starts when OpenCode opens a file with a matching extension, and its diagnostics reach the agent after edits. The `lsp` permission (allow) lets the agent query it. Formatters stay off.

Download behaviour in OpenCode 1.19.3: some built-in servers install themselves on first use when their tool is not already available, from npm, GitHub releases or `go install`. Its docs list bash, astro, clangd, kotlin-ls, lua-ls, php intelephense, svelte, terraform, tinymist, vue and yaml-ls as auto-installing; the others (for example gopls, rust-analyzer, pyright, typescript) need their tool on `PATH` or in the project. OpenCode's own docs caution that language servers can use significant memory and slow agent loops, and that running lint or typecheck commands is often the better feedback in some projects.

Opt-outs:

- Stop automatic downloads: set `OPENCODE_DISABLE_LSP_DOWNLOAD=true` in the environment OpenCode starts in. Servers that are already installed still run.
- Turn LSP off for one project: add `"lsp": false` to that project's `opencode.json`. Project config overrides the global file (checked with `opencode debug config` on 1.19.3). To switch off a single server instead, use an object: `"lsp": {"typescript": {"disabled": true}}`.
- `lsp` is a managed key, so editing it in `~/.config/opencode/opencode.json` is reset on the next install. To change the default for everyone, edit `templates/opencode.base.json` in the app source repository.

## TUI config

`templates/tui.json` controls TUI-only preferences such as theme, diff layout, mouse, scroll behavior, and leader timeout. It installs to `~/.config/opencode/tui.json` with the OpenCode config target. OpenCode 1.x reads it; 2.x reads `cli.json` instead, which the app does not manage (see "What differs on OpenCode 2.x").

`tui.json` is merged like `opencode.json`, not replaced. Riggverk manages only the top-level keys listed under `tui_top_level` in `metadata/opencode-managed-keys.json`; your own keys (`keybinds`, `plugin`, `scroll_speed` and anything else) keep their values and their place in the file through install, update, rollback and uninstall. A missing file is created with the managed keys. A managed key the bundle no longer has is removed. The `tui` row of the Runtime cell is `synced` while the managed keys hold the bundled values, whatever else the file holds. On 2.x it says "not read by OpenCode 2" instead and never counts as drift.

The file is read and written as strict JSON. A `tui.json` with comments, a trailing comma, a byte order mark or invalid JSON is a conflict that is never rewritten; the reason the review gives never contains the file's text. A managed key you change after the app recorded what it wrote is also a conflict that leaves the file as it is; set the key back to let the next install manage it again. A file the app has no record of gets the managed keys on install, after a backup. Uninstall keeps the file.

Older versions owned `tui.json` as a whole file. A file that is still exactly what such a version installed is managed key by key from the next install on, and a file you edited keeps your extra keys.

## Managed-key merge

Install does **not** overwrite the entire installed `opencode.json`. It merges only the keys listed in `metadata/opencode-managed-keys.json` (`lsp`, permissions, the `permission` block of the built-in `plan` and `explore` agents, `agent.<role>.model` of the subagents while a subagent or critic model override is set or the app recorded writing it, Playwright MCP, compaction, watcher, and related settings). User `provider` blocks, non-Playwright MCP servers and other `agent` entries and keys are preserved. Managed keys are reset to the bundled values on every update. `model` and `small_model` are unmanaged unless a saved override explicitly sets them; when absent from the rendered template they are preserved and do not cause drift.

A managed key or sub-entry absent from the bundled render is removed from the installed config. Empty MCP and agent containers are removed only when that removal empties them. Unrelated user fields and their order are preserved. Managed-projection rollback applies the same rule against the backup: it restores prior managed values and removes managed entries added by the update, while keeping later user edits.

Legacy `~/.config/opencode/agents/scout.md` files from the pre-rename scout agent are removed on agent sync when frontmatter is `name: scout`.

## Install workflow

1. Open the OpenCode page. The `opencode_config`, `opencode_agents`, and `opencode_rules` targets decide what is installed (each has a switch).
2. Press `p` to preview or `u` to review, then `y` to apply.
3. The install merges the managed keys into `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`, and writes the Playwright MCP config and `~/.config/opencode/agents/*.md`. Extra agent files already in that directory are not deleted.

Both JSON files are validated before and after the write. Existing files that differ are backed up first.

## App-level model override

The OpenCode page has a model override in its Model cell. It holds four values:

- `model` and `small model`: the global `model` and `small_model` of `opencode.json`. On OpenCode 2.x `small_model` only names the model of the built-in `title` agent.
- `subagent model` (optional): the model the read-only subagent roles run on. Unset (shown as `inherit main model`), the subagents use the main model, as before.

`critic model` (optional, stored as `critic_model`) is used by the critic of the adversarial skills (`inspector`). It pins only `agent.inspector.model`, taking precedence over the subagent model; the other roles keep their subagent model. There is no bundled critic default: unset, inspector follows the subagent model or inherits the main model. Clearing it restores that fallback on the next install. It uses the same `provider/model` validation, model list, source/state display and reset as the other rows.

Keys in the cell: `e` edit, `s` save, `x` clear the overrides, `R` reload the model list (read with the arguments of the installed OpenCode major).

### Source, state and reset

Each value has a line under it:

- `source: override | bundled default`. `override` means the app-level file holds a choice. `bundled default` means no override: the main model fields are empty, and the subagent and critic inherit.
- `state: applied | pending apply (u to update)`. An explicit override is compared with the installed config. A model with no override is unmanaged and does not cause drift. The subagent row checks its role entries, excluding inspector while a critic override is set; the critic row checks inspector.
- Saving (`s`) stores nonempty choices. Empty main model fields leave existing installed values alone. When nothing is selected, the override file is deleted.
- `x` deletes the override file and clears unsaved edits. The next install removes the app-owned role pins; existing global model values stay in the installed config.

The options of each field are grouped by provider (`<optgroup>`). A value that `opencode models` does not list (a provider that is not signed in, a removed model, a typed custom one) stays selectable but is marked `(not in opencode models)`; nothing is marked while the list is unavailable or incomplete. For a custom provider choose `custom provider/model…`, which turns the field into a text input (Esc returns to the list). The text input is also used while no model list is available.

### Where the override is stored

A saved selection is stored in an app-level override file:

| Platform | Override file |
|----------|---------------|
| macOS | `~/Library/Application Support/se.hugrverk.riggverk/opencode-model-selection.json` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/se.hugrverk.riggverk/opencode-model-selection.json` |
| Windows | `%APPDATA%\se.hugrverk.riggverk\opencode-model-selection.json` |

This file is **not** part of the workspace templates. It is an app-preference file stored outside the workspace source tree. It does not affect `templates/opencode.base.json` or `templates/opencode.json`. It holds `schema_version` and, only for the values you chose, `model`, `small_model`, `subagent_model` and `critic_model`. A file written by an earlier app version has both `model` and `small_model` and no `subagent_model`: it reads as two explicit overrides (and "inherit" for the subagents) and keeps applying both until you clear them or press `x`. A missing `critic_model` preserves the earlier inspector behavior. A value that is not `provider/model` is ignored on its own; the others still apply.

The override takes effect on the next OpenCode install (`u`, `y`). The installed `~/.config/opencode/opencode.json` receives the `model`, `small_model` and subagent entries the override file holds; every other value comes from the template. Workspace templates are not mutated.

A main or small model the override does not hold is unmanaged; OpenCode uses the installed config value if present, otherwise its own default.

### Subagent model

With a subagent model set, the install writes `agent.<role>.model` for exactly `repo-scout`, `inspector`, `sentinel`, `verifier` and `scribe` (inspector uses the critic override when set); the bundled agent files stay as they are. `architect`, OpenCode's own agents and every other `agent.*` entry are not touched. Like the `plan` and `explore` permission entries, these are managed sub-entries: only the `model` field is owned, so a role's other keys (`description`, `temperature`, your own `permission` edits ...) and every other agent survive, and a model you set on the primary or on your own agents is left alone. When the subagent override is cleared, the next install removes those `model` fields again, except inspector while a critic override remains; an `agent.<role>` or `agent` object that held nothing else goes with them.

The app changes or removes a role's `model` only when it can prove it wrote that value: it is the one the override pins now, or the one the ownership record (`managed-state.json`) says the last install wrote. Any other `agent.<role>.model` is yours. A model you set on a role without an override stays through every install and never shows as diverged or as a conflict, and neither does a pinned model you change after clearing the override. An override you save still pins every role it covers, over your own models too (the install backs the file up first). A record written by an app version before this one holds no models, so a pin that version wrote is not proven: after a reset it stays until you remove it yourself.

The Runtime cell's `config` row names a role whose entry differs as `agent.<role>.model`. The model probes also check the installed subagent and inspector models against `opencode models` (`subagent_model` and `critic_model` checks and warnings). A model that is not listed leaves the roles pinned to it, so sign in to its provider or pick another model.

Checked on OpenCode 1.19.3: a managed `agent.<role>.model` in `opencode.json` is applied to the markdown agents in `~/.config/opencode/agents` (`opencode debug agent <role> --pure` resolves the model from the config entry while the agent's permission ruleset is unchanged), and an agent without an entry resolves no model of its own and uses the session's. The tools a subagent gets can follow its provider: on that version `debug agent sentinel` lists the `websearch` tool under the default `opencode-go` model and not when the role is pinned to an `anthropic` model.

### Removing the override

Press `x` in the Model cell, then install again (`u`, `y`). Deleting the file by hand does the same:

| Platform | Command |
|----------|---------|
| macOS | `rm "$HOME/Library/Application Support/se.hugrverk.riggverk/opencode-model-selection.json"` |
| Linux | `rm "${XDG_CONFIG_HOME:-$HOME/.config}/se.hugrverk.riggverk/opencode-model-selection.json"` |

The override is safe to delete; existing global model values remain yours, and role overrides return to inheritance.

## Customization

Installed OpenCode config and agent files are yours to change, but managed keys and bundled agent files are reset or reported as conflicts on update. For lasting changes use unmanaged keys (providers, other MCP servers) and your own agent files with different names in `~/.config/opencode/agents/`. To change the bundled policy or agents for everyone, edit the sources (`templates/opencode.base.json`, `templates/opencode.policy.json`, `agent-specs/`) in the app source repository. Avoid weakening the secret-file deny rules in the `read`, `edit`, and `bash` sections.
