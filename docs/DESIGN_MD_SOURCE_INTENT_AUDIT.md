# Design MD Source Intent Audit

Generated preview theming now treats prose as source data, not only token names.

## Baseline Findings

- Claude describes a warm, cream, editorial interface with dark product surfaces. The old resolver used neutral ink plus dark surface tokens too globally, making dark mode feel like a full dark product theme instead of a conservative readable alternate.
- Cursor explicitly says warm-cream editorial canvas, orange reserved for primary CTAs and wordmark, timeline colors only inside in-product visualizations, and not a typical dark IDE. The old resolver knew token roles but did not model that light-first intent.
- Markdown-only entries often expose colors without structured roles, so the first detected color can be misclassified as a brand/accent color.
- Some sources include surface-only dark tokens, inverse tokens, or black utility tokens. These need different handling from explicit dark canvas tokens.
- Semantic, state, timeline, and workflow colors are useful in the palette but should not set page mood.

## Current Audit Command

Run:

```sh
node scripts/audit-design-md-source-intent.mjs
```

The script reads the local cached Design MD catalog only. It performs no network calls and no mutation. It reuses the parser, source-intent model, and theme resolver by bundling a temporary local runner.

## Main Risk Classes

- Light-first source with overly black derived dark mode.
- Sparse or CTA-only accent used beyond a small action/accent footprint.
- Primary, semantic, state, or timeline color selected as canvas or surface.
- No explicit dark tokens, requiring derived dark mode.
- Prose contradiction: source says warm, soft, cream, editorial, or not dark, but selected theme looks harsh or saturated.

## Regression Targets

- Claude: warm/soft/editorial; dark fallback should not be overly black when no explicit dark canvas exists.
- Cursor: warm cream/ink in light mode; orange sparse; dark mode derived from neutral ink/canvas, not orange, timeline, or fake IDE black.
- Dark-native designs such as Binance, ClickHouse, The Verge, Warp, Spotify, and BMW M may use stronger dark canvases when source supports that mood.
