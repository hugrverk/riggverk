---
name: kretsverket-symbol-system
description: Protects Kretsverket Symbol Editor behavior, covering sandbox editing, definitions versus placed instances, imports, nested symbols, anchors, and connection points. Use when Kretsverket work touches symbols, the Symbol Editor, or .kretsym imports.
category: kretsverket
risk: high
targets: codex, opencode, claude, cursor
related: kretsverket-editor-change, kretsverket-file-compatibility, browser-qa, minimal-implementation
---

# Kretsverket Symbol System

Use for Symbol Editor sandbox behavior, definitions, instances, imports, nested symbols, anchors, connection points, and placed-instance updates.

Done when: the change is classified on all six axes, `npm run test` and `npm run build` pass, and a browser smoke covers the Symbol Editor flow touched.

## Classification

Every change must classify:

**Ownership:** built-in, project-local, imported

**State:** sandbox, stored definition, placed instance

**Coordinate space:** definition-local, instance transform, sheet model

**Persistence:** .krets, .kretsym, transient

**Rendering:** editor, sheet, preview, print

**Mutation:** create, copy, replace, update, reject

## Invariants

- Built-in symbols are read-only.
- Editing a built-in creates a project-local copy.
- Sandbox edits do not mutate stored definitions before save or update.
- Cancel and revert restore the baseline.
- Symbol Editor history remains separate from sheet history.
- Placed instances retain instance-owned position, rotation, scale, metadata, and text overrides.
- Nested symbols validate missing references, cycles, and excessive depth.
- Anchors and connection points are metadata, not ordinary printed geometry.
- .kretsym is untrusted input.
- Import conflicts require explicit copy, replace, or reject behavior.
- Future shared library ownership must not be invented.

## Output

- Classification on ownership, state, coordinate space, persistence, rendering, and mutation.
- Invariants checked.
- Commands and browser smoke run, with results.
- Not verified and residual risk.
