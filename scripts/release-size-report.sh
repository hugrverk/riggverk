#!/usr/bin/env bash
# Release size report — prints raw and gzipped sizes for dist, default workspace, and Tauri bundles.
# Safe to run at any time. Does not fail on missing artifacts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Agent Workspace Size Report ==="
echo "Date: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "Commit: $(cd "$ROOT_DIR" && git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
echo ""

# --- Frontend dist ---
echo "--- dist (frontend) ---"
if [ -d "$ROOT_DIR/dist" ]; then
  echo "raw: $(du -sh "$ROOT_DIR/dist" | cut -f1)"
  for f in "$ROOT_DIR"/dist/assets/*.js; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    raw=$(wc -c < "$f" | tr -d ' ')
    gz=$(gzip -ck "$f" | wc -c | tr -d ' ')
    printf "  %s  raw=%s  gzip=%s\n" "$base" "$raw" "$gz"
  done
  for f in "$ROOT_DIR"/dist/assets/*.css; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    raw=$(wc -c < "$f" | tr -d ' ')
    gz=$(gzip -ck "$f" | wc -c | tr -d ' ')
    printf "  %s  raw=%s  gzip=%s\n" "$base" "$raw" "$gz"
  done
else
  echo "  (dist not found — run npm run build)"
fi
echo ""

# --- Default workspace ---
echo "--- default workspace ---"
if [ -d "$ROOT_DIR/resources/default-workspace" ]; then
  echo "total: $(du -sh "$ROOT_DIR/resources/default-workspace" | cut -f1)"
  for dir in skills docs scripts templates agents metadata; do
    [ -d "$ROOT_DIR/resources/default-workspace/$dir" ] || continue
    echo "  $dir: $(du -sh "$ROOT_DIR/resources/default-workspace/$dir" | cut -f1)"
  done
else
  echo "  (default-workspace not found)"
fi
echo ""

# --- Tauri bundles ---
echo "--- Tauri bundles ---"
BUNDLE_DIR="$ROOT_DIR/src-tauri/target/release/bundle"
if [ -d "$BUNDLE_DIR" ]; then
  echo "bundle total: $(du -sh "$BUNDLE_DIR" | cut -f1)"
  for f in "$BUNDLE_DIR"/dmg/*.dmg; do
    [ -f "$f" ] || continue
    echo "  dmg: $(basename "$f")  $(du -sh "$f" | cut -f1)"
  done
  for d in "$BUNDLE_DIR"/macos/*.app; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    echo "  app: $name  $(du -sh "$d" | cut -f1)"
    exe=$(find "$d/Contents/MacOS" -type f -executable 2>/dev/null | head -1)
    if [ -n "$exe" ]; then
      echo "    executable: $(basename "$exe")  $(du -sh "$exe" | cut -f1)"
    fi
  done
else
  echo "  (bundle not found — run npm run tauri build)"
fi
echo ""

# --- Top 10 largest dist files ---
echo "--- Top 10 largest dist files ---"
if [ -d "$ROOT_DIR/dist" ]; then
  find "$ROOT_DIR/dist" -type f -exec ls -lh {} \; 2>/dev/null | sort -k5 -hr | head -10 | while read -r line; do
    echo "  $line"
  done
else
  echo "  (dist not found)"
fi
