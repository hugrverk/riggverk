# Codex Config Profile

Versioned Codex config/profile templates for settings sync.

This workspace treats Codex support as config sync only. It does not run Codex, start agents, manage project-specific Codex settings, or store target-project profiles.

Files:

- `config.toml` is the conservative global config template.
- `profiles/safe.toml` keeps prompts approval-oriented.
- `profiles/workspace-write.toml` is a workspace-write profile for trusted local repos.
- `mcp/` contains optional MCP snippets. Review before use.

Sync with:

```bash
./scripts/install-codex-config.sh --diff
./scripts/install-codex-config.sh --apply
```
