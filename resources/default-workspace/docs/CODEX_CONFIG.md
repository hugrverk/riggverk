# Codex Config

Versioned Codex config template with managed-section merge.

This workspace supports Codex rules sync and config sync via managed-section merge. It does not run Codex, start agents, manage project-specific Codex settings, or store project registries.

Files:

- `config.toml` is the canonical global config template. It manages plain top-level `approval_policy` and `sandbox_mode` defaults. Codex 0.134+ removed the legacy top-level `profile = "..."` selector and `[profiles.*]` tables; profiles now live in separate `~/.codex/<name>.config.toml` overlays selected with `--profile`.
- `mcp/` contains optional MCP snippets. Review before use.

Preview differences:

```bash
./scripts/install-codex-config.sh --diff
```

Default target:

- Codex config: `~/.codex/config.toml` or `CODEX_CONFIG_PATH`

`./scripts/install-codex-config.sh --apply` merges only managed sections listed in `metadata/codex-managed-keys.json` (top-level approval and sandbox defaults). User model, personality, MCP, and unknown tables are preserved, and app-shipped legacy `profile = "safe"` selectors plus `[profiles.safe]`/`[profiles.workspace-write]` tables are removed. Same-line inline comments on managed scalar assignments are preserved; ambiguous lines refuse with zero mutation.

Native Codex agents live in `templates/codex/agents/*.toml` and sync to `~/.codex/agents` via `./scripts/install-codex-agents.sh`.

Skills install to `$CODEX_HOME/skills` (typically `~/.codex/skills`), the location the Codex CLI auto-discovers. Copies under the previous `~/.agents/skills` app location are migrated and cleaned up by the managed update.

The CLI still supports `--apply --force-overwrite` for deliberate full-file replacement after backup. The app uses managed-section merge only.
