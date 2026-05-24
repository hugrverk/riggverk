# Codex Config

Versioned Codex config template for manual review.

This workspace supports Codex rules sync and a config template for diff/manual review. It does not run Codex, start agents, manage project-specific Codex settings, or store project registries.

Files:

- `config.toml` is the canonical global config template. Profiles are defined under `[profiles.<name>]` in this file; Codex does not load separate profile files from `~/.codex/profiles`.
- `mcp/` contains optional MCP snippets. Review before use.

Preview differences:

```bash
./scripts/install-codex-config.sh --diff
```

Default target:

- Codex config: `~/.codex/config.toml` or `CODEX_CONFIG_PATH`

The app does not overwrite `~/.codex/config.toml`. Codex can update that file itself, and full-file replacement can remove user-owned model, profile, personality, MCP, or project-trust settings. Review diffs and update Codex config manually. The CLI script requires `--force-overwrite` with `--apply` for deliberate advanced use.
