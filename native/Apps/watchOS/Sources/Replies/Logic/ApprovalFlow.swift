import Foundation

enum ApprovalPhase: Equatable, Sendable {
    case idle
    /// Option `n` was pressed and is on its way.
    case sending(Int)
    /// Decided here, or closed elsewhere (answered already, withdrawn, expired): the buttons go.
    case done(text: String, isError: Bool)
    /// Not answered (no network, a refusal): the buttons stay for another try.
    case failed(String)
}

/// Pure state machine for the approval card: one press at a time, and no second answer once one took.
struct ApprovalFlow: Equatable, Sendable {
    private(set) var phase: ApprovalPhase = .idle

    var isBusy: Bool {
        if case .sending = phase { return true }
        return false
    }

    /// The option buttons show until the request is decided or closed.
    var showsButtons: Bool {
        if case .done = phase { return false }
        return true
    }

    var sending: Int? {
        if case .sending(let n) = phase { return n }
        return nil
    }

    /// The option to send, or nil while one is on its way or after the request was decided.
    mutating func press(_ n: Int) -> Int? {
        switch phase {
        case .sending, .done: return nil
        case .idle, .failed:
            phase = .sending(n)
            return n
        }
    }

    /// What the press came to: a decision or a closed request ends the card, an error leaves it to try again.
    mutating func finished(_ result: Result<ApprovalAnswerResult, Error>, botName: String?) {
        guard case .sending = phase else { return }
        let o = ApprovalFormat.outcome(result, botName: botName)
        switch result {
        case .success: phase = .done(text: o.text, isError: o.isError)
        case .failure: phase = .failed(o.text)
        }
    }
}
