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
- **repo-scout**, **inspector**, **sentinel** — strictly read-only (no edit, no task delegation, exact inspection bash only; no shell composition, redirects, or argument wildcards)
- **verifier** — exact non-destructive test/lint/build/cargo commands only; no source edit, git staging/commits, fix modes, snapshot updates, or arbitrary trailing arguments. Project-owned verification scripts are a deliberate trust boundary: they may create disposable build/test artifacts, but the Verifier profile must not receive arbitrary arguments beyond the reviewed exact command forms.
- **scribe** — documentation paths only (`README.md`, `docs/**`, and related doc files); no source-code edit or mutating bash

In the app source repository, `scripts/validate_opencode_permissions.py` asserts the composed contract and `scripts/generate-agent-adapters.py --check` verifies deterministic generated adapters; neither ships in the installed workspace.

The default template is conservative:

- Sharing is disabled
- Most operations default to "ask"
- Read access is broadly allowed except for secret-bearing files (`.env` files, SSH private keys, kubeconfig, Terraform state/vars, Ansible vaults, shell history, local credential files)
- Native read/grep/list tools are preferred for file inspection because they honor read-deny rules
- Bash content commands (`cat`, `head`, `tail`, `sed`, `grep`, `rg`, `git grep`) are ask-gated because bash permissions are separate from read permissions
- Secret-file protections exist in read, edit, and bash permissions for: `.env` files, SSH private keys (`id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`), `kubeconfig` and `.kube/**`, Terraform state/vars (`terraform.tfstate*`, `terraform.tfvars`, `*.tfvars`), Ansible vault files (`vault.yml`, `secrets.yml`), shell history (`.bash_history`, `.zsh_history`), and local credential files (`master.key`, `.pgpass`, `.my.cnf`, `.envrc`, `*.ppk`, `*.jks`, `Pulumi.*.yaml`)
- Write access is restricted to source code directories
- Destructive commands (`sudo`, `rm -rf`, `git reset --hard`, `git clean -fdx`, pipe-to-bash) are denied globally and in each agent
- Cargo verification commands (`cargo fmt`, `cargo check`, `cargo clippy`, `cargo test`) are allow-listed where verification is expected
- `git checkout` and `git pull` are ask-gated because they can change working-tree state at runtime
- `npm run dev` and other dev server commands are ask-gated in the bundled default starter template

## TUI config

`templates/tui.json` controls TUI-only preferences such as theme, diff layout, mouse, scroll behavior, and leader timeout. It installs to `~/.config/opencode/tui.json` with the OpenCode config target.

## Managed-key merge

Install does **not** overwrite the entire installed `opencode.json`. It merges only the keys listed in `metadata/opencode-managed-keys.json` (model, permissions, Playwright MCP, compaction, watcher, and related settings). User `provider` blocks and non-Playwright MCP servers are preserved. Managed keys are reset to the bundled values on every update, so keep your own settings in unmanaged keys.

Legacy `~/.config/opencode/agents/scout.md` files from the pre-rename Agent Workspace scout are removed on agent sync when frontmatter is `name: scout`.

## Install workflow

1. Open the OpenCode tab. The `opencode_config`, `opencode_agents`, and `opencode_rules` targets decide what is installed (Space toggles).
2. Press `p` to preview or `u` to review, then `y` to apply.
3. The install merges the managed keys into `~/.config/opencode/opencode.json`, writes `tui.json`, the Playwright MCP config, and `~/.config/opencode/agents/*.md`. Extra agent files already in that directory are not deleted.

Both JSON files are validated before and after the write. Existing files that differ are backed up first.

## App-level model override

The OpenCode tab has a model override in its runtime pane (`e` edit, `s` save, `m` reload the model list). A saved selection is stored in an app-level override file:

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
