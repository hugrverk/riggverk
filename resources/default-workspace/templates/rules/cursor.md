## Default operating mode

Cursor rules, skills, subagents, and MCP are separate surfaces.
Use subagents only when they reduce risk, context load, or verification burden.
Do not duplicate workflow instructions across all surfaces.

## Cursor harness

- Use bundled Cursor agents, skills, User Rules, and MCP through native setup; Agent Workspace does not own project rules or Auto Review.
- Manual Auto Review stays user-controlled; do not assume the app can trigger it.

## Dev server lifecycle

Before starting a local dev server for browser work, check whether the needed URL or port already responds and reuse it when possible. Do not start duplicate servers.
If you start a dev server, record enough command, PID, session, and port detail to stop only the server you started. Stop it before the final report. If cleanup cannot be completed safely, report the exact port/process status and remaining risk.
Do not claim browser smoke or `browser-qa` completed without reporting server lifecycle status. Kretsverket may use `http://localhost:1420/`; verify before starting a replacement server.
