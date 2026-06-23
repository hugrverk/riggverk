## Codex harness

- Custom agents use bundled Codex TOML templates under `~/.codex/agents/`; skills install to `$CODEX_HOME/skills` (typically `~/.codex/skills`) unless `CODEX_SKILLS_PATH` overrides.
- `~/.codex/config.toml` is manual-review only; never assume Agent Workspace owns the full file.
- Respect Codex sandbox, approval, and config boundaries; do not bypass documented safety settings.

## Codex command handling
Default to concise shell inspection. Before running a command that may emit large output, rewrite it to a bounded form such as `COMMAND 2>&1 | head -c 4000`.

If `rtk` is installed and the command is inspection-only, prefer the RTK equivalent. If exact output is required, do not use RTK.

Avoid repeated full test/typecheck/build loops after tiny edits. Use the lightest falsifying check during iteration, then run the broader relevant verification once before final report.
