## Kilo harness

- This base is the managed block of Kilo's global rules file, `$XDG_CONFIG_HOME/kilo/AGENTS.md` (default `~/.config/kilo/AGENTS.md`). Riggverk manages only the block; text below its END marker is the user's.
- Kilo uses the first global rules file it finds. While this file exists, `~/.claude/CLAUDE.md` is not read by Kilo, so refinements kept only there do not reach it; keep them below the END marker.
- Skills install to `~/.agents/skills`, which Kilo reads (it also reads `~/.claude/skills`).
- Do not edit `kilo.jsonc` or `kilo.json` (provider keys, permissions, models) or anything else in `~/.kilo` unless asked.
