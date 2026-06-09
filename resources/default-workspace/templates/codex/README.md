# Codex Config

Versioned Codex config template for manual review.

This workspace treats Codex support as rules sync, native TOML agent install, managed config merge, and skills sync. It does not run Codex, manage project-specific Codex settings, or store target-project profiles.

Files:

- `config.toml` is the canonical global config template. Profiles are defined under `[profiles.<name>]` in this file; Codex does not load separate profile files from `~/.codex/profiles`.
- `mcp/` contains optional MCP snippets. Review before use.

Preview differences with:

```bash
./scripts/install-codex-config.sh --diff
```

`./scripts/install-codex-config.sh --apply` merges managed profile sections only. `./scripts/install-codex-agents.sh --apply` syncs bundled native agents to `~/.codex/agents`.

Full-file replacement remains available with `--apply --force-overwrite` for deliberate advanced use.
