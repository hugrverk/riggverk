---
version: alpha
name: Wise Inspired
description: An inspired interpretation of Wise's design language - a global money-transfer brand whose surface combines a heavy display sans with a vivid lime-green accent, sage-tinted surface neutrals, and rounded white cards on a pale green-tinted canvas.

colors:
  primary: "#9fe870"
  on-primary: "#0e0f0c"
  primary-pale: "#e2f6d5"
  ink: "#0e0f0c"
  ink-deep: "#163300"
  body: "#454745"
  mute: "#868685"
  canvas: "#ffffff"
  canvas-soft: "#e8ebe6"
  positive: "#2ead4b"
  positive-deep: "#054d28"
  warning: "#ffd11a"
  warning-deep: "#b86700"
  negative-bg: "#320707"
  accent-orange: "#ffc091"

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
  card-feature-sage:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
  card-feature-dark:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.primary}"
  hero-band-dark:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.primary}"

---
## Overview
Pale green-tinted canvas, rounded cards, and occasional dark feature bands. The navy/black tokens are confined to local components, not a global dark theme.
