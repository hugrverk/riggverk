# Codex Config

Codex config/profile templates live under `templates/codex/`.

This workspace supports Codex as config sync only. It does not run Codex, start agents, manage project-specific Codex settings, or store project registries.

Preview or apply sync:

```bash
./scripts/install-codex-config.sh --diff
./scripts/install-codex-config.sh --apply
```

Default targets:

- Codex config: `~/.codex/config.toml` or `CODEX_CONFIG_PATH`
- Codex profiles: `~/.codex/profiles` or `CODEX_PROFILES_PATH`

Review the templates against your installed Codex version before applying.
