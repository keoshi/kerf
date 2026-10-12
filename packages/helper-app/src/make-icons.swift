// Draws Kerf's icons: a craft-knife blade cutting a line (the kerf).
//
//   xcrun swift src/make-icons.swift <output dir>
//
// Writes AppIcon.iconset/ (all sizes for iconutil) and MenuBarIcon.png / MenuBarIcon@2x.png (template images).
// With --plugin-icon, writes only PluginIcon.png: the same art full-bleed at 1024², for the Figma plugin listing.

import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
let pluginIcon = CommandLine.arguments.contains("--plugin-icon")

/// The blade in a 100×100 box (y up): a #11 craft blade, heel at the top right, tip at the bottom left,
/// with the slot that holds it in a handle.
func bladePath(in rect: CGRect) -> (blade: NSBezierPath, slot: NSBezierPath, tip: CGPoint) {
  // Blade-local coordinates: x along the spine (0 = heel, 74 = tip), y across (0 = spine, 17 = edge).
  let length: CGFloat = 74, width: CGFloat = 17
  let local: [CGPoint] = [.init(x: 0, y: 0), .init(x: length, y: 0), .init(x: length - 30, y: width), .init(x: 0, y: width)]
  let tipLocal = CGPoint(x: length, y: 0)
  // Place the heel at (80, 76) and point the tip down-left at 40° below horizontal.
  let angle = CGFloat.pi + 0.70
  let s = rect.width / 100
  func place(_ p: CGPoint) -> CGPoint {
    let x = 80 + p.x * cos(angle) - p.y * sin(angle)
    let y = 76 + p.x * sin(angle) + p.y * cos(angle)
    return CGPoint(x: rect.minX + x * s, y: rect.minY + y * s)
  }
  let blade = NSBezierPath()
  blade.move(to: place(local[0]))
  for p in local.dropFirst() { blade.line(to: place(p)) }
  blade.close()

  // The slot: a rounded stadium along the spine near the heel.
  let slot = NSBezierPath()
  let a = place(.init(x: 9, y: 8.5)), b = place(.init(x: 27, y: 8.5))
  slot.lineWidth = 5 * s
  slot.lineCapStyle = .round
  slot.move(to: a)
  slot.line(to: b)
  return (blade, slot, place(tipLocal))
}

func bitmap(_ size: Int, draw: (CGRect) -> Void) -> NSBitmapImageRep {
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  draw(CGRect(x: 0, y: 0, width: size, height: size))
  NSGraphicsContext.restoreGraphicsState()
  return rep
}

func write(_ rep: NSBitmapImageRep, _ url: URL) {
  try! rep.representation(using: .png, properties: [:])!.write(to: url)
}

// MARK: App icon

let orange = NSColor(srgbRed: 1.0, green: 0.42, blue: 0.17, alpha: 1)

func appIcon(_ size: Int, fullBleed: Bool = false) -> NSBitmapImageRep {
  bitmap(size) { canvas in
    let s = canvas.width / (fullBleed ? 824 : 1024)
    // macOS icon grid: an 824×824 rounded square centred on the 1024 canvas. Full-bleed: the square only.
    let tile = fullBleed ? canvas : CGRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)
    let shape = fullBleed ? NSBezierPath(rect: tile) : NSBezierPath(roundedRect: tile, xRadius: 185 * s, yRadius: 185 * s)

    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowOffset = NSSize(width: 0, height: -10 * s)
    shadow.shadowBlurRadius = 24 * s
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
    shadow.set()
    NSColor.black.setFill()
    shape.fill()
    NSGraphicsContext.restoreGraphicsState()

    NSGraphicsContext.saveGraphicsState()
    shape.addClip()
    NSGradient(
      starting: NSColor(srgbRed: 0.20, green: 0.21, blue: 0.24, alpha: 1),
      ending: NSColor(srgbRed: 0.09, green: 0.10, blue: 0.11, alpha: 1))!.draw(in: tile, angle: -90)

    // A faint cutting-mat grid.
    NSColor.white.withAlphaComponent(0.06).setStroke()
    let grid = NSBezierPath()
    grid.lineWidth = 3 * s
    for i in 1..<8 {
      let o = tile.minX + CGFloat(i) * tile.width / 8
      grid.move(to: .init(x: o, y: tile.minY)); grid.line(to: .init(x: o, y: tile.maxY))
      let p = tile.minY + CGFloat(i) * tile.height / 8
      grid.move(to: .init(x: tile.minX, y: p)); grid.line(to: .init(x: tile.maxX, y: p))
    }
    grid.stroke()

    let art = tile.insetBy(dx: 90 * s, dy: 90 * s)
    let (blade, slot, tip) = bladePath(in: art)

    // The kerf: the cut trailing behind the tip.
    let cut = NSBezierPath()
    cut.lineWidth = 30 * s
    cut.lineCapStyle = .round
    cut.move(to: .init(x: tip.x + 40 * s, y: tip.y))
    cut.line(to: .init(x: tile.maxX - 120 * s, y: tip.y))
    orange.setStroke()
    cut.stroke()

    NSGraphicsContext.saveGraphicsState()
    blade.addClip()
    NSGradient(
      starting: NSColor(srgbRed: 0.97, green: 0.97, blue: 0.98, alpha: 1),
      ending: NSColor(srgbRed: 0.62, green: 0.65, blue: 0.70, alpha: 1))!.draw(in: blade.bounds, angle: -60)
    NSGraphicsContext.restoreGraphicsState()

    // Punch the slot out of the blade with the background colour.
    NSColor(srgbRed: 0.15, green: 0.16, blue: 0.18, alpha: 1).setStroke()
    slot.stroke()
    NSGraphicsContext.restoreGraphicsState()
  }
}

// MARK: Menu-bar template (black on transparent; macOS tints it)

func menuBarIcon(_ size: Int) -> NSBitmapImageRep {
  bitmap(size) { canvas in
    let s = canvas.width / 18
    let (blade, slot, tip) = bladePath(in: canvas.insetBy(dx: -0.5 * s, dy: -0.5 * s).offsetBy(dx: 0, dy: 1 * s))
    NSColor.black.setFill()
    blade.fill()
    // Clear the slot.
    NSGraphicsContext.current!.compositingOperation = .clear
    slot.lineWidth = 1.6 * s
    slot.stroke()
    NSGraphicsContext.current!.compositingOperation = .sourceOver
    let cut = NSBezierPath()
    cut.lineWidth = 1.6 * s
    cut.lineCapStyle = .round
    cut.move(to: .init(x: tip.x + 2.2 * s, y: tip.y))
    cut.line(to: .init(x: canvas.maxX - 1 * s, y: tip.y))
    NSColor.black.setStroke()
    cut.stroke()
  }
}

if pluginIcon {
  try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
  write(appIcon(1024, fullBleed: true), out.appendingPathComponent("PluginIcon.png"))
  exit(0)
}

let iconset = out.appendingPathComponent("AppIcon.iconset")
try? FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
  write(appIcon(base), iconset.appendingPathComponent("icon_\(base)x\(base).png"))
  write(appIcon(base * 2), iconset.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
write(menuBarIcon(18), out.appendingPathComponent("MenuBarIcon.png"))
write(menuBarIcon(36), out.appendingPathComponent("MenuBarIcon@2x.png"))
print("Icons written to \(out.path)")
