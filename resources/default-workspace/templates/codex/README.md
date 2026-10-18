# Codex Config

Versioned Codex config template with managed-key merge.

This workspace treats Codex support as rules, native TOML agent install, managed config merge, and skills. It does not run Codex, manage project-specific Codex settings, or store target-project profiles.

Files:

- `config.toml` is the canonical global config template. It holds top-level managed keys (`approval_policy`, `approvals_reviewer`, `sandbox_mode`, `apps._default.*`) and the create-only seeds `model` and `model_reasoning_effort`, which are written only when your config has no value. Codex 0.134+ no longer loads `[profiles.*]` tables or a top-level `profile` selector; profiles are separate `$CODEX_HOME/<name>.config.toml` overlays selected with `--profile`.
- `mcp/` contains optional MCP snippets. Review before use.
- `agents/` contains the native Codex agents (`*.toml`).

In the app, press `p` to preview the differences and `u` to review and apply. The merge touches only the managed keys of `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`), and the bundled agents install to `$CODEX_HOME/agents`. These are the `codex_config` (off by default) and `codex_agents` targets; see [docs/CODEX_CONFIG.md](../../docs/CODEX_CONFIG.md).
