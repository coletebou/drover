import Foundation

extension Suites {
    static var a11ySuites: [(String, () async throws -> Void)] { [("a11y", a11y)] }

    static func a11y() {
        // Known values guard the maths itself.
        expect(abs(Palette.contrast(0x000000, 0xFFFFFF) - 21) < 0.001, "black on white is 21:1")
        expect(abs(Palette.contrast(0x777777, 0xFFFFFF) - 4.48) < 0.01, "#777 on white is about 4.48:1")
        let half = Palette.composite(Palette.rgb(0xFFFFFF), alpha: 0.5, over: Palette.rgb(0x000000))
        expect(abs(half.r - 0.5) < 1e-9 && abs(half.b - 0.5) < 1e-9, "alpha compositing")

        for (name, s) in [("light", Palette.light), ("dark", Palette.dark)] {
            let bases: [(String, UInt32)] = [("background", s.background), ("surface", s.surface), ("surfaceRaised", s.surfaceRaised)]
            for (bn, b) in bases {
                let p = Palette.contrast(s.textPrimary, b)
                expect(p >= 7.0, "\(name) textPrimary on \(bn) \(p)")
                let t = Palette.contrast(s.textSecondary, b)
                expect(t >= 4.5, "\(name) textSecondary on \(bn) \(t)")
            }
            for (sn, hex) in s.stateColors {
                for (bn, b) in [("surface", s.surface), ("background", s.background)] {
                    let c = Palette.contrast(hex, b)
                    expect(c >= 4.5, "\(name) \(sn) on \(bn) \(c)")
                    let badge = Palette.badgeContrast(state: hex, over: b)
                    expect(badge >= 4.5, "\(name) \(sn) on its badge over \(bn) \(badge)")
                }
            }
        }
    }
}
