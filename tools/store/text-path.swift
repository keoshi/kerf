// Prints SVG path data for a string's glyph outlines (y down, origin at the top-left of the text box).
//   xcrun swift tools/store/text-path.swift "kerf" "Avenir Next Heavy" 100
import AppKit
import CoreText

let args = CommandLine.arguments
let text = args.count > 1 ? args[1] : "kerf"
let font = CTFontCreateWithName((args.count > 2 ? args[2] : "Avenir Next Heavy") as CFString, CGFloat(Double(args.count > 3 ? args[3] : "100")!), nil)
let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [.font: font]))
let ascent = CTFontGetAscent(font)
var d = ""
func f(_ v: CGFloat) -> String { String(format: "%.2f", v) }
for run in CTLineGetGlyphRuns(line) as! [CTRun] {
  let count = CTRunGetGlyphCount(run)
  var glyphs = [CGGlyph](repeating: 0, count: count), positions = [CGPoint](repeating: .zero, count: count)
  CTRunGetGlyphs(run, CFRange(location: 0, length: count), &glyphs)
  CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)
  for (g, pos) in zip(glyphs, positions) {
    guard let path = CTFontCreatePathForGlyph(font, g, nil) else { continue }
    // Glyph space is y up; flip to y down below the ascent line.
    func pt(_ p: CGPoint) -> String { "\(f(pos.x + p.x)) \(f(ascent - p.y))" }
    path.applyWithBlock { e in
      let el = e.pointee, p = el.points
      switch el.type {
      case .moveToPoint: d += "M \(pt(p[0])) "
      case .addLineToPoint: d += "L \(pt(p[0])) "
      case .addQuadCurveToPoint: d += "Q \(pt(p[0])) \(pt(p[1])) "
      case .addCurveToPoint: d += "C \(pt(p[0])) \(pt(p[1])) \(pt(p[2])) "
      case .closeSubpath: d += "Z "
      @unknown default: break
      }
    }
  }
}
print(d)
