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

if ! xcrun --find swift >/dev/null 2>&1; then
  printf 'FAIL: swift is required to render the macOS app icon\n' >&2
  exit 1
fi

renderer="scripts/render-macos-pyramid-icons.swift"
output_icon="src-tauri/macos/AgentWorkspace.icns"

if [ ! -f "$renderer" ]; then
  printf 'FAIL: missing macOS app icon renderer: %s\n' "$renderer" >&2
  exit 1
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/agent-workspace-icon.XXXXXX")"
rendered_dir="$work_dir/rendered"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

swift_bin="$(xcrun --find swift)"
swift_cache_dir="${CLANG_MODULE_CACHE_PATH:-$work_dir/clang-module-cache}"
mkdir -p "$swift_cache_dir" "$rendered_dir" "$(dirname "$output_icon")"
CLANG_MODULE_CACHE_PATH="$swift_cache_dir" "$swift_bin" "$renderer" "$rendered_dir"

python3 - "$rendered_dir" "$output_icon" <<'PY'
from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

rendered_dir = Path(sys.argv[1])
out_path = Path(sys.argv[2])

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
SLOTS = [(128, b"ic07"), (256, b"ic08"), (512, b"ic09"), (1024, b"ic10")]


def read_png(path: Path, expected_size: int) -> bytes:
    data = path.read_bytes()
    if not data.startswith(PNG_MAGIC):
        raise SystemExit(f"FAIL: {path} is not a PNG file")
    if data[12:16] != b"IHDR":
        raise SystemExit(f"FAIL: {path} is missing PNG IHDR")
    width, height = struct.unpack(">II", data[16:24])
    if width != expected_size or height != expected_size:
        raise SystemExit(f"FAIL: {path} must be {expected_size}x{expected_size}, got {width}x{height}")
    return data


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
    if color_type != 6:
        return True
    row_len = width * 4
    try:
        raw = zlib.decompress(bytes(compressed))
    except Exception:
        return True
    stride = row_len + 1
    if len(raw) < stride * height:
        return True
    for y in range(height):
        row = raw[y * stride + 1:y * stride + 1 + row_len]
        for index in range(0, len(row), 4):
            if row[index + 3] and row[index:index + 3] != b"\x00\x00\x00":
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


def records_for(mode: str) -> list[tuple[bytes, bytes]]:
    records = []
    for size, kind in SLOTS:
        png = read_png(rendered_dir / f"{mode}-{size}.png", size)
        if not png_has_visible_pixels(png):
            raise SystemExit(f"FAIL: rendered {mode}-{size}.png appears to have no visible pixels")
        records.append((kind, png))
    return records


light_records = records_for("light")
dark_records = records_for("dark")
dark_icns = make_icns(dark_records)
combined = make_icns([*light_records, (b"dark", dark_icns[8:])])
out_path.write_bytes(combined)

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
for _, kind in SLOTS:
    if kind not in record_types:
        raise SystemExit(f"FAIL: generated icon is missing {kind.decode('latin1')} slot")
if b"dark" not in record_types:
    raise SystemExit("FAIL: generated icon does not contain a nested dark ICNS record")
print("generated vector pyramid nested dark macOS icon")
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
