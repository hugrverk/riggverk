import CoreGraphics
import Foundation
import ImageIO

// Renders the Riggverk app icon (dark squircle tile, light rune) at every size the macOS icns needs.
// Single source of truth: assets/icon-source.svg (1024 viewBox; first path is the tile, second the rune,
// both M/L/Z polylines; the rune sits in a translate/scale group). Output: light-<size>.png and
// dark-<size>.png; both modes use the same approved art.

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
  exit(1)
}

let args = CommandLine.arguments
if args.count != 3 {
  fail("usage: render-macos-rune-icons.swift <icon-source.svg> <output-dir>")
}

guard let svg = try? String(contentsOfFile: args[1], encoding: .utf8) else {
  fail("cannot read \(args[1])")
}
let outputDir = URL(fileURLWithPath: args[2], isDirectory: true)
try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

func matches(_ pattern: String, in text: String) -> [[String]] {
  guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
  let range = NSRange(text.startIndex..., in: text)
  return regex.matches(in: text, range: range).map { match in
    (1..<match.numberOfRanges).map { Range(match.range(at: $0), in: text).map { String(text[$0]) } ?? "" }
  }
}

func color(_ hex: String) -> CGColor {
  let v = UInt32(hex.dropFirst(), radix: 16) ?? 0
  return CGColor(
    red: CGFloat((v >> 16) & 0xff) / 255,
    green: CGFloat((v >> 8) & 0xff) / 255,
    blue: CGFloat(v & 0xff) / 255,
    alpha: 1
  )
}

struct Shape {
  let fill: CGColor
  let subpaths: [[CGPoint]]
}

func parseShape(fill: String, d: String) -> Shape {
  var subpaths: [[CGPoint]] = []
  var current: [CGPoint] = []
  for token in matches("([MLZ])\\s*([-\\d.]+)?\\s*([-\\d.]+)?", in: d) {
    switch token[0] {
    case "M":
      if !current.isEmpty { subpaths.append(current) }
      current = []
      fallthrough
    case "L":
      guard let x = Double(token[1]), let y = Double(token[2]) else { fail("bad path coordinate") }
      current.append(CGPoint(x: x, y: y))
    default:
      if !current.isEmpty { subpaths.append(current) }
      current = []
    }
  }
  if !current.isEmpty { subpaths.append(current) }
  return Shape(fill: color(fill), subpaths: subpaths)
}

let shapes = matches("<path fill=\"(#[0-9a-fA-F]{6})\" d=\"([^\"]+)\"", in: svg)
if shapes.count != 2 { fail("expected a tile path and a rune path in \(args[1])") }
let tile = parseShape(fill: shapes[0][0], d: shapes[0][1])
let rune = parseShape(fill: shapes[1][0], d: shapes[1][1])
guard let t = matches("translate\\(([\\d.]+) ([\\d.]+)\\) scale\\(([\\d.]+)\\)", in: svg).first,
  let tx = Double(t[0]), let ty = Double(t[1]), let ts = Double(t[2])
else { fail("missing rune transform in \(args[1])") }

func fill(_ ctx: CGContext, _ shape: Shape) {
  ctx.beginPath()
  for points in shape.subpaths {
    ctx.move(to: points[0])
    for point in points.dropFirst() { ctx.addLine(to: point) }
    ctx.closePath()
  }
  ctx.setFillColor(shape.fill)
  ctx.fillPath(using: .winding)
}

func render(size: Int, target: URL) {
  let s = CGFloat(size)
  guard let ctx = CGContext(
    data: nil,
    width: size,
    height: size,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else { fail("could not create CGContext") }

  ctx.clear(CGRect(x: 0, y: 0, width: s, height: s))
  ctx.setAllowsAntialiasing(true)
  ctx.setShouldAntialias(true)
  // SVG coordinates: top-left origin, 1024 units.
  ctx.translateBy(x: 0, y: s)
  ctx.scaleBy(x: s / 1024, y: -s / 1024)
  fill(ctx, tile)
  ctx.saveGState()
  ctx.translateBy(x: CGFloat(tx), y: CGFloat(ty))
  ctx.scaleBy(x: CGFloat(ts), y: CGFloat(ts))
  fill(ctx, rune)
  ctx.restoreGState()

  guard let image = ctx.makeImage(),
    let destination = CGImageDestinationCreateWithURL(target as CFURL, "public.png" as CFString, 1, nil)
  else { fail("could not create output image") }
  CGImageDestinationAddImage(destination, image, nil)
  if !CGImageDestinationFinalize(destination) { fail("could not write PNG") }
}

for mode in ["light", "dark"] {
  for size in [16, 32, 64, 128, 256, 512, 1024] {
    render(size: size, target: outputDir.appendingPathComponent("\(mode)-\(size).png"))
  }
}
