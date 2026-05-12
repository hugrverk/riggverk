---
version: alpha
name: Spotify
description: Spotify's web interface is a dark immersive music player that wraps listeners in a near-black cocoon where album art and content become the primary source of color.

colors:
  primary: "#1ed760"
  ink: "#ffffff"
  body: "#b3b3b3"
  canvas: "#121212"
  surface-dark: "#181818"
  surface-mid: "#1f1f1f"
  surface-card: "#252525"
  border-dark: "#4d4d4d"
  text-base: "#ffffff"
  text-muted: "#b3b3b3"
  announcement-blue: "#539df5"
  warning-orange: "#ffa42b"
  negative-red: "#f3727f"

components:
  dark-pill:
    backgroundColor: "{colors.surface-mid}"
    textColor: "{colors.text-base}"
  dark-large-pill:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.text-base}"
  card:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.text-base}"
  sidebar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text-muted}"

---
## Overview
Near-black immersive dark theme with compact pills, heavy shadows, and achromatic surfaces. Green stays functional only for play controls and CTAs.
