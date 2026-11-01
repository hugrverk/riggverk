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
  printf 'FAIL: swift is required to render the macOS app icon\n' >&2
  exit 1
fi

renderer="scripts/render-macos-rune-icons.swift"
icon_source="assets/icon-source.svg"
output_icon="src-tauri/macos/Riggverk.icns"

if [ ! -f "$renderer" ]; then
  printf 'FAIL: missing macOS app icon renderer: %s\n' "$renderer" >&2
  exit 1
fi

if [ ! -f "$icon_source" ]; then
  printf 'FAIL: missing macOS app icon source: %s\n' "$icon_source" >&2
  exit 1
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/riggverk-icon.XXXXXX")"
rendered_dir="$work_dir/rendered"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

swift_bin="$(xcrun --find swift)"
swift_cache_dir="${CLANG_MODULE_CACHE_PATH:-$work_dir/clang-module-cache}"
mkdir -p "$swift_cache_dir" "$rendered_dir" "$(dirname "$output_icon")"
CLANG_MODULE_CACHE_PATH="$swift_cache_dir" "$swift_bin" "$renderer" "$icon_source" "$rendered_dir"

make_iconset() {
  local mode="$1"
  local iconset_dir="$work_dir/${mode}.iconset"
  mkdir -p "$iconset_dir"

  cp "$rendered_dir/${mode}-16.png" "$iconset_dir/icon_16x16.png"
  cp "$rendered_dir/${mode}-32.png" "$iconset_dir/icon_16x16@2x.png"
  cp "$rendered_dir/${mode}-32.png" "$iconset_dir/icon_32x32.png"
  cp "$rendered_dir/${mode}-64.png" "$iconset_dir/icon_32x32@2x.png"
  cp "$rendered_dir/${mode}-128.png" "$iconset_dir/icon_128x128.png"
  cp "$rendered_dir/${mode}-256.png" "$iconset_dir/icon_128x128@2x.png"
  cp "$rendered_dir/${mode}-256.png" "$iconset_dir/icon_256x256.png"
  cp "$rendered_dir/${mode}-512.png" "$iconset_dir/icon_256x256@2x.png"
  cp "$rendered_dir/${mode}-512.png" "$iconset_dir/icon_512x512.png"
  cp "$rendered_dir/${mode}-1024.png" "$iconset_dir/icon_512x512@2x.png"

  iconutil -c icns -o "$work_dir/${mode}.icns" "$iconset_dir"
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
        kind = data[offset:offset + 4]
        length = struct.unpack(">I", data[offset + 4:offset + 8])[0]
        if length < 8 or offset + length > len(data):
            raise SystemExit(f"FAIL: invalid icns record {kind!r} length {length}")
        payload = data[offset + 8:offset + length]
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
for required in (b"ic07", b"ic08", b"ic09", b"ic10"):
    if required not in record_types:
        raise SystemExit(f"FAIL: generated icon is missing {required.decode('latin1')} slot")
print("generated iconutil rune nested dark macOS icon")
PY

if [ ! -s "$output_icon" ]; then
  printf 'FAIL: missing generated macOS app icon: %s\n' "$output_icon" >&2
  exit 1
fi

# The disk image art (bundle.macOS.dmg in tauri.macos.conf.json and the volume icon release.sh puts on the
# disk image): a 660x400 background with its @2x in one HiDPI TIFF, and the volume icon as an icns.
dmg_dir="src-tauri/macos/dmg"
mkdir -p "$dmg_dir" "$work_dir/volume.iconset"
for size in 16 32 128 256 512; do
  cp "$rendered_dir/volume-${size}.png" "$work_dir/volume.iconset/icon_${size}x${size}.png"
  cp "$rendered_dir/volume-$((size * 2)).png" "$work_dir/volume.iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns -o "$dmg_dir/VolumeIcon.icns" "$work_dir/volume.iconset"
tiffutil -cathidpicheck "$rendered_dir/dmg-background.png" "$rendered_dir/dmg-background@2x.png" \
  -out "$dmg_dir/background.tiff" >/dev/null
python3 - "$dmg_dir" src-tauri/tauri.macos.conf.json <<'PY'
import json
import subprocess
import sys
from pathlib import Path

dmg_dir, conf = Path(sys.argv[1]), Path(sys.argv[2])
dmg = json.loads(conf.read_text(encoding="utf-8"))["bundle"]["macOS"]["dmg"]
if Path("src-tauri", dmg["background"]) != dmg_dir / "background.tiff":
    raise SystemExit(f"FAIL: {conf} must take the disk image background from {dmg_dir}/background.tiff")
if dmg["windowSize"] != {"width": 660, "height": 400}:
    raise SystemExit(f"FAIL: {conf} must size the disk image window 660x400, as the background is drawn")
if dmg["appPosition"] != {"x": 180, "y": 170} or dmg["applicationFolderPosition"] != {"x": 480, "y": 170}:
    raise SystemExit(f"FAIL: {conf} must place the icons at (180,170) and (480,170), where the arrow points")
info = subprocess.run(["tiffutil", "-info", str(dmg_dir / "background.tiff")], capture_output=True, text=True).stdout
for size in ("660 x 400", "1320 x 800"):
    if size not in info.replace("Image Width: ", "").replace(" Image Length: ", " x "):
        raise SystemExit(f"FAIL: background.tiff has no {size} image")
PY

if ! /usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' src-tauri/Info.plist | grep -Fxq 'Riggverk'; then
  printf 'FAIL: src-tauri/Info.plist must set CFBundleIconFile to Riggverk\n' >&2
  exit 1
fi

# macOS 26+ reads the appearance-aware icon (light, dark, tinted) from Assets.car, which the Tauri bundler compiles
# with actool from the Icon Composer document listed in bundle.icon and names in CFBundleIconName itself. A
# CFBundleIconName in our Info.plist would override that name and hide the catalog icon; Riggverk.icns above stays the
# CFBundleIconFile fallback for older macOS.
if /usr/libexec/PlistBuddy -c 'Print :CFBundleIconName' src-tauri/Info.plist >/dev/null 2>&1; then
  printf 'FAIL: src-tauri/Info.plist must not set CFBundleIconName; the bundler sets it for Assets.car\n' >&2
  exit 1
fi

icon_document="src-tauri/macos/Riggverk.icon"
python3 - "$icon_source" "$icon_document/Assets/rune.svg" "$icon_document/icon.json" <<'PY'
import json
import re
import sys

source, rune, manifest = (open(path, encoding="utf-8").read() for path in sys.argv[1:4])
pattern = r'<g transform="[^"]+"><path fill="#[0-9a-fA-F]{6}" d="[^"]+"/></g>'
expected = re.search(pattern, source)
actual = re.search(pattern, rune)
if not expected or not actual or expected.group(0) != actual.group(0):
    raise SystemExit("FAIL: Riggverk.icon/Assets/rune.svg must carry the rune group of assets/icon-source.svg unchanged")
appearances = [spec.get("appearance") for spec in json.loads(manifest).get("fill-specializations", [])]
if None not in appearances or "dark" not in appearances:
    raise SystemExit("FAIL: Riggverk.icon/icon.json must specialise the tile fill for the default and dark appearances")
PY

printf 'macOS app icon prepared (icns fallback, Icon Composer document checked), disk image art rendered\n'
