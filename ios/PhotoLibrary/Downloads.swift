import Foundation
import Network
import UIKit

// The app loads this library at startup; see src-tauri/src/transfers.rs. The system downloads the
// originals the core asks for, also while the app is suspended or locked, and relaunches the app
// in the background when they finish.

/// Reports how a download ended: its key, then 0 (the file is at the path given), 1 (the iPhone is
/// full), 2 (it failed, with the reason given) or 3 (it was cancelled), then the path or reason.
public typealias TransferFinished = @convention(c) (UnsafePointer<CChar>, Int32, UnsafePointer<CChar>) -> Void
/// Reports the key of a download the system still has from an earlier launch.
public typealias TransferKnown = @convention(c) (UnsafePointer<CChar>) -> Void

private let sessionIdentifier = "app.gooncave.ios.downloads"
/// Where each download goes is kept apart from the system's copy of the request, which could
/// otherwise outlive the app's library folder. Credentials are never stored here.
private let destinationPrefix = "download.destination."

private var reportFinished: TransferFinished?
private var session: URLSession?
private let delegateQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    return queue
}()
/// The downloads whose file was reported, so their end without an error is not reported twice.
/// Used on `delegateQueue` only.
private var reported = Set<String>()
/// Keeps the app running while the core installs a file, by key. Used on the main queue only.
private var holds: [String: UIBackgroundTaskIdentifier] = [:]

private func isFull(_ error: Error) -> Bool {
    let error = error as NSError
    if error.domain == NSPOSIXErrorDomain && error.code == Int(ENOSPC) { return true }
    if error.domain == NSCocoaErrorDomain && error.code == CocoaError.fileWriteOutOfSpace.rawValue { return true }
    if let underlying = error.userInfo[NSUnderlyingErrorKey] as? Error { return isFull(underlying) }
    return false
}

private func endHold(_ key: String) {
    if let hold = holds.removeValue(forKey: key) {
        UIApplication.shared.endBackgroundTask(hold)
    }
}

/// Tells the core how a download ended and keeps the app alive until it has installed the file.
private func report(_ key: String, _ status: Int32, _ detail: String) {
    let hold = {
        holds[key] = UIApplication.shared.beginBackgroundTask(withName: "Install download") { endHold(key) }
    }
    if Thread.isMainThread { hold() } else { DispatchQueue.main.sync(execute: hold) }
    key.withCString { key in
        detail.withCString { detail in reportFinished?(key, status, detail) }
    }
}

private final class DownloadDelegate: NSObject, URLSessionDownloadDelegate {
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let key = downloadTask.taskDescription else { return }
        reported.insert(key)
        let stored = destinationPrefix + key
        defer { UserDefaults.standard.removeObject(forKey: stored) }
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            return report(key, 2, "The server answered \(status).")
        }
        guard let path = UserDefaults.standard.string(forKey: stored) else {
            return report(key, 2, "The download lost track of where its file goes.")
        }
        // The system deletes its copy when this method returns, so the file moves now.
        do {
            let destination = URL(fileURLWithPath: path)
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: location, to: destination)
            report(key, 0, path)
        } catch {
            report(key, isFull(error) ? 1 : 2, error.localizedDescription)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let key = task.taskDescription else { return }
        if reported.remove(key) != nil { return }
        UserDefaults.standard.removeObject(forKey: destinationPrefix + key)
        guard let error = error else { return }
        let failure = error as NSError
        if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled {
            report(key, 3, "")
        } else {
            report(key, isFull(error) ? 1 : 2, error.localizedDescription)
        }
    }

    /// The folder's login goes only to the host it was made for. The core's own downloads refuse
    /// redirects into the local network, which this session cannot check by address, so a redirect
    /// to another host must be HTTPS to a name; a refused one ends as a non-2xx answer.
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard let host = request.url?.host, host != task.originalRequest?.url?.host else {
            return completionHandler(request)
        }
        let isAddress = IPv4Address(host) != nil || IPv6Address(host) != nil || host.contains(":")
        guard request.url?.scheme == "https", !isAddress, host != "localhost", !host.hasSuffix(".local") else {
            NSLog("[developer] A background download redirect to another host was refused")
            return completionHandler(nil)
        }
        var next = request
        next.setValue(nil, forHTTPHeaderField: "Authorization")
        completionHandler(next)
    }
}

private let downloadDelegate = DownloadDelegate()

/// Creates the session, which reconnects to the downloads the system kept from an earlier launch
/// and delivers the ones that finished meanwhile. `finished` reports each end; `known` reports the
/// key of each download still running. Apple relaunches the app for these events and the session
/// created here, with the same identifier, receives them. Tauri owns the app delegate, so
/// `application(_:handleEventsForBackgroundURLSession:)` is not reachable and its completion
/// handler is never called; `report` holds a background task until the core installs the file.
@_cdecl("gooncave_transfers_register")
public func transfersRegister(_ finished: @escaping TransferFinished, _ known: @escaping TransferKnown) {
    reportFinished = finished
    let configuration = URLSessionConfiguration.background(withIdentifier: sessionIdentifier)
    configuration.sessionSendsLaunchEvents = true
    configuration.isDiscretionary = false
    let created = URLSession(configuration: configuration, delegate: downloadDelegate, delegateQueue: delegateQueue)
    session = created
    created.getAllTasks { tasks in
        for key in tasks.compactMap({ $0.taskDescription }) {
            key.withCString { known($0) }
        }
    }
}

/// Starts downloading `url` and moves the file to `destination`. `headers` is one `Name: value`
/// per line. A download with the same key that is already running is left alone.
@_cdecl("gooncave_transfers_enqueue")
public func transfersEnqueue(
    _ key: UnsafePointer<CChar>, _ url: UnsafePointer<CChar>, _ headers: UnsafePointer<CChar>,
    _ destination: UnsafePointer<CChar>
) {
    let key = String(cString: key)
    let destination = String(cString: destination)
    let headers = String(cString: headers)
    guard let session = session, let address = URL(string: String(cString: url)) else {
        return report(key, 2, "The download address is not valid.")
    }
    session.getAllTasks { tasks in
        if tasks.contains(where: { $0.taskDescription == key }) { return }
        var request = URLRequest(url: address)
        for line in headers.split(separator: "\n") {
            guard let colon = line.range(of: ": ") else { continue }
            request.setValue(String(line[colon.upperBound...]), forHTTPHeaderField: String(line[..<colon.lowerBound]))
        }
        UserDefaults.standard.set(destination, forKey: destinationPrefix + key)
        // The task description is kept by the system, so it holds the key only, never the login.
        let task = session.downloadTask(with: request)
        task.taskDescription = key
        task.resume()
    }
}

@_cdecl("gooncave_transfers_cancel")
public func transfersCancel(_ key: UnsafePointer<CChar>) {
    let key = String(cString: key)
    session?.getAllTasks { tasks in
        tasks.filter { $0.taskDescription == key }.forEach { $0.cancel() }
    }
}

/// The core installed the file of `key`, or could not: the app may be suspended again.
@_cdecl("gooncave_transfers_installed")
public func transfersInstalled(_ key: UnsafePointer<CChar>) {
    let key = String(cString: key)
    DispatchQueue.main.async { endHold(key) }
}
