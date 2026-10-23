import Foundation

// Logic tests of the manager slice.
extension Suites {
    static var managerSuites: [(String, () async throws -> Void)] { [("manager", manager)] }

    static func manager() throws {
        // redaction
        for k in ["token", "gatewayToken", "dashboard.secretHint", "PASSWORD", "apiKey", "auth.header", "Set-Cookie"] {
            expect(ManagerRedaction.isSensitive(key: k), "sensitive \(k)")
        }
        for k in ["model", "unit.active", "gateway.url", "cost.todayUsd"] {
            expect(!ManagerRedaction.isSensitive(key: k), "not sensitive \(k)")
        }

        // status
        let json = try decode(JSONValue.self, """
        {"configured":true,"unit":{"name":"openclaw-manager","active":"active","pid":42,"restarts":0},
         "gateway":{"url":"http://127.0.0.1:18789","up":true},
         "model":{"primary":"m1","fallbacks":["a"],"thinking":"low","heartbeatEvery":"30m"},
         "automations":{"jobs":[{"id":"x"}],"lastRunAt":null},
         "cost":{"todayUsd":1.5,"budgetUsd":10,"paused":false,"cacheStatus":"fresh"},
         "wal24h":{"notes":2,"last":"2026-10-11T18:00:00Z"},
         "dashboard":{"forward":"ssh -L","secretHint":"run gateway auth-token --show"},
         "gatewayToken":"abc123"}
        """)
        let s = ManagerStatus.parse(json)
        expect(s.isUp == true && s.unitState == "active" && s.model == "m1", "status basics")
        expect(s.thinking == "low" && s.heartbeatEvery == "30m", "status model fields")
        expect(s.costLine == "$1.50 of $10.00 today" && s.pausedByBudget == false, "cost line \(s.costLine ?? "nil")")
        expect(s.lastActivity != nil, "last activity")
        let keys = s.details.map(\.key)
        expect(keys.contains("unit.pid") && keys.contains("cost.cacheStatus"), "details keep scalars \(keys)")
        expect(!keys.contains("dashboard.secretHint") && !keys.contains("gatewayToken"), "details redacted \(keys)")
        expect(!keys.contains("model.primary") && !keys.contains("gateway.up"), "shown keys not repeated")
        expect(!s.details.contains { $0.value.contains("abc123") }, "token value absent")

        let empty = ManagerStatus.parse(.object([:]))
        expect(empty.isUp == nil && empty.costLine == nil && empty.details.isEmpty, "empty status")
        let weird = ManagerStatus.parse(.array([]))
        expect(weird.isUp == nil, "non object status")
        let mock = ManagerStatus.parse(.object(["gateway": .object(["up": .bool(true)]), "model": .string("demo-model"),
                                                "unit": .object(["state": .string("active")])]))
        expect(mock.model == "demo-model" && mock.unitState == "active", "string model and unit.state")
        let down = ManagerStatus.parse(.object(["unit": .object(["active": .string("inactive")])]))
        expect(down.isUp == false, "unit inactive means down")
        let off = ManagerStatus.parse(.object(["configured": .bool(false), "reason": .string("no config")]))
        expect(off.configured == false && off.reason == "no config", "unconfigured")

        // feed
        let feed = ManagerFeedEvent.parse(.array([
            .object(["id": .string("a"), "ts": .string("2026-10-11T10:00:00Z"), "type": .string("note"), "text": .string("old")]),
            .object(["id": .string("b"), "ts": .string("2026-10-11T11:00:00Z"), "type": .string("chat"), "actor": .string("manager"), "text": .string("new")]),
            .string("junk"),
            .object(["ts": .string("2026-10-11T12:00:00Z")]),
        ]))
        expect(feed.map(\.id) == ["b", "a"], "feed newest first \(feed.map(\.id))")
        expect(feed.first?.actor == "manager", "feed actor")
        let wrapped = ManagerFeedEvent.parse(.object(["items": .array([.object(["text": .string("x")])])]))
        expect(wrapped.count == 1 && wrapped[0].type == "event", "wrapped feed")
        expect(ManagerFeedEvent.parse(.null).isEmpty, "null feed")

        // messages
        let msgs = ManagerMessage.messages(from: [
            Turn(role: "user", uuid: "1", text: " hi "), Turn(role: "tool_result", text: "x"),
            Turn(role: "assistant", uuid: "2", text: "**ok**"), Turn(role: "assistant", uuid: "3", text: "  "),
        ])
        expect(msgs.map(\.id) == ["1", "2"] && msgs[0].text == "hi", "visible turns")
        expect(msgs[0].accessibilityText == "You: hi" && msgs[1].accessibilityText == "Manager: **ok**", "a11y text")
        expect(String(msgs[1].attributed.characters) == "ok", "markdown rendered")

        // host resolution
        let sessions = [SessionInfo(id: "a", engine: .claude, host: "h1"), SessionInfo(id: "manager", engine: .openclaw, host: "h2")]
        expect(ManagerHostResolver.resolve(setting: "box", sessions: sessions) == "box", "setting wins")
        expect(ManagerHostResolver.resolve(setting: " ", sessions: sessions) == "h2", "openclaw session host")
        expect(ManagerHostResolver.resolve(setting: nil, sessions: [sessions[0]]) == nil, "local fallback")
        expect(ManagerHostResolver.isNotFound(DroverError.http(404)), "404")
        expect(ManagerHostResolver.isNotFound(DroverError.server("session not found: manager")), "not found text")
        expect(!ManagerHostResolver.isNotFound(DroverError.unauthorized), "unauthorized is not not-found")

        // settings logic
        expect(SettingsConnectionTest.outcome(hostCount: 2, sessionsError: nil).text == "Connected: 2 hosts. Main token works.", "main ok")
        let ro = SettingsConnectionTest.outcome(hostCount: 1, sessionsError: DroverError.forbidden)
        expect(ro.ok && ro.text == "Connected: 1 host. Read-only token (widget scope).", "read only \(ro.text)")
        let bad = SettingsConnectionTest.outcome(hostCount: 1, sessionsError: DroverError.http(500))
        expect(!bad.ok && bad.text.contains("HTTP 500"), "sessions failure")
        expect(!SettingsConnectionTest.failure(DroverError.unauthorized).ok, "failure not ok")
        expect(SettingsNotificationKind.all.count == 7 && SettingsNotificationKind.all[0].id == "decision", "kind catalog")
        let muted = SettingsNotificationKind.updated([], kind: "mr", enabled: false)
        expect(muted == ["mr"] && !SettingsNotificationKind.isEnabled("mr", muted: muted), "mute")
        expect(SettingsNotificationKind.updated(muted, kind: "mr", enabled: true).isEmpty, "unmute")
    }
}
