## Codex harness

- Custom agents use bundled Codex TOML templates under `~/.codex/agents/`; skills install to `~/.agents/skills`, which Codex reads (`$CODEX_HOME/skills` with a customised `CODEX_HOME`).
- `~/.codex/config.toml` is manual-review only; never assume Riggverk owns the full file.
- Respect Codex sandbox, approval, and config boundaries; do not bypass documented safety settings.
- For image generation, design mocks, screenshots, browser automation, CDP, or computer-use work, use the available Codex tools when they directly support the task and keep generated assets in scope.
- Use background agents or separate worktrees only for separable exploration, review, or implementation slices; keep final judgment and integration in the main thread.

## Codex command handling
Default to concise shell inspection. Before running a command that may emit large output, rewrite it to a bounded form such as `COMMAND 2>&1 | head -c 4000`.

Avoid repeated full test/typecheck/build loops after tiny edits. Use the lightest falsifying check during iteration, then run the broader relevant verification once before final report.
