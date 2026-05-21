# Codex Config

Versioned Codex config template for settings sync.

This workspace supports Codex as config sync only. It does not run Codex, start agents, manage project-specific Codex settings, or store project registries.

Files:

- `config.toml` is the canonical global config template. Profiles are defined under `[profiles.<name>]` in this file; Codex does not load separate profile files from `~/.codex/profiles`.
- `mcp/` contains optional MCP snippets. Review before use.

Preview or apply sync:

```bash
./scripts/install-codex-config.sh --diff
./scripts/install-codex-config.sh --apply
```

Default target:

- Codex config: `~/.codex/config.toml` or `CODEX_CONFIG_PATH`

Review the template against your installed Codex version before applying.
