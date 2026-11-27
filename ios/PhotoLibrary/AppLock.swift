import CommonCrypto
import LocalAuthentication
import Security
import UIKit

// The app lock of Settings → Extra; see src-tauri/src/lock.rs. The code never leaves this file:
// the Keychain keeps a salted hash of it, on this device only.

private let keychainService = "app.gooncave.lock"
private let keychainAccount = "code"
private let failuresKey = "GoonCaveLockFailures"
/// Not secret: lets the cover know the lock is on when the Keychain cannot be read, as while the
/// phone locks.
private let enabledKey = "GoonCaveLockEnabled"
/// Whether Face ID unlocks; absent until the first `state` of a version with separate locks.
private let faceKey = "GoonCaveLockFaceID"
private let waitUntilKey = "GoonCaveLockWaitUntil"
/// Wrong codes allowed in a row before each further try waits.
private let freeTries = 5
private let waitSeconds: TimeInterval = 60
/// The web page draws its lock screen once it is back on screen; until then the cover stays.
private let uncoverDelay: TimeInterval = 0.35
/// Turning the lock off or changing the code needs Face ID or the code this recently.
private let unlockValidity: TimeInterval = 120
private let hashRounds: UInt32 = 100_000

/// When Face ID or the code last unlocked, and when Face ID last worked; main queue only.
private var unlockedAt: Date?
private var faceWorkedAt: Date?

private func recentlyUnlocked() -> Bool {
    unlockedAt.map { Date().timeIntervalSince($0) < unlockValidity } ?? false
}

private func faceRecentlyWorked() -> Bool {
    faceWorkedAt.map { Date().timeIntervalSince($0) < unlockValidity } ?? false
}

private struct Stored: Codable {
    let salt: Data
    let hash: Data
}

/// PBKDF2: a short code must cost real time to guess even from a copy of the Keychain item.
private func digest(_ code: String, _ salt: Data) -> Data {
    var hash = Data(count: 32)
    let password = Array(code.utf8).map { CChar(bitPattern: $0) }
    let status = hash.withUnsafeMutableBytes { output in
        salt.withUnsafeBytes { saltBytes in
            CCKeyDerivationPBKDF(
                CCPBKDFAlgorithm(kCCPBKDF2), password, password.count,
                saltBytes.bindMemory(to: UInt8.self).baseAddress, salt.count,
                CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), hashRounds,
                output.bindMemory(to: UInt8.self).baseAddress, 32)
        }
    }
    // Empty on failure: `set` refuses to store it and `check` never matches it.
    return Int(status) == kCCSuccess ? hash : Data()
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

private func faceLock() -> Bool {
    UserDefaults.standard.bool(forKey: faceKey)
}

private func anyLock() -> Bool {
    faceLock() || readStored() != nil
}

private func remainingWait() -> Int {
    let until = UserDefaults.standard.double(forKey: waitUntilKey)
    return max(0, Int((until - Date().timeIntervalSince1970).rounded(.up)))
}

/// The name the person knows, also while Face ID cannot be used.
private func biometryLabel() -> String {
    let context = LAContext()
    var error: NSError?
    _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    return context.biometryType == .touchID ? "Touch ID" : "Face ID"
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
        guard view == nil, UserDefaults.standard.bool(forKey: enabledKey) else { return }
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

/// One entry point for the lock, so an older app finds it missing as a whole. `request` is
/// `{"action", "code"?}`:
/// - `state`: `{"code", "face", "biometry": "faceID" | "touchID" | "none", "wait"}`
/// - `set` with a code: `{"code": true}`
/// - `check` with a code: `{"ok", "wait"}`; `wait` counts the seconds before the next try
/// - `clear`: `{"code": false}`
/// - `faceOn`, `faceOff`: `{"face"}`
/// - `biometric`: `{"ok"}`, with `"fallback": true` when the person chose the code
/// Changing a lock while one is on needs Face ID or the code in the last two minutes.
/// Any of them may answer `{"error"}`.
@_cdecl("gooncave_lock")
public func appLock(_ request: UnsafePointer<CChar>, _ done: Done, _ context: UnsafeMutableRawPointer?) {
    let fields = (try? JSONSerialization.jsonObject(with: Data(String(cString: request).utf8))) as? [String: Any] ?? [:]
    let code = fields["code"] as? String ?? ""
    DispatchQueue.main.async {
        _ = Cover.shared
        switch fields["action"] as? String {
        case "state":
            let code = readStored() != nil
            // Before Face ID and the code were separate, Face ID always unlocked a code lock.
            if UserDefaults.standard.object(forKey: faceKey) == nil {
                UserDefaults.standard.set(code && biometry() != "none", forKey: faceKey)
            }
            // Keeps the cover's flag right after an update from a version without it.
            UserDefaults.standard.set(code || faceLock(), forKey: enabledKey)
            reply(done, context, ["code": code, "face": faceLock(), "biometry": biometry(), "wait": remainingWait()])
        case "set":
            guard !anyLock() || recentlyUnlocked() else {
                return reply(done, context, ["error": "Unlock with Face ID or the code before changing it."])
            }
            var salt = Data(count: 16)
            let random = salt.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
            guard random == errSecSuccess else {
                return reply(done, context, ["error": "The iPhone could not make a secure code. Try again."])
            }
            let hash = digest(code, salt)
            guard !hash.isEmpty else {
                return reply(done, context, ["error": "The iPhone could not secure the code. Try again."])
            }
            let status = writeStored(Stored(salt: salt, hash: hash))
            guard status == errSecSuccess else {
                return reply(done, context, ["error": "The Keychain did not keep the code (error \(status))."])
            }
            resetFailures()
            UserDefaults.standard.set(true, forKey: enabledKey)
            reply(done, context, ["code": true])
        case "check":
            let wait = remainingWait()
            guard wait == 0 else { return reply(done, context, ["ok": false, "wait": wait]) }
            guard let stored = readStored() else {
                return reply(done, context, ["error": "The lock has no code. Turn it off and on again."])
            }
            let hash = digest(code, stored.salt)
            if !hash.isEmpty, hash == stored.hash {
                resetFailures()
                unlockedAt = Date()
                return reply(done, context, ["ok": true, "wait": 0])
            }
            let failures = UserDefaults.standard.integer(forKey: failuresKey) + 1
            UserDefaults.standard.set(failures, forKey: failuresKey)
            if failures >= freeTries {
                UserDefaults.standard.set(Date().timeIntervalSince1970 + waitSeconds, forKey: waitUntilKey)
            }
            reply(done, context, ["ok": false, "wait": remainingWait()])
        case "clear":
            guard !anyLock() || recentlyUnlocked() else {
                return reply(done, context, ["error": "Unlock with Face ID or the code before turning the lock off."])
            }
            SecItemDelete(keychainQuery() as CFDictionary)
            UserDefaults.standard.set(faceLock(), forKey: enabledKey)
            unlockedAt = nil
            resetFailures()
            reply(done, context, ["code": false])
        case "faceOn", "faceOff":
            let on = fields["action"] as? String == "faceOn"
            // Turning it on needs a Face ID that just worked, so the lock cannot shut the person out.
            guard (!on || faceRecentlyWorked()) && (!anyLock() || recentlyUnlocked()) else {
                return reply(done, context, ["error": "Unlock with Face ID or the code before changing the lock."])
            }
            UserDefaults.standard.set(on, forKey: faceKey)
            if !on { unlockedAt = nil }
            UserDefaults.standard.set(on || readStored() != nil, forKey: enabledKey)
            reply(done, context, ["face": on])
        case "biometric":
            let authentication = LAContext()
            // Without a code lock there is nothing to fall back to: Face ID alone unlocks.
            authentication.localizedFallbackTitle = readStored() == nil ? "" : "Use code"
            // With only the code on, Face ID unlocks nothing until the code has just been entered.
            let counts = faceLock() || readStored() == nil || recentlyUnlocked()
            authentication.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Unlock GoonCave") { ok, error in
                if ok {
                    // On the main queue before the answer, so a `clear` that follows finds it.
                    return DispatchQueue.main.async {
                        faceWorkedAt = Date()
                        guard counts else { return reply(done, context, ["ok": false]) }
                        resetFailures()
                        unlockedAt = Date()
                        reply(done, context, ["ok": true])
                    }
                }
                switch (error as? LAError)?.code {
                case .userFallback:
                    reply(done, context, ["ok": false, "fallback": true])
                case .biometryLockout:
                    reply(done, context, ["error": "\(biometryLabel()) is paused after too many tries. Lock the iPhone, unlock it with its code, then try again."])
                case .biometryNotAvailable, .biometryNotEnrolled:
                    reply(done, context, ["error": "\(biometryLabel()) is off for GoonCave. Turn it on in iOS Settings → GoonCave."])
                default:
                    reply(done, context, ["ok": false, "fallback": false])
                }
            }
        default:
            reply(done, context, ["error": "The lock does not know this request."])
        }
    }
}
