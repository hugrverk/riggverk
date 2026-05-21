# Cursor MCP Examples

MCP configuration is explicit opt-in. Cursor reads project MCP config from `.cursor/mcp.json` and global MCP config from `~/.cursor/mcp.json`.

Review every MCP server before enabling it. MCP servers can access external services and execute code through their transport, so treat this directory as high-risk template material.

Rules:

- Do not commit literal API keys, tokens, cookies, auth headers, private URLs, passwords, private keys, or raw environment values.
- Use Cursor environment interpolation for auth-like values, for example `${env:EXAMPLE_API_KEY}`.
- Prefer local stdio examples for starter templates.
- Keep project-specific MCP config in the target project, not in this profile repo.
- Playwright MCP support belongs in MCP config plus an MCP tool allowlist profile, not in a command allowlist. See `templates/cursor/sandbox/`.
