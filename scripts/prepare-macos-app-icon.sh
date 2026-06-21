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

light_source="src-tauri/macos/app-icon-light.png"
dark_source="src-tauri/macos/app-icon-dark.png"
output_icon="src-tauri/macos/AgentWorkspace.icns"

for source in "$light_source" "$dark_source"; do
  if [ ! -f "$source" ]; then
    printf 'FAIL: missing macOS app icon input: %s\n' "$source" >&2
    exit 1
  fi
done

python3 - "$light_source" "$dark_source" "$output_icon" <<'PY'
from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

light_path = Path(sys.argv[1])
dark_path = Path(sys.argv[2])
out_path = Path(sys.argv[3])

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
DISPLAY_SLOT_KINDS = [b"ic07", b"ic08", b"ic09", b"ic10"]


def read_png(path: Path) -> tuple[bytes, int, int]:
    data = path.read_bytes()
    if not data.startswith(PNG_MAGIC):
        raise SystemExit(f"FAIL: {path} is not a PNG file")
    if data[12:16] != b"IHDR":
        raise SystemExit(f"FAIL: {path} is missing PNG IHDR")
    width, height = struct.unpack(">II", data[16:24])
    if width != height:
        raise SystemExit(f"FAIL: {path} must be square, got {width}x{height}")
    return data, width, height


def png_has_visible_pixels(data: bytes) -> bool:
    offset = 8
    width = height = color_type = bit_depth = None
    compressed = bytearray()
    while offset < len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + length]
        offset += 12 + length
        if kind == b"IHDR":
            width, height = struct.unpack(">II", payload[:8])
            bit_depth = payload[8]
            color_type = payload[9]
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            break
    if width is None or height is None or color_type is None or bit_depth != 8:
        return True
    if color_type not in (2, 6):
        return True
    channels = 3 if color_type == 2 else 4
    row_len = width * channels
    try:
        raw = zlib.decompress(bytes(compressed))
    except Exception:
        return True
    stride = row_len + 1
    if len(raw) < stride * height:
        return True
    for y in range(height):
        row = raw[y * stride + 1:y * stride + 1 + row_len]
        if color_type == 6:
            for index in range(0, len(row), 4):
                if row[index + 3] and row[index:index + 3] != b"\x00\x00\x00":
                    return True
        else:
            if any(value for value in row):
                return True
    return False


def make_icns(records: list[tuple[bytes, bytes]]) -> bytes:
    toc_payload = b"".join(kind + struct.pack(">I", len(payload) + 8) for kind, payload in records)
    all_records = [(b"TOC ", toc_payload), *records]
    total = 8 + sum(len(payload) + 8 for _, payload in all_records)
    out = bytearray(b"icns" + struct.pack(">I", total))
    for kind, payload in all_records:
        out += kind + struct.pack(">I", len(payload) + 8) + payload
    return bytes(out)


light_png, light_w, _ = read_png(light_path)
dark_png, dark_w, _ = read_png(dark_path)
if not png_has_visible_pixels(light_png):
    raise SystemExit(f"FAIL: {light_path} appears to have no visible pixels")
if not png_has_visible_pixels(dark_png):
    raise SystemExit(f"FAIL: {dark_path} appears to have no visible pixels")

# Store the original source PNG in every modern PNG-backed display slot.
# The PNG payload itself carries its pixel dimensions; duplicating it across
# slots avoids Finder falling back to an empty rounded placeholder when only a
# 256px slot is present.
light_records = [(kind, light_png) for kind in DISPLAY_SLOT_KINDS]
dark_records = [(kind, dark_png) for kind in DISPLAY_SLOT_KINDS]
dark_icns = make_icns(dark_records)
combined = make_icns([*light_records, (b"dark", dark_icns[8:])])
out_path.write_bytes(combined)

# Re-read and verify the generated file structure.
data = out_path.read_bytes()
if data[:4] != b"icns":
    raise SystemExit("FAIL: generated icon is not an ICNS file")
if struct.unpack(">I", data[4:8])[0] != len(data):
    raise SystemExit("FAIL: generated icon has invalid ICNS length")
offset = 8
record_types: list[bytes] = []
while offset < len(data):
    kind = data[offset:offset + 4]
    length = struct.unpack(">I", data[offset + 4:offset + 8])[0]
    if length < 8 or offset + length > len(data):
        raise SystemExit(f"FAIL: invalid generated ICNS record {kind!r}")
    record_types.append(kind)
    offset += length
if b"dark" not in record_types:
    raise SystemExit("FAIL: generated icon does not contain a nested dark ICNS record")
if b"ic10" not in record_types:
    raise SystemExit("FAIL: generated icon does not contain a 1024 display slot")
print(f"generated nested dark macOS icon using {light_w}px source payloads")
PY

if [ ! -s "$output_icon" ]; then
  printf 'FAIL: missing generated macOS app icon: %s\n' "$output_icon" >&2
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
