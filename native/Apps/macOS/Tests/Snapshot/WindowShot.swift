import AppKit
import SwiftUI

/// A whole-window scene drawn like a Mac window screenshot: the frame view (title bar, toolbar and content), rounded
/// corners, the window's rim, colored traffic lights and a soft shadow on a transparent background.
///
/// Offscreen, `cacheDisplay` draws the layer tree without filters, compositing filters or masks, so macOS 26's
/// Liquid Glass comes out wrong: a glass shape is solid white, a backdrop blur black, a scroll pocket's mask erases
/// the list under it, and the traffic lights are gray. `flatten` hides those layers and gives each glass view a
/// plain stand-in of its shape. The harness only: the app never does any of this.
@MainActor
enum WindowShot {
    /// A window with a toolbar has 26 pt corners on macOS 26 (10 before); the floating sidebar is concentric with them.
    static var cornerRadius: CGFloat {
        if #available(macOS 26, *) { 26 } else { 10 }
    }
    /// Transparent room around the window for its shadow.
    static let margin: CGFloat = 56

    static func flatten(_ frameView: NSView, window: NSWindow, dark: Bool) {
        for v in descendants(frameView) {
            if v.layer.map({ String(describing: type(of: $0)) }) == "CABackdropLayer"
                || String(describing: type(of: v)) == "NSScrollPocket" {
                v.isHidden = true
            }
        }
        if #available(macOS 26, *) {
            for case let glass as NSGlassEffectView in descendants(frameView) { standIn(for: glass, in: frameView, dark: dark) }
            for case let group as NSGlassEffectContainerView in descendants(frameView) {
                hideEffect(of: group, keeping: group.contentView)
            }
        }
        // An offscreen window is never key, so its traffic lights are gray (`png` draws them), and the title bar's
        // vibrant label color comes out gray without its blending: the title gets the color it shows on screen.
        for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            window.standardWindowButton(kind)?.isHidden = true
        }
        for case let field as NSTextField in descendants(frameView) where field.stringValue == window.title {
            field.textColor = NSColor(white: dark ? 1 : 0, alpha: 0.85)
        }
        if let root = frameView.layer { applyVibrancy(in: root, scale: window.backingScaleFactor) }
    }

    /// SwiftUI draws vibrant text (the sidebar's section headers) in black for a color matrix to turn into the shade
    /// it shows, and offscreen the matrix is skipped. Run each such drawing through its matrix into a plain layer
    /// that takes its place.
    private static func applyVibrancy(in root: CALayer, scale: CGFloat) {
        for layer in sublayers(root) where String(describing: type(of: layer)) == "CGDrawingLayer" {
            guard let filter = (layer.filters ?? []).first(where: { String(describing: $0) == "vibrantColorMatrix" }) as? NSObject,
                  let value = filter.value(forKey: "inputColorMatrix") as? NSValue else { continue }
            var m = [Float](repeating: 0, count: 20)   // a CAColorMatrix: four rows of r, g, b, a, bias
            m.withUnsafeMutableBytes { value.getValue($0.baseAddress!, size: $0.count) }
            let w = Int((layer.bounds.width * scale).rounded(.up)), h = Int((layer.bounds.height * scale).rounded(.up))
            guard w > 0, h > 0,
                  let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
                  let data = ctx.data?.bindMemory(to: UInt8.self, capacity: w * h * 4) else { continue }
            ctx.scaleBy(x: scale, y: scale)
            // A drawing for a flipped layer tree renders upside down into a bitmap; image contents show upright.
            if layer.contentsAreFlipped() {
                ctx.translateBy(x: 0, y: layer.bounds.height)
                ctx.scaleBy(x: 1, y: -1)
            }
            layer.render(in: ctx)
            for i in stride(from: 0, to: w * h * 4, by: 4) where data[i + 3] > 0 {
                let a = Float(data[i + 3]) / 255
                let c = (0..<3).map { Float(data[i + $0]) / 255 / a } + [a, 1]
                let out = (0..<4).map { row in min(max((0..<5).reduce(Float(0)) { $0 + m[row * 5 + $1] * c[$1] }, 0), 1) }
                for k in 0..<3 { data[i + k] = UInt8((out[k] * out[3] * 255).rounded()) }
                data[i + 3] = UInt8((out[3] * 255).rounded())
            }
            let standIn = CALayer()
            standIn.frame = layer.frame
            standIn.contents = ctx.makeImage()
            standIn.contentsScale = scale
            layer.superlayer?.insertSublayer(standIn, above: layer)
            layer.isHidden = true
        }
    }

    /// The frame view's bitmap as a window screenshot PNG. `lights` are the traffic lights' frames in the frame view.
    static func png(_ rep: NSBitmapImageRep, lights: [CGRect], dark: Bool) -> Data? {
        guard let image = rep.cgImage else { return nil }
        let scale = CGFloat(rep.pixelsWide) / rep.size.width
        let window = CGRect(origin: CGPoint(x: margin, y: margin), size: rep.size)
        let canvas = window.insetBy(dx: -margin, dy: -margin).size
        guard let ctx = CGContext(data: nil, width: Int(canvas.width * scale), height: Int(canvas.height * scale),
                                  bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.scaleBy(x: scale, y: scale)
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).path(in: window).cgPath

        ctx.setShadow(offset: CGSize(width: 0, height: -18), blur: 44, color: NSColor.black.withAlphaComponent(dark ? 0.5 : 0.3).cgColor)
        ctx.beginTransparencyLayer(auxiliaryInfo: nil)
        ctx.addPath(shape)
        ctx.clip()
        ctx.draw(image, in: window)
        let colors: [(fill: UInt32, rim: UInt32)] = [(0xFF5F57, 0xE2463F), (0xFEBC2E, 0xE1A116), (0x28C840, 0x14AE2C)]
        for (frame, c) in zip(lights, colors) {
            let dot = frame.offsetBy(dx: margin, dy: margin).insetBy(dx: 0.5, dy: 0.5)
            ctx.setFillColor(cg(c.fill))
            ctx.fillEllipse(in: dot)
            ctx.setStrokeColor(cg(c.rim))
            ctx.setLineWidth(0.5)
            ctx.strokeEllipse(in: dot)
        }
        // The window's rim, which the window server draws on screen: a light hairline on dark, a faint dark one on light.
        let rim = RoundedRectangle(cornerRadius: cornerRadius - 0.5, style: .continuous).path(in: window.insetBy(dx: 0.5, dy: 0.5)).cgPath
        ctx.addPath(rim)
        ctx.setStrokeColor(dark ? NSColor.white.withAlphaComponent(0.2).cgColor : NSColor.black.withAlphaComponent(0.16).cgColor)
        ctx.setLineWidth(1)
        ctx.strokePath()
        ctx.endTransparencyLayer()

        guard let out = ctx.makeImage() else { return nil }
        let bitmap = NSBitmapImageRep(cgImage: out)
        bitmap.size = canvas
        return bitmap.representation(using: .png, properties: [:])
    }

    /// The traffic lights' frames in `frameView`, read before `flatten` hides them.
    static func lights(of window: NSWindow, in frameView: NSView) -> [CGRect] {
        [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].compactMap { kind in
            window.standardWindowButton(kind).map { $0.convert($0.bounds, to: frameView) }
        }
    }

    /// A glass view without its glass: the content clipped to the glass's shape over a flat tint, with a rim. The
    /// sidebar's glass is concentric with the window's corners; the others report their own radius.
    @available(macOS 26, *)
    private static func standIn(for glass: NSGlassEffectView, in frameView: NSView, dark: Bool) {
        hideEffect(of: glass, keeping: glass.contentView)
        let inset = glass.convert(glass.bounds, to: frameView).minX
        let concentric = String(describing: type(of: glass)).contains("Concentric")
        let radius = concentric ? cornerRadius - inset : glass.cornerRadius
        guard let layer = glass.layer else { return }
        layer.cornerRadius = radius
        layer.cornerCurve = .continuous
        layer.backgroundColor = (dark ? NSColor.white.withAlphaComponent(0.1) : NSColor.white.withAlphaComponent(0.7)).cgColor
        layer.borderWidth = 1
        layer.borderColor = (dark ? NSColor.white.withAlphaComponent(0.1) : NSColor.black.withAlphaComponent(0.08)).cgColor
        if let content = glass.contentView?.layer {
            content.cornerRadius = radius
            content.cornerCurve = .continuous
            content.masksToBounds = true
        }
    }

    /// Hide every subview of a glass view except the one holding its content: those draw the glass itself.
    private static func hideEffect(of view: NSView, keeping content: NSView?) {
        for sub in view.subviews where !(content.map { $0 === sub || $0.isDescendant(of: sub) } ?? false) {
            sub.isHidden = true
        }
    }

    private static func descendants(_ v: NSView) -> [NSView] { [v] + v.subviews.flatMap { descendants($0) } }
    private static func sublayers(_ l: CALayer) -> [CALayer] { [l] + (l.sublayers ?? []).flatMap { sublayers($0) } }

    private static func cg(_ rgb: UInt32) -> CGColor {
        CGColor(srgbRed: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255,
                blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }
}
