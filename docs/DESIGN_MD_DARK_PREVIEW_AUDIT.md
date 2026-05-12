# Design MD Dark Preview Audit

Local catalog audit count: 71 entries.

## Summary

- `sectionalSourceDark`: 10
- `fullSourceDark`: 4
- `conservativeDerivedDark`: 4
- `darkTokenBoard`: 53

Apple is now classified as `sectionalSourceDark` with source-backed tile surfaces:

- primary: `surface-tile-1`
- secondary: `surface-tile-2`
- tertiary: `surface-tile-3`
- black surface kept separate: `surface-black`
- link/accent on dark: `primary-on-dark`

## What Changed

- Dark surface ranking now prefers semantic section/tile surfaces over black/nav voids.
- Black and nav surfaces stay separate instead of being promoted to the main section surface.
- Sectional dark previews render multiple source-backed dark surfaces instead of flattening to one generic dark wrapper.
- `fullSourceDark` remains strict and requires explicit global dark canvas evidence.

## Remaining Mismatch Classes

- Many entries still land in `darkTokenBoard` because the local source lacks explicit on-dark text or enough sectional dark evidence.
- `Spotify` remains a notable mismatch risk: dark surfaces exist, but on-dark text is missing in the source model.
- `Airbnb`, `BMW M`, `Bugatti`, `ClickHouse`, `Cohere`, `Composio`, `Miro`, `Mistral`, `Notion`, `Raycast`, and similar entries still need manual QA because they expose dark intent without a strong source-backed sectional model.

## Notes

- The audit is local and deterministic.
- It does not mutate the catalog.
- It intentionally treats missing dark evidence conservatively rather than inventing a dark theme.
