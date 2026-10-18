## Pi harness

- This base is the managed block of `~/.pi/agent/AGENTS.md`. Pi loads one context file per folder (`AGENTS.override.md`, then `AGENTS.md`, then `CLAUDE.md`) from the agent folder, the working directory, and its parents; it does not read `~/.claude/CLAUDE.md`. Riggverk manages only the block; text below its END marker is the user's.
- Skills install to `~/.agents/skills`, which Pi reads next to `~/.pi/agent/skills`.
- Do not edit the rest of `~/.pi/agent` (`auth.json`, `models.json`, `settings.json`, `sessions/`): it holds credentials and state.
