import CoreGraphics
import Foundation
import ImageIO

struct IconError: Error, CustomStringConvertible {
  let description: String
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
  exit(1)
}

let args = CommandLine.arguments
if args.count != 2 {
  fail("usage: render-macos-pyramid-icons.swift <output-dir>")
}

let outputDir = URL(fileURLWithPath: args[1], isDirectory: true)
try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

struct Color {
  let r: CGFloat
  let g: CGFloat
  let b: CGFloat
  let a: CGFloat
}

func cgColor(_ color: Color) -> CGColor {
  CGColor(red: color.r, green: color.g, blue: color.b, alpha: color.a)
}

func fillPolygon(_ ctx: CGContext, _ points: [CGPoint], _ color: Color) {
  guard let first = points.first else { return }
  ctx.beginPath()
  ctx.move(to: first)
  for point in points.dropFirst() {
    ctx.addLine(to: point)
  }
  ctx.closePath()
  ctx.setFillColor(cgColor(color))
  ctx.fillPath()
}

func point(_ a: CGPoint, _ b: CGPoint, _ t: CGFloat) -> CGPoint {
  CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
}

func render(mode: String, size: Int, target: URL) throws {
  let s = CGFloat(size)
  let colorSpace = CGColorSpaceCreateDeviceRGB()
  guard let ctx = CGContext(
    data: nil,
    width: size,
    height: size,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else {
    throw IconError(description: "could not create CGContext")
  }

  ctx.clear(CGRect(x: 0, y: 0, width: s, height: s))

  let left: [Color]
  let right: [Color]
  let edge: Color

  if mode == "dark" {
    left = [
      Color(r: 0.92, g: 0.92, b: 0.92, a: 0.98),
      Color(r: 0.76, g: 0.76, b: 0.76, a: 0.98),
      Color(r: 0.58, g: 0.58, b: 0.58, a: 0.98),
      Color(r: 0.43, g: 0.43, b: 0.43, a: 0.98),
    ]
    right = [
      Color(r: 0.70, g: 0.70, b: 0.70, a: 0.98),
      Color(r: 0.52, g: 0.52, b: 0.52, a: 0.98),
      Color(r: 0.36, g: 0.36, b: 0.36, a: 0.98),
      Color(r: 0.25, g: 0.25, b: 0.25, a: 0.98),
    ]
    edge = Color(r: 1.00, g: 1.00, b: 1.00, a: 0.22)
  } else {
    left = [
      Color(r: 0.22, g: 0.22, b: 0.22, a: 0.96),
      Color(r: 0.30, g: 0.30, b: 0.30, a: 0.96),
      Color(r: 0.42, g: 0.42, b: 0.42, a: 0.96),
      Color(r: 0.56, g: 0.56, b: 0.56, a: 0.96),
    ]
    right = [
      Color(r: 0.39, g: 0.39, b: 0.39, a: 0.96),
      Color(r: 0.50, g: 0.50, b: 0.50, a: 0.96),
      Color(r: 0.64, g: 0.64, b: 0.64, a: 0.96),
      Color(r: 0.76, g: 0.76, b: 0.76, a: 0.96),
    ]
    edge = Color(r: 0.00, g: 0.00, b: 0.00, a: 0.18)
  }

  // Use top-left icon design coordinates inside CoreGraphics' bottom-left user space.
  ctx.saveGState()
  ctx.translateBy(x: 0, y: s)
  ctx.scaleBy(x: 1, y: -1)

  let apex = CGPoint(x: 512.0 / 1024.0 * s, y: 190.0 / 1024.0 * s)
  let leftBase = CGPoint(x: 220.0 / 1024.0 * s, y: 760.0 / 1024.0 * s)
  let rightBase = CGPoint(x: 804.0 / 1024.0 * s, y: 760.0 / 1024.0 * s)
  let centerBase = CGPoint(x: 512.0 / 1024.0 * s, y: 850.0 / 1024.0 * s)
  let bands: [CGFloat] = [0, 0.30, 0.56, 0.78, 1.0]

  for index in 0..<(bands.count - 1) {
    let t0 = bands[index]
    let t1 = bands[index + 1]
    fillPolygon(ctx, [
      point(apex, leftBase, t0),
      point(apex, centerBase, t0),
      point(apex, centerBase, t1),
      point(apex, leftBase, t1),
    ], left[index])
    fillPolygon(ctx, [
      point(apex, centerBase, t0),
      point(apex, rightBase, t0),
      point(apex, rightBase, t1),
      point(apex, centerBase, t1),
    ], right[index])
  }

  ctx.setStrokeColor(cgColor(edge))
  ctx.setLineWidth(max(1, s / 220))
  ctx.beginPath()
  ctx.move(to: apex)
  ctx.addLine(to: centerBase)
  ctx.strokePath()
  ctx.restoreGState()

  guard let image = ctx.makeImage() else {
    throw IconError(description: "could not create output image")
  }
  guard let destination = CGImageDestinationCreateWithURL(target as CFURL, "public.png" as CFString, 1, nil) else {
    throw IconError(description: "could not create PNG destination")
  }
  CGImageDestinationAddImage(destination, image, nil)
  if !CGImageDestinationFinalize(destination) {
    throw IconError(description: "could not write PNG")
  }
}

do {
  for mode in ["light", "dark"] {
    for size in [16, 32, 64, 128, 256, 512, 1024] {
      try render(mode: mode, size: size, target: outputDir.appendingPathComponent("\(mode)-\(size).png"))
    }
  }
} catch {
  fail(String(describing: error))
}
