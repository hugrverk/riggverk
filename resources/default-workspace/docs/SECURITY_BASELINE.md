# Security Baseline

## What this is and is not

A short guide to what the bundle does and does not limit when an agent works in your repository, and what to do yourself.

Rules and agent instructions are advice. A model can ignore them, misread them or be talked out of them by text in a file it reads. Only two things stop an action: the harness's own permission engine (an approval prompt or a deny rule) and an OS sandbox or container around the process. Anything below that says "advice" does not stop anything.

The `security` group on a harness page reads a few named keys of that harness's global config and says what they set. It reads config only. It does not make a machine safe, and a page with no risky rows says only that those files hold nothing the check knows to flag. See [What the posture check sees](#what-the-posture-check-sees).

## What each harness gets from the bundle

| Harness | Enforced by the harness | Advice only | What you decide |
| --- | --- | --- | --- |
| Claude Code | Nothing in `settings.json`: the app does not write it. Some agent headers carry limits the harness applies: `verifier` has `disallowedTools: Write, Edit` and `sentinel` has `permissionMode: plan` (`templates/claude/agents/`). | The rules block in `CLAUDE.md`, including the no-print rule for secrets. | Set `permissions.deny`, `sandbox.enabled` and `permissions.disableBypassPermissionsMode` yourself. A deny rule on `Bash` matches the command text, and the sandbox covers shell commands only. |
| Codex | Only with the `codex_config` target, which is off by default: `approval_policy = "on-request"` and `sandbox_mode = "workspace-write"` (`templates/codex/config.toml`). Read-only agents set `sandbox_mode = "read-only"`. | The rules block in `AGENTS.md`. | Keep `network_access` off, trust a project only after reading its `.codex/`, and do not run with `--yolo`. |
| OpenCode | The `permission` block in `templates/opencode.json`, generated from `opencode.base.json` and `opencode.policy.json`: `"*": "ask"`, deny rules for secret files, ask for web fetch and search, sharing disabled. The rules are matched against command and path text, not enforced by an OS sandbox ([OPENCODE_CONFIG.md](OPENCODE_CONFIG.md)). | The rules block in `AGENTS.md`. | Keep secrets gitignored or outside the project (`grep` can show the contents of any file ripgrep reads), and use a container for repositories you do not trust. |
| Cursor | `readonly: true` on the read-only agents. Run mode, `~/.cursor/sandbox.json` and `permissions.json` are not managed. | The rules and the user rules text. | Prefer auto-review, never use Run Everything on a repository you do not know, and consider a `~/.cursor/sandbox.json`. |
| Copilot CLI, Pi, Kilo Code | Nothing. | The rules block. | Use a container or VM. For Kilo, write your own `permission` block. For Copilot, approve tools one at a time instead of `--allow-all-tools`. |
| MCP (Playwright) | The managed entry runs with `--isolated` and a pinned version (`templates/mcp/*.json`, `templates/playwright-mcp.config.json`). | None. | Review any MCP server you add: it runs with your rights. |

## Practice

- Open an unknown repository in a devcontainer or a VM, not on your own account.
- Review `.claude/`, `.codex/`, `.cursor/`, `.mcp.json` and `.vscode/` in pull requests like code. Project config can run commands or widen permissions before you approve anything.
- Keep production credentials out of the agent's shell. Use separate, short-lived, narrowly scoped tokens, fetched for one command and not exported into the environment.
- Use bypass, yolo or run-everything modes only inside an isolated environment you can throw away.
- Treat anything an agent reads from the web, a ticket or a dependency as untrusted text that can carry instructions.

## What the posture check sees

It reads, in memory and only the named keys, one global config file per harness: Claude `~/.claude/settings.json`, Codex `config.toml` in `CODEX_HOME`, OpenCode `opencode.json`, `opencode.jsonc` and `config.json`, Cursor `~/.cursor/sandbox.json`, Kilo `kilo.jsonc` or `kilo.json`. It keeps and shows no value from them, only fixed phrases and counts.

It does not see project or managed config, profiles, command-line flags, aliases or environment overrides, any of which can change what a harness does. It does not read `.env` files. For Copilot CLI and Pi it reads nothing. A row marked `enforced` means the key is set in the file read, not that the whole machine is covered.
