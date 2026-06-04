---
name: browser-qa
description: Verify frontend changes in a live browser or browser automation with route smoke tests, interactions, responsive checks, console/network review, and concise evidence.
category: frontend
risk: medium
targets: codex, opencode, claude
related: screenshot-review, accessibility-review, frontend-design
---

# Browser QA

## Purpose

- Verify rendered UI and interactions in an actual browser after frontend changes.
- Catch runtime failures that static tests, screenshots, or code review miss.
- Report precise browser evidence without overstating coverage.

## When To Use

- Frontend UI, routing, layout, form, navigation, checkout, onboarding, admin, search, filter, or interaction changes.
- CSS/responsive changes where viewport behavior matters.
- Changes involving client-side data fetching, hydration, routing, or browser-only APIs.
- Before claiming a user-facing UI flow is fixed.

## Do Not Use When

- The task only asks for visual diagnosis from provided screenshots; use `screenshot-review`.
- No runnable app, build, URL, or browser access exists; report the blocker instead.
- The change is backend-only and has no browser-visible behavior.
- You did not run a browser; do not claim browser verification.

## Browser QA vs Screenshot Review

- Screenshot review diagnoses static images the user provides or that already exist.
- Browser QA runs the product, loads routes, checks console/network behavior, performs interactions, and may capture screenshots as evidence.

## Process

1. Identify target routes, entry points, and critical flows affected by the change.
2. Before starting a local dev server, check whether the required local URL or port already responds. Reuse an existing server when possible; do not start duplicates. Kretsverket may use `http://localhost:1420/`.
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
10. Keep the run bounded; list untested flows instead of pretending coverage is complete.

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

- Do not claim browser QA without running a browser.
- Do not rely only on a screenshot for interaction claims.
- Do not hide console or network failures; classify whether they block the task.
- Do not require a specific browser MCP or tool; use available local tooling.
- Do not claim browser smoke completed without reporting dev server lifecycle status.
