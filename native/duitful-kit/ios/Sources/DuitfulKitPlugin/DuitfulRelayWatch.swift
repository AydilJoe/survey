import Foundation
import BackgroundTasks
import CryptoKit
import Security
import UserNotifications

/// "Siti says they paid" while Duitful is closed — the iPhone half of
/// DuitfulRelayWatch.java.
///
/// The app hands over the split bills that still have someone owing
/// (DuitfulKit.relayWatch): each mailbox's id and key, the bill's title and
/// the names. When iOS gives the app background time (a BGAppRefreshTask,
/// asked for every 15 minutes and granted when iOS sees fit), this fetches
/// those mailboxes from /api/relay/, opens the events with the key on the
/// phone, and posts a local notification for each "I've paid" it hasn't
/// seen. Duitful's server still only ever sees mailbox ids and ciphertext.
///
/// The list is kept in the Keychain (this device only, after first unlock),
/// because the check runs without the passcode. It holds only open bills and
/// is deleted when the user turns the notifications off.
///
/// AppDelegate calls register() at launch (injected by scripts/patch-ios.mjs),
/// and Info.plist lists the task id under BGTaskSchedulerPermittedIdentifiers.
public enum DuitfulRelayWatch {
    public static let taskId = "com.aydiljoe.duitful.relay-watch"
    static let service = "com.aydiljoe.duitful.relay-watch"
    static let origin = "https://duitful.app"
    static let seenCap = 400

    struct Box: Codable {
        let id: String
        let key: String
        let ti: String
        let p: [String: String]
    }

    struct State: Codable {
        var boxes: [Box]
        var seen: [String]
    }

    /// Before the end of launch, or iOS refuses the task later.
    public static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskId, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handle(refresh)
        }
    }

    /// Replaces the watch list; empty or off cancels and deletes it.
    static func update(boxes: [Box], seen: [String], on: Bool) {
        guard on, !boxes.isEmpty else {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskId)
            deleteState()
            return
        }
        var merged = load()?.seen ?? []
        for e in seen where !merged.contains(e) { merged.append(e) }
        save(State(boxes: boxes, seen: Array(merged.suffix(seenCap))))
        schedule()
    }

    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: taskId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    static func handle(_ task: BGAppRefreshTask) {
        schedule() // the next one, whatever happens to this one
        let work = Task {
            await check()
            task.setTaskCompleted(success: true)
        }
        task.expirationHandler = { work.cancel() }
    }

    static func check() async {
        guard var state = load(), !state.boxes.isEmpty else { return }
        var seen = state.seen
        var fresh: [(id: String, text: String, title: String)] = []
        for box in state.boxes {
            if Task.isCancelled { break }
            guard box.id.range(of: "^[A-Za-z0-9_-]{16}$", options: .regularExpression) != nil,
                  let url = URL(string: "\(origin)/api/relay/?op=get&id=\(box.id)"),
                  let (data, response) = try? await URLSession.shared.data(from: url),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let events = obj["events"] as? [String] else { continue }
            for sealed in events {
                guard let ev = open(sealed, box: box),
                      ev["t"] as? String == "paid",
                      let eventId = ev["e"] as? String, !eventId.isEmpty,
                      !seen.contains(eventId) else { continue }
                seen.append(eventId)
                guard let personId = ev["id"] as? String, let name = box.p[personId] else { continue }
                let from = (ev["fr"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? name
                let amount = (ev["a"] as? NSNumber)?.doubleValue ?? 0
                fresh.append((id: eventId, text: String(format: "%@ says they paid RM %.2f", from, amount), title: box.ti))
            }
        }
        state.seen = Array(seen.suffix(seenCap))
        save(state)
        for f in fresh { await post(id: f.id, text: f.text, title: f.title) }
    }

    /// Same sealing as app/split.js: iv(12) ‖ ciphertext ‖ tag(16), AES-GCM,
    /// "duitful-relay/1/event/<id>" as associated data.
    static func open(_ text: String, box: Box) -> [String: Any]? {
        guard let all = b64url(text), all.count >= 12 + 16, let key = b64url(box.key), key.count == 16 else { return nil }
        let bytes = [UInt8](all)
        guard let nonce = try? AES.GCM.Nonce(data: Data(bytes[0..<12])),
              let sealedBox = try? AES.GCM.SealedBox(nonce: nonce,
                                                     ciphertext: Data(bytes[12..<(bytes.count - 16)]),
                                                     tag: Data(bytes[(bytes.count - 16)...])),
              let plain = try? AES.GCM.open(sealedBox, using: SymmetricKey(data: key),
                                            authenticating: Data("duitful-relay/1/event/\(box.id)".utf8)) else { return nil }
        return (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any]
    }

    static func post(id: String, text: String, title: String) async {
        let content = UNMutableNotificationContent()
        content.title = text
        content.body = "\(title) · Open Duitful to confirm"
        content.sound = .default
        let request = UNNotificationRequest(identifier: "duitful-split-\(id)", content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }

    static func b64url(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }

    /* ---- Keychain: one item, this device only ---- */

    static func baseQuery() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: "state"]
    }

    static func save(_ state: State) {
        guard let data = try? JSONEncoder().encode(state) else { return }
        let query = baseQuery()
        let attrs: [String: Any] = [kSecValueData as String: data,
                                    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        if SecItemUpdate(query as CFDictionary, attrs as CFDictionary) == errSecItemNotFound {
            SecItemAdd(query.merging(attrs) { $1 } as CFDictionary, nil)
        }
    }

    static func load() -> State? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(State.self, from: data)
    }

    static func deleteState() {
        SecItemDelete(baseQuery() as CFDictionary)
    }
}
