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
  printf 'Skipping macOS app icon generation for platform: %s\n' "$platform"
  exit 0
fi

if ! command -v xcrun >/dev/null 2>&1; then
  printf 'FAIL: xcrun is required to generate the macOS app icon\n' >&2
  exit 1
fi

if ! command -v iconutil >/dev/null 2>&1; then
  printf 'FAIL: iconutil is required to generate the macOS app icon\n' >&2
  exit 1
fi

if ! xcrun --find swift >/dev/null 2>&1; then
  printf 'FAIL: swift is required to render macOS app icon assets\n' >&2
  exit 1
fi

appicon_dir="src-tauri/macos/Assets.xcassets/AppIcon.appiconset"
light_source="src-tauri/macos/app-icon-light.png"
dark_source="src-tauri/macos/app-icon-dark.png"
output_icon="src-tauri/macos/AgentWorkspace.icns"

for source in "$light_source" "$dark_source"; do
  if [ ! -f "$source" ]; then
    printf 'FAIL: missing macOS app icon input: %s\n' "$source" >&2
    exit 1
  fi
done

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/agent-workspace-icon.XXXXXX")"
resize_swift="$work_dir/resize-icons.swift"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

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

do {
  try fileManager.createDirectory(at: appIconDir, withIntermediateDirectories: true)
} catch {
  fail("could not create app icon directory: \(error)")
}

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
swift_cache_dir="${CLANG_MODULE_CACHE_PATH:-$work_dir/clang-module-cache}"
mkdir -p "$swift_cache_dir"
CLANG_MODULE_CACHE_PATH="$swift_cache_dir" "$swift_bin" "$resize_swift" "$light_source" "$dark_source" "$appicon_dir"

make_iconset() {
  local variant="$1"
  local iconset_dir="$work_dir/${variant}.iconset"
  mkdir -p "$iconset_dir"

  for points in 16 32 128 256 512; do
    cp "$appicon_dir/appicon-${variant}-${points}x${points}.png" "$iconset_dir/icon_${points}x${points}.png"
    cp "$appicon_dir/appicon-${variant}-${points}x${points}@2x.png" "$iconset_dir/icon_${points}x${points}@2x.png"
  done

  iconutil -c icns -o "$work_dir/${variant}.icns" "$iconset_dir"
}

make_iconset light
make_iconset dark

python3 - "$work_dir/light.icns" "$work_dir/dark.icns" "$output_icon" <<'PY'
from __future__ import annotations

import struct
import sys
from pathlib import Path

light_path = Path(sys.argv[1])
dark_path = Path(sys.argv[2])
out_path = Path(sys.argv[3])


def read_icns(path: Path) -> bytes:
    data = path.read_bytes()
    if data[:4] != b"icns":
        raise SystemExit(f"FAIL: {path} is not an icns file")
    expected = struct.unpack(">I", data[4:8])[0]
    if expected != len(data):
        raise SystemExit(f"FAIL: {path} has invalid icns length {expected} != {len(data)}")
    return data


def records(data: bytes) -> list[tuple[bytes, bytes]]:
    offset = 8
    parsed: list[tuple[bytes, bytes]] = []
    while offset < len(data):
        kind = data[offset : offset + 4]
        length = struct.unpack(">I", data[offset + 4 : offset + 8])[0]
        if length < 8 or offset + length > len(data):
            raise SystemExit(f"FAIL: invalid icns record {kind!r} length {length}")
        payload = data[offset + 8 : offset + length]
        parsed.append((kind, payload))
        offset += length
    return parsed


def write_icns(path: Path, parsed: list[tuple[bytes, bytes]]) -> None:
    toc_payload = b"".join(kind + struct.pack(">I", len(payload) + 8) for kind, payload in parsed)
    all_records = [(b"TOC ", toc_payload), *parsed]
    total = 8 + sum(len(payload) + 8 for _, payload in all_records)
    out = bytearray(b"icns" + struct.pack(">I", total))
    for kind, payload in all_records:
        out += kind + struct.pack(">I", len(payload) + 8) + payload
    path.write_bytes(bytes(out))


light = read_icns(light_path)
dark = read_icns(dark_path)
base_records = [(kind, payload) for kind, payload in records(light) if kind != b"TOC "]
base_records.append((b"dark", dark[8:]))
write_icns(out_path, base_records)

combined = read_icns(out_path)
record_types = [kind for kind, _ in records(combined)]
if b"dark" not in record_types:
    raise SystemExit("FAIL: generated icon does not contain nested dark icns record")
print("generated nested dark macOS icon")
PY

if [ ! -s "$output_icon" ]; then
  printf 'FAIL: missing generated macOS app icon: %s\n' "$output_icon" >&2
  exit 1
fi

if ! python3 - "$output_icon" <<'PY'
import struct
import sys
from pathlib import Path

data = Path(sys.argv[1]).read_bytes()
if data[:4] != b"icns":
    raise SystemExit(1)
offset = 8
found = False
while offset < len(data):
    kind = data[offset:offset + 4]
    length = struct.unpack(">I", data[offset + 4:offset + 8])[0]
    found = found or kind == b"dark"
    offset += length
raise SystemExit(0 if found else 1)
PY
then
  printf 'FAIL: generated macOS app icon does not contain a nested dark record\n' >&2
  exit 1
fi

if ! /usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' src-tauri/Info.plist | grep -Fxq 'AgentWorkspace'; then
  printf 'FAIL: src-tauri/Info.plist must set CFBundleIconFile to AgentWorkspace\n' >&2
  exit 1
fi

if ! /usr/libexec/PlistBuddy -c 'Print :CFBundleIconName' src-tauri/Info.plist | grep -Fxq 'AgentWorkspace'; then
  printf 'FAIL: src-tauri/Info.plist must set CFBundleIconName to AgentWorkspace\n' >&2
  exit 1
fi

printf 'macOS nested dark app icon prepared\n'
