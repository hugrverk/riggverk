# Codex Config

Versioned Codex config template for manual review.

This workspace treats Codex support as rules sync plus config diff/manual review. It does not run Codex, start agents, manage project-specific Codex settings, or store target-project profiles.

Files:

- `config.toml` is the canonical global config template. Profiles are defined under `[profiles.<name>]` in this file; Codex does not load separate profile files from `~/.codex/profiles`.
- `mcp/` contains optional MCP snippets. Review before use.

Preview differences with:

```bash
./scripts/install-codex-config.sh --diff
```

The app does not overwrite `~/.codex/config.toml`. Full-file replacement can remove Codex-managed or user-owned settings. The CLI script requires `--force-overwrite` with `--apply` for deliberate advanced use.
