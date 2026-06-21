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
  return CGColor(red: color.r, green: color.g, blue: color.b, alpha: color.a)
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

func point(_ ax: CGFloat, _ ay: CGFloat, _ bx: CGFloat, _ by: CGFloat, _ t: CGFloat) -> CGPoint {
  return CGPoint(x: ax + (bx - ax) * t, y: ay + (by - ay) * t)
}

func render(mode: String, size: Int, target: URL) throws {
  let s = CGFloat(size)
  let colorSpace = CGColorSpaceCreateDeviceRGB()
  guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    throw IconError(description: "could not create CGContext")
  }

  let bgTop: Color
  let bgBottom: Color
  let shadow: Color
  let left: [Color]
  let right: [Color]

  if mode == "dark" {
    bgTop = Color(r: 0.16, g: 0.16, b: 0.16, a: 1)
    bgBottom = Color(r: 0.05, g: 0.05, b: 0.05, a: 1)
    shadow = Color(r: 0, g: 0, b: 0, a: 0.30)
    left = [
      Color(r: 0.86, g: 0.86, b: 0.86, a: 1),
      Color(r: 0.66, g: 0.66, b: 0.66, a: 1),
      Color(r: 0.42, g: 0.42, b: 0.42, a: 1),
      Color(r: 0.25, g: 0.25, b: 0.25, a: 1),
    ]
    right = [
      Color(r: 0.63, g: 0.63, b: 0.63, a: 1),
      Color(r: 0.38, g: 0.38, b: 0.38, a: 1),
      Color(r: 0.22, g: 0.22, b: 0.22, a: 1),
      Color(r: 0.12, g: 0.12, b: 0.12, a: 1),
    ]
  } else {
    bgTop = Color(r: 0.98, g: 0.98, b: 0.97, a: 1)
    bgBottom = Color(r: 0.86, g: 0.86, b: 0.85, a: 1)
    shadow = Color(r: 0, g: 0, b: 0, a: 0.16)
    left = [
      Color(r: 0.91, g: 0.91, b: 0.91, a: 1),
      Color(r: 0.78, g: 0.78, b: 0.78, a: 1),
      Color(r: 0.58, g: 0.58, b: 0.58, a: 1),
      Color(r: 0.38, g: 0.38, b: 0.38, a: 1),
    ]
    right = [
      Color(r: 0.72, g: 0.72, b: 0.72, a: 1),
      Color(r: 0.48, g: 0.48, b: 0.48, a: 1),
      Color(r: 0.28, g: 0.28, b: 0.28, a: 1),
      Color(r: 0.16, g: 0.16, b: 0.16, a: 1),
    ]
  }

  let bgGradient = CGGradient(colorsSpace: colorSpace, colors: [cgColor(bgTop), cgColor(bgBottom)] as CFArray, locations: [0, 1])!
  ctx.drawLinearGradient(bgGradient, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: s), options: [])

  // Use top-left icon design coordinates inside CoreGraphics' bottom-left user space.
  ctx.saveGState()
  ctx.translateBy(x: 0, y: s)
  ctx.scaleBy(x: 1, y: -1)

  ctx.setFillColor(cgColor(shadow))
  ctx.fillEllipse(in: CGRect(x: 175.0 / 1024.0 * s, y: 720.0 / 1024.0 * s, width: 674.0 / 1024.0 * s, height: 106.0 / 1024.0 * s))

  let apex = CGPoint(x: 512.0 / 1024.0 * s, y: 160.0 / 1024.0 * s)
  let leftBase = CGPoint(x: 158.0 / 1024.0 * s, y: 750.0 / 1024.0 * s)
  let rightBase = CGPoint(x: 866.0 / 1024.0 * s, y: 750.0 / 1024.0 * s)
  let centerBase = CGPoint(x: 512.0 / 1024.0 * s, y: 864.0 / 1024.0 * s)
  let bands: [CGFloat] = [0, 0.30, 0.56, 0.78, 1.0]

  for index in 0..<(bands.count - 1) {
    let t0 = bands[index]
    let t1 = bands[index + 1]
    fillPolygon(ctx, [
      point(apex.x, apex.y, leftBase.x, leftBase.y, t0),
      point(apex.x, apex.y, centerBase.x, centerBase.y, t0),
      point(apex.x, apex.y, centerBase.x, centerBase.y, t1),
      point(apex.x, apex.y, leftBase.x, leftBase.y, t1),
    ], left[index])
    fillPolygon(ctx, [
      point(apex.x, apex.y, centerBase.x, centerBase.y, t0),
      point(apex.x, apex.y, rightBase.x, rightBase.y, t0),
      point(apex.x, apex.y, rightBase.x, rightBase.y, t1),
      point(apex.x, apex.y, centerBase.x, centerBase.y, t1),
    ], right[index])
  }

  ctx.setStrokeColor(cgColor(mode == "dark" ? Color(r: 1, g: 1, b: 1, a: 0.18) : Color(r: 0, g: 0, b: 0, a: 0.12)))
  ctx.setLineWidth(max(1, s / 256))
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
