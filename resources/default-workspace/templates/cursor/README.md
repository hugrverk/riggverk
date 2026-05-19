# Cursor Setup

This directory contains Cursor-specific setup assets:

- `templates/cursor/agents/*.md` installs to `~/.cursor/agents` or `<project>/.cursor/agents`.
- `templates/cursor/rules/agent-workspace.mdc` installs to `<project>/.cursor/rules/agent-workspace.mdc`.
- Skills install separately with `scripts/install-skills.sh --agent cursor`.

Cursor User Rules are configured in Cursor Settings > Rules. This workspace does not claim or write a global User Rules file path.
