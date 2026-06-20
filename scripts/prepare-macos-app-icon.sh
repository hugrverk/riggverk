#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

platform="${TAURI_ENV_PLATFORM:-}"
if [ -z "$platform" ]; then
  case "$(uname -s)" in
    Darwin) platform="darwin" ;;
    *) platform="other" ;;
  esac
fi

if [ "$platform" != "darwin" ]; then
  printf 'Skipping macOS app icon asset catalog for platform: %s\n' "$platform"
  exit 0
fi

if ! command -v sips >/dev/null 2>&1; then
  printf 'FAIL: sips is required to resize macOS app icon assets\n' >&2
  exit 1
fi

if ! command -v xcrun >/dev/null 2>&1; then
  printf 'FAIL: xcrun is required to compile the macOS app icon asset catalog\n' >&2
  exit 1
fi

if ! xcrun --find actool >/dev/null 2>&1; then
  printf 'FAIL: actool is required to compile the macOS app icon asset catalog\n' >&2
  exit 1
fi

appicon_dir="src-tauri/macos/Assets.xcassets/AppIcon.appiconset"
light_source="src-tauri/macos/app-icon-light.png"
dark_source="src-tauri/macos/app-icon-dark.png"

for source in "$light_source" "$dark_source" "$appicon_dir/Contents.json"; do
  if [ ! -f "$source" ]; then
    printf 'FAIL: missing macOS app icon source: %s\n' "$source" >&2
    exit 1
  fi
done

render_icon() {
  local source="$1"
  local target="$2"
  local pixels="$3"

  sips -s format png -z "$pixels" "$pixels" "$source" --out "$target" >/dev/null
}

for points in 16 32 128 256 512; do
  render_icon "$light_source" "$appicon_dir/appicon-light-${points}x${points}.png" "$points"
  render_icon "$dark_source" "$appicon_dir/appicon-dark-${points}x${points}.png" "$points"

  retina_pixels=$((points * 2))
  render_icon "$light_source" "$appicon_dir/appicon-light-${points}x${points}@2x.png" "$retina_pixels"
  render_icon "$dark_source" "$appicon_dir/appicon-dark-${points}x${points}@2x.png" "$retina_pixels"
done

rm -f src-tauri/macos/Assets.car src-tauri/macos/assetcatalog_generated_info.plist

xcrun actool \
  --compile src-tauri/macos \
  --platform macosx \
  --minimum-deployment-target 10.14 \
  --app-icon AppIcon \
  --output-partial-info-plist src-tauri/macos/assetcatalog_generated_info.plist \
  src-tauri/macos/Assets.xcassets

if [ ! -f src-tauri/macos/Assets.car ]; then
  printf 'FAIL: actool did not produce src-tauri/macos/Assets.car\n' >&2
  exit 1
fi

if ! /usr/libexec/PlistBuddy -c 'Print :CFBundleIconName' src-tauri/Info.plist | grep -Fxq 'AppIcon'; then
  printf 'FAIL: src-tauri/Info.plist must set CFBundleIconName to AppIcon\n' >&2
  exit 1
fi

printf 'macOS app icon asset catalog prepared\n'
