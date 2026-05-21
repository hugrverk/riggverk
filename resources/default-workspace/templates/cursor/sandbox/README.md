# Cursor Sandbox Profiles

Versioned templates for Cursor Auto-Run, sandbox, command allowlist, and MCP allowlist review.

These files are profile templates only. This workspace does not auto-write undocumented Cursor internal settings paths and does not persist project-specific sandbox profiles.

Profiles:

- `safe.json` keeps Auto-Run off and does not allow commands or MCP tools.
- `playwright-safe.json` allows Playwright MCP configuration without command allowlisting. Exact safe Playwright MCP tool names are intentionally left empty until verified against the installed MCP server.
- `playwright-full.json` is the explicit broad Playwright MCP profile and may allow `playwright:*`.

Rules:

- Do not add `npx`, `npm`, `node`, browser launch commands, or Playwright commands to the command allowlist just to support Playwright MCP.
- Use MCP allowlists for MCP tools.
- Treat broad fetch, shell, upload, and code-execution capability as unsafe unless the full profile explicitly documents it.
- Review and paste settings manually in Cursor; do not invent a global file-backed sandbox path.
