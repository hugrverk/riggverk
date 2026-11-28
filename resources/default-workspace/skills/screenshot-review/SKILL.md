---
name: screenshot-review
description: Critiques supplied screenshots of any UI, app or document into a ranked patch plan without edits. Use when the user shares screenshots to critique.
license: MIT
metadata:
  category: frontend
  risk: low
  targets: codex, opencode, claude, cursor, copilot, pi, kilo, antigravity, grok
  related: frontend-design, browser-qa, accessibility-review
---

# Screenshot Review

Turn supplied screenshots into a bounded diagnosis and patch plan; do not jump straight to code. Any screenshot counts: web pages, desktop and mobile apps (macOS, iOS, Windows, Android), error dialogs and terminal output, dashboards and charts, reports, slides and PDFs.

Done when: each issue has a root-cause hypothesis, the likely cause or file (a file only when there is code to point at), and how to verify the fix.

## Process

1. Inspect the supplied screenshots and any relevant route, component, source file or document context.
2. Identify what each one shows: the kind of surface, the platform, the viewport or window size, the page or app state, and the user flow.
3. Review hierarchy, spacing, density, alignment, typography, color, affordance, accessibility, and responsive or adaptive behavior; for text output (dialogs, terminals), what the message says.
4. Compare against existing design tokens, components, styles and product language when the repository or source document is available.
5. Rank issues by user impact and fix risk.
6. Propose a small patch plan. Edit nothing unless the user explicitly asks. With code, name the likely file; without code, name what to change (the setting, the element, the wording), not a file.

## Web UI causes

- Squeezed or overflowing text in a row: a flex or grid item missing `min-width: 0`, a grid track of `1fr` that needs `minmax(0, 1fr)` (a `1fr` track keeps an automatic min-content minimum), or truncation missing one of `overflow: hidden`, `text-overflow: ellipsis` and `white-space: nowrap`.
- Clipped focus ring or shadow: `overflow: hidden` on an ancestor, or no padding around focusable content.
- Horizontal scroll: fixed widths, `100vw` (it includes a classic, non-overlay scrollbar, so it overflows by the scrollbar width; use `100%`), or an unwrapped wide element (table, `pre`, image).
- Misaligned icon/text rows: mixed line-heights or icons not flex-centered.
- Uneven spacing rhythm: hardcoded margins instead of the repo's spacing tokens.

## Native app causes

- Truncated or clipped text on iOS or macOS: a fixed height or width on the label or view, a one-line limit (UIKit's `UILabel` defaults to `numberOfLines = 1`, so a long label truncates unless it is set to `0` for unlimited; SwiftUI `.lineLimit(1)`), or Auto Layout content hugging and compression resistance priorities that let a neighbour win.
- Text that breaks at larger text sizes: fixed sizes that ignore Dynamic Type on iOS, or fixed `dp` heights around text sized in `sp` on Android when the user raises the font scale.
- Content under the notch, status bar, home indicator or system bars: content pinned to the screen edges instead of the safe area (iOS), or an edge-to-edge layout that does not apply the system bars and display cutout insets (Android, where edge-to-edge is enforced when an app targets SDK 35). Full-bleed backgrounds pinned to the edges are intentional; only content belongs inside the safe area.
- Unreadable or invisible elements in dark mode: hardcoded colors or images instead of semantic or theme colors with a dark variant.
- Verify on the device sizes, text sizes and appearances the screenshot shows, plus the smallest and largest supported.

## Dialogs and terminal output

- Read the message literally and treat the first error as the starting hypothesis, not the verdict: it can be a wrapper or a symptom, and later lines are often its consequences. Some tools print the cause last (a Python traceback ends with the exception line). Point at the command, file or setting it names.
- Say when the screenshot cuts the output off, and ask for the full text instead of guessing the rest.
- Never repeat a secret, token or credential that appears in the image; describe its location and type only.
- Verify with a read-only or isolated reproduction when that is safe; otherwise inspect the existing evidence, and ask before re-running anything that changes state, since a screenshot can show a deploy, a deletion, a migration or a payment.

## Dashboards, charts and documents

- Hierarchy: the title or first line should state what the reader needs to know; the most important number or chart should be the most prominent.
- Legibility: text too small or too low in contrast for where it is read, dense paragraphs on slides, inconsistent fonts or alignment.
- Axes: missing units or labels, tick labels whose overlap or rotation harms reading (rotation that keeps them legible is fine), a bar chart whose value axis does not start at zero, or scales that differ between charts meant to be compared.
- Legends and color: a legend far from the data it explains, series that differ by color alone, too many series to tell apart.
- PDFs and exports: clipped margins or overflowing tables, and substituted fonts when the fonts were not embedded.
- Verify by re-rendering or re-exporting and comparing at the size it is read (screen, projector, print).

## Output

- Screenshot context.
- Main issues, ranked.
- Root cause hypothesis for each.
- Ranked fixes.
- Likely files, or what to change when there is no code.
- How to verify each fix (viewport, device, text size, appearance or a safe reproduction).
- Remaining uncertainty.

## Guardrails

- Do not redesign the product or document from one screenshot.
- Do not claim browser or device verification from a screenshot review alone.
- Do not invent design tokens if existing tokens fit.
- Say what the screenshot cannot show (other states, sizes, platforms) instead of assuming it.
