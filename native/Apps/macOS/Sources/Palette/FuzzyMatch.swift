import Foundation

/// Subsequence fuzzy matcher for the command palette. Case and diacritic insensitive.
/// Scoring: +10 per matched char, +15 when the match starts at index 0, +8 per match at a word start,
/// +5 per consecutive matched char, minus 1 per skipped char before the first match (capped at 10).
/// Picks the best-scoring alignment, not just the leftmost.
enum FuzzyMatch {
    static func score(_ query: String, in candidate: String) -> Int? {
        best(query, in: candidate)?.score
    }

    /// Character offsets (into `candidate`) of the best alignment, for highlighting. Empty when no match.
    static func matchedIndices(_ query: String, in candidate: String) -> [Int] {
        best(query, in: candidate)?.indices ?? []
    }

    private static func fold(_ c: Character) -> Character {
        let s = String(c).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
        return s.first ?? c
    }

    private static func isBoundary(_ cand: [Character], _ j: Int) -> Bool {
        if j == 0 { return true }
        let prev = cand[j - 1]
        if " -_/.".contains(prev) { return true }
        return prev.isLowercase && cand[j].isUppercase
    }

    private static func best(_ query: String, in candidate: String) -> (score: Int, indices: [Int])? {
        let q = query.filter { !$0.isWhitespace }.map(fold)
        let cand = Array(candidate)
        if q.isEmpty { return (0, []) }
        let folded = cand.map(fold)
        let n = cand.count, m = q.count
        guard n >= m else { return nil }
        let boundary = (0..<n).map { isBoundary(cand, $0) }
        // dp[i][j]: best score with query[i] matched at candidate j (excluding the leading penalty).
        var dp = [[Int?]](repeating: [Int?](repeating: nil, count: n), count: m)
        var from = [[Int]](repeating: [Int](repeating: -1, count: n), count: m)
        func charScore(_ i: Int, _ j: Int) -> Int {
            var s = 10
            if i == 0 && j == 0 { s += 15 }
            if boundary[j] { s += 8 }
            return s
        }
        for j in 0..<n where folded[j] == q[0] {
            dp[0][j] = charScore(0, j) - min(10, j)
        }
        if m > 1 {
            for i in 1..<m {
                for j in i..<n where folded[j] == q[i] {
                    var bestPrev: Int?
                    var bestK = -1
                    for k in (i - 1)..<j {
                        guard let p = dp[i - 1][k] else { continue }
                        let v = p + (k == j - 1 ? 5 : 0)
                        if bestPrev == nil || v > bestPrev! { bestPrev = v; bestK = k }
                    }
                    if let bp = bestPrev {
                        dp[i][j] = bp + charScore(i, j)
                        from[i][j] = bestK
                    }
                }
            }
        }
        var endJ = -1
        var top: Int?
        for j in 0..<n {
            if let v = dp[m - 1][j], top == nil || v > top! { top = v; endJ = j }
        }
        guard let total = top else { return nil }
        var indices = [Int](repeating: 0, count: m)
        var j = endJ
        for i in stride(from: m - 1, through: 0, by: -1) {
            indices[i] = j
            j = from[i][j]
        }
        return (total, indices)
    }
}
