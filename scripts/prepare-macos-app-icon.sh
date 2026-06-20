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

if ! command -v xcrun >/dev/null 2>&1; then
  printf 'FAIL: xcrun is required to compile the macOS app icon asset catalog\n' >&2
  exit 1
fi

if ! xcrun --find swift >/dev/null 2>&1; then
  printf 'FAIL: swift is required to render macOS app icon assets\n' >&2
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
    printf 'FAIL: missing macOS app icon input: %s\n' "$source" >&2
    exit 1
  fi
done

resize_swift="$(mktemp "${TMPDIR:-/tmp}/agent-workspace-resize-icons.XXXXXX.swift")"
cleanup_resize_swift() {
  rm -f "$resize_swift"
}
trap cleanup_resize_swift EXIT

cat >"$resize_swift" <<'SWIFT'
import AppKit
import Foundation

struct RenderError: Error, CustomStringConvertible {
  let description: String
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
  exit(1)
}

let args = CommandLine.arguments
if args.count != 4 {
  fail("usage: resize <light-source.png> <dark-source.png> <appicon-dir>")
}

let lightSource = URL(fileURLWithPath: args[1])
let darkSource = URL(fileURLWithPath: args[2])
let appIconDir = URL(fileURLWithPath: args[3], isDirectory: true)
let fileManager = FileManager.default

for url in [lightSource, darkSource] {
  if !fileManager.fileExists(atPath: url.path) {
    fail("missing source icon: \(url.path)")
  }
}

try fileManager.createDirectory(at: appIconDir, withIntermediateDirectories: true)

func loadImage(_ url: URL) throws -> NSImage {
  guard let image = NSImage(contentsOf: url), image.isValid else {
    throw RenderError(description: "could not read source icon: \(url.path)")
  }
  return image
}

func render(source: NSImage, target: URL, pixels: Int) throws {
  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: pixels,
    pixelsHigh: pixels,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else {
    throw RenderError(description: "could not create bitmap for \(target.path)")
  }

  let rect = NSRect(origin: .zero, size: NSSize(width: pixels, height: pixels))
  NSGraphicsContext.saveGraphicsState()
  if let context = NSGraphicsContext(bitmapImageRep: bitmap) {
    context.imageInterpolation = .high
    NSGraphicsContext.current = context
    NSColor.clear.setFill()
    rect.fill()
    source.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1.0)
  }
  NSGraphicsContext.restoreGraphicsState()

  guard let data = bitmap.representation(using: .png, properties: [:]) else {
    throw RenderError(description: "could not encode png for \(target.path)")
  }
  try data.write(to: target, options: .atomic)
}

do {
  let sources = [
    ("light", try loadImage(lightSource)),
    ("dark", try loadImage(darkSource)),
  ]
  for source in sources {
    for points in [16, 32, 128, 256, 512] {
      let oneX = appIconDir.appendingPathComponent("appicon-\(source.0)-\(points)x\(points).png")
      let twoX = appIconDir.appendingPathComponent("appicon-\(source.0)-\(points)x\(points)@2x.png")
      try render(source: source.1, target: oneX, pixels: points)
      try render(source: source.1, target: twoX, pixels: points * 2)
    }
  }
} catch {
  fail(String(describing: error))
}
SWIFT

swift_bin="$(xcrun --find swift)"
"$swift_bin" "$resize_swift" "$light_source" "$dark_source" "$appicon_dir"

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
