import CryptoKit
import LocalAuthentication
import Security
import UIKit

// The app lock of Settings → Extra; see src-tauri/src/lock.rs. The code never leaves this file:
// the Keychain keeps a salted hash of it, on this device only.

private let keychainService = "app.gooncave.lock"
private let keychainAccount = "code"
private let failuresKey = "GoonCaveLockFailures"
private let waitUntilKey = "GoonCaveLockWaitUntil"
/// Wrong codes allowed in a row before each further try waits.
private let freeTries = 5
private let waitSeconds: TimeInterval = 60
/// The web page draws its lock screen once it is back on screen; until then the cover stays.
private let uncoverDelay: TimeInterval = 0.35

private struct Stored: Codable {
    let salt: Data
    let hash: Data
}

private func digest(_ code: String, _ salt: Data) -> Data {
    Data(SHA256.hash(data: salt + Data(code.utf8)))
}

private func keychainQuery() -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: keychainService,
        kSecAttrAccount as String: keychainAccount,
    ]
}

private func readStored() -> Stored? {
    var query = keychainQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else {
        return nil
    }
    return try? JSONDecoder().decode(Stored.self, from: data)
}

private func writeStored(_ stored: Stored) -> OSStatus {
    SecItemDelete(keychainQuery() as CFDictionary)
    guard let data = try? JSONEncoder().encode(stored) else { return errSecParam }
    var item = keychainQuery()
    item[kSecValueData as String] = data
    // Not in backups and not on other devices: the lock belongs to this iPhone.
    item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    return SecItemAdd(item as CFDictionary, nil)
}

private func resetFailures() {
    UserDefaults.standard.removeObject(forKey: failuresKey)
    UserDefaults.standard.removeObject(forKey: waitUntilKey)
}

private func remainingWait() -> Int {
    let until = UserDefaults.standard.double(forKey: waitUntilKey)
    return max(0, Int((until - Date().timeIntervalSince1970).rounded(.up)))
}

private func biometry() -> String {
    let context = LAContext()
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else { return "none" }
    switch context.biometryType {
    case .faceID: return "faceID"
    case .touchID: return "touchID"
    default: return "none"
    }
}

/// Covers the window while the app is not active, so the app switcher shows no content.
private final class Cover {
    static let shared = Cover()
    private var view: UIView?

    private init() {
        let center = NotificationCenter.default
        center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            Cover.shared.show()
        }
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + uncoverDelay) { Cover.shared.hide() }
        }
    }

    func show() {
        guard view == nil, readStored() != nil else { return }
        let window = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
        guard let window else { return }
        let cover = UIView(frame: window.bounds)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.backgroundColor = .systemBackground
        window.addSubview(cover)
        view = cover
    }

    func hide() {
        // Back in the background before the delay ran out: keep covering.
        guard UIApplication.shared.applicationState == .active else { return }
        view?.removeFromSuperview()
        view = nil
    }
}

private func lockReply(_ done: Done, _ context: UnsafeMutableRawPointer?, _ value: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: value)) ?? Data(#"{"error":"No answer."}"#.utf8)
    String(decoding: data, as: UTF8.self).withCString { done(context, $0) }
}

/// One entry point for the lock, so an older app finds it missing as a whole. `request` is
/// `{"action", "code"?}`:
/// - `state`: `{"enabled", "biometry": "faceID" | "touchID" | "none", "wait"}`
/// - `set` with a code: `{"enabled": true}`
/// - `check` with a code: `{"ok", "wait"}`; `wait` counts the seconds before the next try
/// - `clear`: `{"enabled": false}`
/// - `biometric`: `{"ok"}`, with `"fallback": true` when the person chose the code
/// Any of them may answer `{"error"}`.
@_cdecl("gooncave_lock")
public func appLock(_ request: UnsafePointer<CChar>, _ done: Done, _ context: UnsafeMutableRawPointer?) {
    let fields = (try? JSONSerialization.jsonObject(with: Data(String(cString: request).utf8))) as? [String: Any] ?? [:]
    let code = fields["code"] as? String ?? ""
    DispatchQueue.main.async {
        _ = Cover.shared
        switch fields["action"] as? String {
        case "state":
            lockReply(done, context, ["enabled": readStored() != nil, "biometry": biometry(), "wait": remainingWait()])
        case "set":
            var salt = Data(count: 16)
            let random = salt.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
            guard random == errSecSuccess else {
                return lockReply(done, context, ["error": "The iPhone could not make a secure code. Try again."])
            }
            let status = writeStored(Stored(salt: salt, hash: digest(code, salt)))
            guard status == errSecSuccess else {
                return lockReply(done, context, ["error": "The Keychain did not keep the code (error \(status))."])
            }
            resetFailures()
            lockReply(done, context, ["enabled": true])
        case "check":
            let wait = remainingWait()
            guard wait == 0 else { return lockReply(done, context, ["ok": false, "wait": wait]) }
            guard let stored = readStored() else {
                return lockReply(done, context, ["error": "The lock has no code. Turn it off and on again."])
            }
            if digest(code, stored.salt) == stored.hash {
                resetFailures()
                return lockReply(done, context, ["ok": true, "wait": 0])
            }
            let failures = UserDefaults.standard.integer(forKey: failuresKey) + 1
            UserDefaults.standard.set(failures, forKey: failuresKey)
            if failures >= freeTries {
                UserDefaults.standard.set(Date().timeIntervalSince1970 + waitSeconds, forKey: waitUntilKey)
            }
            lockReply(done, context, ["ok": false, "wait": remainingWait()])
        case "clear":
            SecItemDelete(keychainQuery() as CFDictionary)
            resetFailures()
            lockReply(done, context, ["enabled": false])
        case "biometric":
            let authentication = LAContext()
            authentication.localizedFallbackTitle = "Use code"
            authentication.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Unlock GoonCave") { ok, error in
                if ok {
                    DispatchQueue.main.async { resetFailures() }
                    return lockReply(done, context, ["ok": true])
                }
                let fallback = (error as? LAError)?.code == .userFallback
                lockReply(done, context, ["ok": false, "fallback": fallback])
            }
        default:
            lockReply(done, context, ["error": "The lock does not know this request."])
        }
    }
}
