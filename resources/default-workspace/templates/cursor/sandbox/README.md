# Legacy Cursor Sandbox Profile Templates (debug only)

These JSON files are **legacy debug/copy templates**. They are not used by the primary global profile workflow.

Use the global profile instead:

- `../global-profile.json` — machine-readable global profile
- `../permissions/global-playwright.json` — `~/.cursor/permissions.json` merge template
- `scripts/install-cursor-workspace.sh --apply-global-profile`

The global profile merges Playwright MCP auto-approval via documented `~/.cursor/permissions.json` (`mcpAllowlist`) and does not add shell command allowlists for Playwright.

## Legacy profiles (copy/debug)

- `safe.json` — minimal, no MCP allowlist
- `playwright-safe.json` — conservative documentation profile
- `playwright-full.json` — documents `playwright:*` MCP allowlist (now in `permissions/global-playwright.json`)

Rules unchanged: do not add `npx`, `npm`, `node`, browser launch commands, or Playwright commands to terminal/command allowlists for MCP support.
