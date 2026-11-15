## Copilot harness

- This base is the managed block of `~/.copilot/copilot-instructions.md`, which the Copilot CLI and Copilot sessions in VS Code read as personal instructions. Riggverk manages only the block; text below its END marker is the user's.
- Skills install to `~/.agents/skills`, which Copilot reads. The Copilot CLI does not read `~/.claude/skills`; Copilot in VS Code reads it too.
- `/delegate` and `/security-review` are Copilot CLI built-in commands; the bundled skills that hand slices to other agent CLIs and review a change's security risks are `dispatch` and `security`.
- Do not edit the rest of `~/.copilot` (`config.json`, `settings.json`, `mcp-config.json`, `permissions-config.json`): it holds state, permissions, and credentials.
- Respect Copilot tool-permission prompts and directory trust; do not work around them.
