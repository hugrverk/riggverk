## Codex harness

- Custom agents use bundled Codex TOML templates under `~/.codex/agents/`; skills install to `$CODEX_HOME/skills` (typically `~/.codex/skills`) unless `CODEX_SKILLS_PATH` overrides.
- `~/.codex/config.toml` is manual-review only; never assume Agent Workspace owns the full file.
- Respect Codex sandbox, approval, and config boundaries; do not bypass documented safety settings.
