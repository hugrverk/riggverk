# Codex Config

Versioned Codex config template with managed-section merge.

This workspace supports Codex rules sync and config sync via managed-section merge. It does not run Codex, start agents, manage project-specific Codex settings, or store project registries.

Files:

- `config.toml` is the canonical global config template. Profiles are defined under `[profiles.<name>]` in this file; Codex does not load separate profile files from `~/.codex/profiles`.
- `mcp/` contains optional MCP snippets. Review before use.

Preview differences:

```bash
./scripts/install-codex-config.sh --diff
```

Default target:

- Codex config: `~/.codex/config.toml` or `CODEX_CONFIG_PATH`

`./scripts/install-codex-config.sh --apply` merges only managed sections listed in `metadata/codex-managed-keys.json` (safe profile defaults). User model, personality, MCP, and unknown tables are preserved. Same-line inline comments on managed scalar assignments (for example `profile = "custom"  # note`) are preserved; ambiguous lines refuse with zero mutation.

Native Codex agents live in `templates/codex/agents/*.toml` and sync to `~/.codex/agents` via `./scripts/install-codex-agents.sh`.

Skills install to `~/.agents/skills`. Legacy `~/.codex/skills` migration is available from the Codex skills panel.

The CLI still supports `--apply --force-overwrite` for deliberate full-file replacement after backup. The app uses managed-section merge only.
