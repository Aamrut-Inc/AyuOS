// Draws the AyuOS app icon (1024x1024 PNG): a soft green rounded square with
// a white heart and pulse line. Usage: swift make-icon.swift <out.png>
import AppKit

let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let rect = NSRect(x: 80, y: 80, width: size - 160, height: size - 160)
let background = NSBezierPath(roundedRect: rect, xRadius: 190, yRadius: 190)
NSGradient(starting: NSColor(calibratedRed: 0.16, green: 0.62, blue: 0.52, alpha: 1),
           ending: NSColor(calibratedRed: 0.08, green: 0.40, blue: 0.45, alpha: 1))!.draw(in: background, angle: -90)

let heart = NSBezierPath()
let cx = size / 2, cy = size / 2 + 10
heart.move(to: NSPoint(x: cx, y: cy - 230))
heart.curve(to: NSPoint(x: cx - 270, y: cy + 90), controlPoint1: NSPoint(x: cx - 150, y: cy - 120), controlPoint2: NSPoint(x: cx - 270, y: cy - 20))
heart.curve(to: NSPoint(x: cx, y: cy + 150), controlPoint1: NSPoint(x: cx - 270, y: cy + 260), controlPoint2: NSPoint(x: cx - 60, y: cy + 270))
heart.curve(to: NSPoint(x: cx + 270, y: cy + 90), controlPoint1: NSPoint(x: cx + 60, y: cy + 270), controlPoint2: NSPoint(x: cx + 270, y: cy + 260))
heart.curve(to: NSPoint(x: cx, y: cy - 230), controlPoint1: NSPoint(x: cx + 270, y: cy - 20), controlPoint2: NSPoint(x: cx + 150, y: cy - 120))
NSColor.white.setFill()
heart.fill()

let pulse = NSBezierPath()
pulse.lineWidth = 34
pulse.lineCapStyle = .round
pulse.lineJoinStyle = .round
let points: [(CGFloat, CGFloat)] = [(-230, 20), (-90, 20), (-40, 120), (20, -110), (80, 70), (110, 20), (230, 20)]
for (i, p) in points.enumerated() {
  let point = NSPoint(x: cx + p.0, y: cy + p.1)
  if i == 0 { pulse.move(to: point) } else { pulse.line(to: point) }
}
NSColor(calibratedRed: 0.10, green: 0.50, blue: 0.48, alpha: 1).setStroke()
pulse.stroke()
image.unlockFocus()

let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
