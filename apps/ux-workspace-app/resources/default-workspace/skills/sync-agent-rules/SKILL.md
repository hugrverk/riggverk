---
name: sync-agent-rules
description: Review, compress, or sync global agent rules for Codex, OpenCode, and Auggie from the ux-workspace template.
---

# Sync Agent Rules

## Purpose
- Keep global agent rules consistent across Codex, OpenCode, and Auggie.
- Prefer editing `templates/global-agent-rules.md` over editing generated target files.

## Process
1. Inspect `templates/global-agent-rules.md`, `docs/AGENT_RULES.md`, and `scripts/install-agent-rules.sh`.
2. Keep rules concise, tool-neutral, and security-preserving.
3. Avoid duplicating project-local guidance.
4. If behavior changes, update docs and installer together.
5. Use dry-run before apply.

## Output
- Rules changed.
- Targets affected.
- Verification run.
- Remaining risk.
