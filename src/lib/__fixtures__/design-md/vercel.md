---
version: alpha
name: Vercel Inspired
description: An inspired interpretation of Vercel's design language - a developer-platform brand whose surface is a stark black-and-ink duet on near-white canvas, broken by a multi-color mesh gradient that acts as the decorative system.

colors:
  primary: "#171717"
  on-primary: "#ffffff"
  ink: "#171717"
  body: "#4d4d4d"
  mute: "#888888"
  hairline: "#ebebeb"
  canvas: "#ffffff"
  canvas-soft: "#fafafa"
  canvas-soft-2: "#f5f5f5"
  selection-bg: "#171717"
  selection-fg: "#f2f2f2"
  gradient-develop-start: "#007cf0"
  gradient-develop-end: "#00dfd8"
  gradient-preview-start: "#7928ca"
  gradient-preview-end: "#ff0080"
  gradient-ship-start: "#ff4d4d"
  gradient-ship-end: "#f9cb28"

components:
  nav-bar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
  card-marketing:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
  tab-ghost:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"

---
## Overview
Near-white canvas with black-and-ink system colors, selection contrast, and mesh gradients. The black token is scoped to selection and chrome, not a global dark theme.
