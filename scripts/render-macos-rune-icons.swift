import CoreGraphics
import CoreText
import Foundation
import ImageIO

// Renders the Riggverk app icon (dark squircle tile, light rune) at every size the macOS icns needs,
// and the disk image art. Single source of truth: assets/icon-source.svg (1024 viewBox; first path is
// the tile, second the rune, both M/L/Z polylines; the rune sits in a translate/scale group).
// Output: light-<size>.png and dark-<size>.png (both modes use the same approved art);
// volume-<size>.png (the rune on a square graphite plate, for the disk image's volume icon); and
// dmg-background.png (660x400) with dmg-background@2x.png (1320x800): graphite, the rune and the
// wordmark top left, one thin silver arrow from the app (180,170) to Applications (480,170).

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

func makeContext(width: Int, height: Int, space: CGColorSpace = CGColorSpaceCreateDeviceRGB()) -> CGContext {
  guard let ctx = CGContext(
    data: nil,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: space,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else { fail("could not create CGContext") }
  ctx.clear(CGRect(x: 0, y: 0, width: width, height: height))
  ctx.setAllowsAntialiasing(true)
  ctx.setShouldAntialias(true)
  return ctx
}

func write(_ ctx: CGContext, to target: URL, dpi: Int = 72) {
  let properties = [kCGImagePropertyDPIWidth: dpi, kCGImagePropertyDPIHeight: dpi] as CFDictionary
  guard let image = ctx.makeImage(),
    let destination = CGImageDestinationCreateWithURL(target as CFURL, "public.png" as CFString, 1, nil)
  else { fail("could not create output image") }
  CGImageDestinationAddImage(destination, image, properties)
  if !CGImageDestinationFinalize(destination) { fail("could not write PNG") }
}

/// Draws the rune with its own 64-unit box scaled by `scale` and its top left corner at `origin`
/// (SVG coordinates: the context is already flipped to a top-left origin).
func drawRune(_ ctx: CGContext, origin: CGPoint, scale: CGFloat, fillColor: CGColor? = nil) {
  ctx.saveGState()
  ctx.translateBy(x: origin.x, y: origin.y)
  ctx.scaleBy(x: scale, y: scale)
  fill(ctx, fillColor.map { Shape(fill: $0, subpaths: rune.subpaths) } ?? rune)
  ctx.restoreGState()
}

func render(size: Int, target: URL) {
  let s = CGFloat(size)
  let ctx = makeContext(width: size, height: size)
  // SVG coordinates: top-left origin, 1024 units.
  ctx.translateBy(x: 0, y: s)
  ctx.scaleBy(x: s / 1024, y: -s / 1024)
  fill(ctx, tile)
  drawRune(ctx, origin: CGPoint(x: tx, y: ty), scale: CGFloat(ts))
  write(ctx, to: target)
}

// The disk image art is sRGB, so Finder shows the hex values of riggverk.se.
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

func artColor(_ hex: String) -> CGColor {
  let v = UInt32(hex.dropFirst(), radix: 16) ?? 0
  let components = [CGFloat((v >> 16) & 0xff) / 255, CGFloat((v >> 8) & 0xff) / 255, CGFloat(v & 0xff) / 255, 1]
  return CGColor(colorSpace: sRGB, components: components)!
}

let graphite = artColor("#1e1e20")
let light = artColor("#e6e6e8")
let silver = artColor("#b8bcc4")

// The volume icon: a square graphite plate (square corners, unlike the app's squircle) in the tile's
// bounds, with the rune where the app icon has it.
func renderVolume(size: Int, target: URL) {
  let s = CGFloat(size)
  let ctx = makeContext(width: size, height: size, space: sRGB)
  ctx.translateBy(x: 0, y: s)
  ctx.scaleBy(x: s / 1024, y: -s / 1024)
  ctx.setFillColor(graphite)
  ctx.fill(CGRect(x: 100, y: 100, width: 824, height: 824))
  drawRune(ctx, origin: CGPoint(x: tx, y: ty), scale: CGFloat(ts), fillColor: light)
  write(ctx, to: target)
}

// The Finder window of the disk image, in points: 660x400, icons centred at y 170.
let dmgWidth = 660
let dmgHeight = 400
let appCenter = CGPoint(x: 180, y: 170)
let applicationsCenter = CGPoint(x: 480, y: 170)

func renderBackground(scale: Int, target: URL) {
  let ctx = makeContext(width: dmgWidth * scale, height: dmgHeight * scale, space: sRGB)
  ctx.translateBy(x: 0, y: CGFloat(dmgHeight * scale))
  ctx.scaleBy(x: CGFloat(scale), y: -CGFloat(scale))
  ctx.setFillColor(graphite)
  ctx.fill(CGRect(x: 0, y: 0, width: dmgWidth, height: dmgHeight))

  // Wordmark, top left: the rune (28 pt tall) and the name beside it, as on riggverk.se.
  drawRune(ctx, origin: CGPoint(x: 26, y: 26), scale: 28.0 / 64.0, fillColor: light)
  let font = CTFontCreateWithName("HelveticaNeue-Medium" as CFString, 19, nil)
  let attributes = [
    kCTFontAttributeName: font,
    kCTForegroundColorAttributeName: light,
  ] as CFDictionary
  guard let text = CFAttributedStringCreate(nil, "Riggverk" as CFString, attributes) else {
    fail("could not lay out the wordmark")
  }
  let line = CTLineCreateWithAttributedString(text)
  ctx.saveGState()
  ctx.translateBy(x: 56, y: 47)
  ctx.scaleBy(x: 1, y: -1)
  ctx.textPosition = .zero
  CTLineDraw(line, ctx)
  ctx.restoreGState()

  // The one silver detail: a thin arrow between the two 128 pt icons, square ends.
  let start = appCenter.x + 64 + 30
  let end = applicationsCenter.x - 64 - 30
  ctx.setStrokeColor(silver)
  ctx.setLineWidth(1.5)
  ctx.setLineCap(.butt)
  ctx.setLineJoin(.miter)
  ctx.beginPath()
  ctx.move(to: CGPoint(x: start, y: appCenter.y))
  ctx.addLine(to: CGPoint(x: end, y: appCenter.y))
  ctx.strokePath()
  ctx.beginPath()
  ctx.move(to: CGPoint(x: end - 7, y: appCenter.y - 7))
  ctx.addLine(to: CGPoint(x: end, y: appCenter.y))
  ctx.addLine(to: CGPoint(x: end - 7, y: appCenter.y + 7))
  ctx.strokePath()

  write(ctx, to: target, dpi: 72 * scale)
}

for mode in ["light", "dark"] {
  for size in [16, 32, 64, 128, 256, 512, 1024] {
    render(size: size, target: outputDir.appendingPathComponent("\(mode)-\(size).png"))
  }
}
for size in [16, 32, 64, 128, 256, 512, 1024] {
  renderVolume(size: size, target: outputDir.appendingPathComponent("volume-\(size).png"))
}
renderBackground(scale: 1, target: outputDir.appendingPathComponent("dmg-background.png"))
renderBackground(scale: 2, target: outputDir.appendingPathComponent("dmg-background@2x.png"))
