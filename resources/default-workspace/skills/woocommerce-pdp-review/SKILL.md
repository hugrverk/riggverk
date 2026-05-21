---
name: woocommerce-pdp-review
description: Review or improve WooCommerce product detail pages while preserving gallery, variation, stock, price, add-to-cart, tabs, reviews, and responsive behavior.
category: commerce
risk: medium
targets: codex, opencode, claude, auggie
related: wordpress-woocommerce, frontend-design, screenshot-review, browser-qa, accessibility-review
---

# WooCommerce PDP Review

## Purpose

- Review or improve WooCommerce product detail pages safely.
- Preserve purchase behavior while improving structure, clarity, and visual quality.
- Pair with wordpress-woocommerce and frontend-design.

## Process

1. Inspect current PDP templates, hooks, SCSS, JS, and WooCommerce overrides before proposing changes.
2. Identify product types in scope: simple, variable, out-of-stock, sale, review-enabled, or custom selector flows.
3. Map key areas: gallery, title/meta, price, stock, variation selector, add-to-cart, product info, tabs, reviews, related products.
4. Separate markup problems from styling problems.
5. Prefer hooks/templates for structural fixes and SCSS for visual tuning.
6. Propose bounded slices with exact files and verification routes.

## Verification

- Simple product.
- Variable product.
- Out-of-stock product.
- Add-to-cart behavior.
- Variation price/stock sync.
- Gallery behavior.
- Reviews/tabs.
- Mobile, tablet, and desktop widths.

## Output

- PDP areas inspected.
- Risk points.
- Proposed slices.
- Files likely involved.
- Verification plan.
- Remaining risk.

## Guardrails

- Do not break purchasability for visual changes.
- Do not bypass WooCommerce variation logic.
- Do not touch checkout/cart behavior unless explicitly in scope.
- Do not claim PDP verification unless routes were checked.
