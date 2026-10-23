import Testing
@testable import DroverKit

struct BackoffTests {
    static func secs(_ d: Duration) -> Double { Double(d.components.seconds) + Double(d.components.attoseconds) / 1e18 }

    @Test func growthAndCap() {
        let b = Backoff(initial: .seconds(1), maximum: .seconds(60), multiplier: 2, jitter: 0)
        #expect(Self.secs(b.delay(attempt: 0, random: 0.5)) == 1)
        #expect(Self.secs(b.delay(attempt: 3, random: 0.5)) == 8)
        #expect(Self.secs(b.delay(attempt: 10, random: 0.5)) == 60)
        #expect(Self.secs(b.delay(attempt: 5000, random: 0.5)) == 60)
    }

    @Test func jitterBounds() {
        let b = Backoff.standard
        #expect(abs(Self.secs(b.delay(attempt: 2, random: 0)) - 3.2) < 1e-9)
        #expect(abs(Self.secs(b.delay(attempt: 2, random: 1)) - 4.8) < 1e-9)
        #expect(abs(Self.secs(b.delay(attempt: 2, random: 0.5)) - 4.0) < 1e-9)
    }

    @Test func randomDelayWithinBounds() {
        for _ in 0..<50 {
            let s = Self.secs(Backoff.standard.delay(attempt: 0))
            #expect(s >= 0.8 && s <= 1.2)
        }
    }

    @Test func neverNegative() {
        let b = Backoff(initial: .seconds(1), maximum: .seconds(1), multiplier: 1, jitter: 5)
        #expect(Self.secs(b.delay(attempt: 0, random: 0)) == 0)
    }
}
