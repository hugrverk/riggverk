---
name: accessibility-review
description: Audits UI code or a running app for WCAG 2.2 AA risks in semantics, names, keyboard, focus, labels, contrast, and reflow. Use when an accessibility review is requested or custom controls, modals, menus, live status, or dynamic validation change. Not for visual direction (frontend-design).
license: MIT
metadata:
  category: accessibility
  risk: low
  targets: codex, opencode, claude, cursor, copilot, pi, kilo, antigravity, grok
  related: frontend-design, browser-qa
---

# Accessibility Review

Done when: every changed interactive control is checked for name, role, state, keyboard operation, and visible focus, and each finding states its evidence type (observed or code-inferred) and a fix.

## Do Not Use When

- The task is primarily visual style, brand, or layout polish, or baseline accessibility while building UI; use `frontend-design`.
- The task is general runtime verification of a change; use `browser-qa`, and add this skill only for the accessibility part.
- The task requires formal legal certification or a full WCAG audit.
- The UI cannot be inspected in code, screenshots, or browser output.

## Review Areas

1. Semantics:
   - Use native elements where possible.
   - Headings, landmarks, lists, tables, buttons, links, and forms match their purpose.
   - ARIA is used only when needed and does not fight native behavior.
2. Name, role, value:
   - Controls have accessible names.
   - State is exposed for expanded, selected, checked, disabled, invalid, busy, or current states.
   - Custom controls expose expected roles and keyboard behavior.
3. Keyboard:
   - All interactive controls are reachable and operable by keyboard.
   - Tab order follows visual and task order.
   - No keyboard traps.
   - Shortcuts do not block browser or assistive tech defaults.
4. Focus:
   - Visible focus is present and not clipped.
   - Modals, menus, dropdowns, drawers, and popovers move, trap, and restore focus appropriately.
   - Hidden content is not focusable.
5. Forms and feedback:
   - Labels are programmatic, not placeholder-only.
   - Hints and errors are associated with fields.
   - Required, invalid, and disabled states are clear.
   - Async success/failure/status changes use appropriate live regions when needed.
6. Visual accessibility:
   - Text and meaningful UI have sufficient contrast.
   - State is not conveyed by color alone.
   - Text can reflow and scale without overlap or clipping.
   - Targets are large enough for touch and pointer use.
7. Responsive behavior:
   - Reading order remains logical.
   - Zoom, small viewport, and mobile layouts keep controls reachable and labels visible.

## Output

- Scope reviewed.
- Findings with severity (blocker, serious, moderate, minor by effect on users), evidence type (`observed` when keyboard or assistive tech was exercised, `code-inferred` otherwise), and affected users.
- Recommended fix for each issue.
- Checks run: code, browser, keyboard, automated scan, screenshot, or manual inspection.
- Not verified.
- Residual risk.

## Guardrails

- Do not claim WCAG compliance unless a full formal audit was performed.
- Do not replace semantic HTML with ARIA when native elements solve the problem.
- Do not duplicate aesthetic guidance from `frontend-design`.
- Do not claim keyboard or screen-reader behavior without evidence.
