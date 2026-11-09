---
name: browser-qa
description: Verifies frontend changes in a real browser or automation with route smoke, critical interactions, two or more viewports, console and network checks, and dev-server lifecycle. Use when a user-facing UI change needs proof that it works. Not for critiquing supplied screenshots (screenshot-review).
license: MIT
compatibility: Needs browser automation, such as the Playwright MCP server Riggverk installs or the Playwright CLI route in playwright-cli.md (needs Node.js and npm).
metadata:
  category: frontend
  risk: medium
  targets: codex, opencode, claude, cursor, copilot, pi, kilo, antigravity, grok
  related: screenshot-review, accessibility-review, frontend-design
---

# Browser QA

Done when: each affected route loaded without unclassified console errors or failed requests, each critical interaction ran at two or more viewports where layout changed, and server lifecycle is reported.

## Do Not Use When

- The task only asks for visual diagnosis from provided screenshots; use `screenshot-review`.
- No runnable app, build or URL exists; report the blocker instead.
- The change is backend-only and has no browser-visible behavior.
- You did not run a browser; do not claim browser verification.

## Browser QA vs Screenshot Review

- Screenshot review diagnoses static images the user provides or that already exist.
- Browser QA runs the product, loads routes, checks console/network behavior, performs interactions, and may capture screenshots as evidence.

## Process

1. Identify target routes, entry points, and critical flows affected by the change.
2. Before starting a local dev server, check whether the required local URL or port already responds. Reuse an existing server when possible; do not start duplicates.
3. If you start a dev server, record enough command, PID, session, and port detail to stop only the server you started. You own cleanup for servers you start.
4. Run smoke tests in an actual browser or available browser automation:
   - Page loads.
   - Main content renders.
   - Navigation works.
   - No blocking console errors.
   - No unexpected failed network requests.
5. Exercise critical interactions:
   - Forms, validation, submit states, search, filters, menus, modals, tabs, drawers, checkout, onboarding, or admin flows as relevant.
6. Check responsive behavior:
   - At minimum one desktop and one mobile/tablet viewport when layout changed.
   - Verify text fits, controls remain usable, and no incoherent overlap appears.
7. Run accessibility smoke:
   - Keyboard reachability for critical controls.
   - Visible focus.
   - Labels or accessible names for controls.
   - Obvious contrast, heading, landmark, and semantic issues.
8. Capture screenshots or traces where useful for layout, regression evidence, or failure diagnosis.
9. Stop any dev server you started before the final report. If cleanup cannot be completed safely, report exact port/process status and risk.
10. No browser tool in the session (the Playwright MCP server is off by default in some harnesses)? Use the Playwright CLI route in `playwright-cli.md` next to this file instead of skipping the browser run.
11. Keep the run bounded; list untested flows instead of pretending coverage is complete.

## Output

- Exact URLs or routes tested.
- Browser/tool used.
- Viewport sizes.
- Steps run.
- Console errors and network failures.
- Screenshots or artifacts, if captured.
- Dev server lifecycle status: reused existing server, no server needed, or started and stopped with port/process details.
- Failures found.
- Untested areas and remaining risk.

## Guardrails

- Do not rely only on a screenshot for interaction claims.
- Do not hide console or network failures; classify whether they block the task.
- Do not require a specific browser MCP or tool; use available local tooling, down to the Playwright CLI.
- Do not claim browser smoke completed without reporting dev server lifecycle status.

## Harness notes

### Claude Code

- When the Claude Code Browser pane tools are available, prefer them: `preview_start` (a `.claude/launch.json` entry or a URL) to launch or attach, `navigate` plus `read_page`/`find` for structure, `read_console_messages` and `read_network_requests` for failures, `resize_window` presets for responsive checks, and screenshots as evidence.
- Attach to an already-running dev server with a url-only launch entry instead of starting a duplicate.
- Without browser tooling, use the Playwright CLI route in `playwright-cli.md` and state what could not be exercised.

### Codex

- Prefer Playwright, browser tools, appshots, screenshots, CDP inspection, or computer-use tools according to what is available in the session.
- Capture concise evidence: route, viewport, interaction, console or network findings, and screenshot path when visual proof matters.

### Light harnesses

- The Playwright MCP entry is off unless the harness is enabled in Riggverk and the server is running in that session. If no browser tool is listed, do not claim browser verification: follow `playwright-cli.md`.
