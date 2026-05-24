# Cursor MCP Examples

MCP configuration is explicit opt-in. Agent Workspace only manages the global Cursor MCP file at `~/.cursor/mcp.json`.

Review every MCP server before enabling it. MCP servers can access external services and execute code through their transport, so treat this directory as high-risk template material.

Rules:

- Do not commit literal API keys, tokens, cookies, auth headers, private URLs, passwords, private keys, or raw environment values.
- Use Cursor environment interpolation for auth-like values, for example `${env:EXAMPLE_API_KEY}`.
- Prefer local stdio examples for starter templates.
- Keep project-specific MCP config outside this global profile.
- Playwright MCP support belongs in MCP config plus `~/.cursor/permissions.json`, not in a shell command allowlist. See `templates/cursor/permissions/global-playwright.json`.
