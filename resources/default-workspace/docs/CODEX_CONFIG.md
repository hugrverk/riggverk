# Codex Config

Versioned Codex config template with managed-section merge.

This workspace supports Codex rules sync and config sync via managed-section merge. It does not run Codex, start agents, manage project-specific Codex settings, or store project registries.

Files:

- `config.toml` is the canonical global config template. It manages the Codex routing defaults `model`, `model_reasoning_effort`, `approval_policy`, `approvals_reviewer`, `sandbox_mode`, `apps._default.approvals_reviewer`, and `apps._default.default_tools_approval_mode`. Codex 0.134+ removed the legacy top-level `profile = "..."` selector and `[profiles.*]` tables; profiles now live in separate `~/.codex/<name>.config.toml` overlays selected with `--profile`.
- `mcp/` contains optional MCP snippets. Review before use.

Preview differences:

```bash
./scripts/install-codex-config.sh --diff
```

Default target:

- Codex config: `~/.codex/config.toml` or `CODEX_CONFIG_PATH`

`./scripts/install-codex-config.sh --apply` merges only managed Codex defaults into `~/.codex/config.toml`. The legacy merge owner keeps `approval_policy` and `sandbox_mode` in sync and removes app-shaped legacy `profile = "safe"` selectors plus `[profiles.safe]`/`[profiles.workspace-write]` tables. The routing-defaults owner then enforces the template's defaults from `templates/codex/config.toml` — currently `gpt-5.6-sol` high reasoning, manual approval review, workspace-write sandboxing, and prompt-based app default tool approvals; the template is the single value source for future bumps. User personality, MCP entries, unrelated tables, and unknown keys are preserved; ambiguous TOML refuses with zero mutation.

Native Codex agents live in `templates/codex/agents/*.toml` and sync to `~/.codex/agents` via `./scripts/install-codex-agents.sh`.

Skills install to `$CODEX_HOME/skills` (typically `~/.codex/skills`), the location the Codex CLI auto-discovers. Copies under the previous `~/.agents/skills` app location are migrated and cleaned up by the managed update.

The CLI still supports `--apply --force-overwrite` for deliberate full-file replacement after backup (advanced). The app uses managed-section merge only.
