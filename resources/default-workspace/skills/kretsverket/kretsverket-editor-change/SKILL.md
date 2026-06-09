---
name: kretsverket-editor-change
description: Guide changes that cross Kretsverket editor layers with explicit impact checks across types, state, canvas, keyboard, selection, rendering, undo, persistence, and export.
category: kretsverket
risk: high
targets: codex, opencode, claude, cursor
related: diagnose, tdd, implementation-plan, browser-qa, minimal-implementation
---

# Kretsverket Editor Change

Use when a change crosses Kretsverket editor layers.

## Impact matrix

Every change must consider:

- Types
- Durable state
- Canvas interactions
- Keyboard
- Selection and grouping
- Canvas rendering
- Symbol Editor parity
- Undo and redo
- Sheet duplicate and move
- Persistence
- Print and export
- Inspector and UI
- Focused automated checks
- Browser smoke

## Invariants

- LineObject, Wire, and DimensionArrowObject remain separate domain objects.
- Model, screen, print, and symbol-local coordinate systems are not mixed.
- Group operations include every affected object ID collection.
- Build alone does not prove canvas behavior.
- Do not introduce implicit electrical inference.
- Do not create parallel state or rendering paths.
- Read Kretsverket AGENTS.md, current package.json, relevant docs, and owner files before editing.
- Use focused guards plus semantic or browser verification where behavior is executable.
