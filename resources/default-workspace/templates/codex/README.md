# Codex Config

Versioned Codex config template for settings sync.

This workspace treats Codex support as config sync only. It does not run Codex, start agents, manage project-specific Codex settings, or store target-project profiles.

Files:

- `config.toml` is the canonical global config template. Profiles are defined under `[profiles.<name>]` in this file; Codex does not load separate profile files from `~/.codex/profiles`.
- `mcp/` contains optional MCP snippets. Review before use.

Sync with:

```bash
./scripts/install-codex-config.sh --diff
./scripts/install-codex-config.sh --apply
```
