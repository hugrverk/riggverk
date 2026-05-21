# Cursor Profile

This directory is the starter Cursor profile source for this workspace.

- `user-rules.md` is copied manually into Cursor Settings. It is not installed to a file-backed global path.
- `rules/*.mdc` are project rules for `.cursor/rules`.
- `agents/*.md` are focused Cursor subagents. Use them when they reduce risk or context load.
- `manifest.json` is the machine-readable profile inventory used by checks and GUI integrations.
- `mcp/` contains opt-in examples only. Review MCP security before creating `.cursor/mcp.json` in a project.
- `sandbox/` contains versioned Auto-Run, sandbox, command allowlist, and MCP allowlist templates. They are show/copy/manual templates only.

Install/diff through `scripts/install-cursor-workspace.sh`; scripts remain the source of truth for sync behavior.
