## Antigravity harness

- This base is the managed block of `~/.gemini/AGENTS.md`, the global rules file Google Antigravity reads in the App, the IDE and the CLI (`agy`). Riggverk manages only the block; text below its END marker is the user's.
- Antigravity reads at most 24,000 bytes of one rules file. Keep refinements below the END marker short; Riggverk does not write a file that would pass the limit.
- `~/.gemini/GEMINI.md` is shared with the Gemini CLI and Riggverk does not touch it. Antigravity adds the rules of every global file it reads, so keep one copy of a rule.
- Skills install to `~/.gemini/config/skills` (App and IDE) and `~/.gemini/antigravity-cli/skills` (CLI). Antigravity reads neither `~/.agents/skills` nor `~/.claude/skills`.
- Do not edit the rest of `~/.gemini` (`antigravity-cli/settings.json`, `antigravity/mcp_oauth_tokens.json`, `config/agents/`): it holds settings, state, and credentials.
