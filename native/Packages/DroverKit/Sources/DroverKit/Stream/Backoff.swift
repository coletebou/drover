import Foundation

/// Exponential reconnect delay with jitter.
public struct Backoff: Sendable, Equatable {
    public var initial: Duration
    public var maximum: Duration
    public var multiplier: Double
    /// Fraction: 0.2 means the delay is scaled by a random factor in 0.8...1.2.
    public var jitter: Double

    public init(initial: Duration, maximum: Duration, multiplier: Double, jitter: Double) {
        self.initial = initial
        self.maximum = maximum
        self.multiplier = multiplier
        self.jitter = jitter
    }

    public static let standard = Backoff(initial: .seconds(1), maximum: .seconds(60), multiplier: 2, jitter: 0.2)

    /// attempt 0 = first retry.
    public func delay(attempt: Int) -> Duration {
        delay(attempt: attempt, random: Double.random(in: 0...1))
    }

    /// `random` in 0...1 picks the jitter factor in [1 - jitter, 1 + jitter].
    func delay(attempt: Int, random: Double) -> Duration {
        let r = min(1, max(0, random))
        let base = Self.seconds(initial) * pow(multiplier, Double(max(0, attempt)))
        let capped = min(Self.seconds(maximum), base.isFinite ? base : Self.seconds(maximum))
        let factor = (1 - jitter) + (2 * jitter) * r
        return .seconds(max(0, capped * factor))
    }

    private static func seconds(_ d: Duration) -> Double {
        let c = d.components
        return Double(c.seconds) + Double(c.attoseconds) / 1e18
    }
}
