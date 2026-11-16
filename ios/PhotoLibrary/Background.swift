import BackgroundTasks
import UIKit

// The app loads this library at startup; see src-tauri/src/background.rs. Everything here runs
// on the main queue.

/// A call back into the Rust core.
public typealias Signal = @convention(c) () -> Void
/// Starts a pass of the core; true for a processing task, which may run for minutes.
public typealias Launched = @convention(c) (Bool) -> Void

private let refreshIdentifier = "app.gooncave.ios.refresh"
private let processingIdentifier = "app.gooncave.ios.processing"
private let continuedPrefix = "app.gooncave.ios.continued."
private let refreshDelay: TimeInterval = 15 * 60
private let processingDelay: TimeInterval = 60 * 60

/// The tasks iOS launched whose pass has not finished. One pass serves them all.
private var launchedTasks: [BGTask] = []
/// The continued task of the sync on screen, once iOS has started it.
private var continuedTask: BGTask?
/// Stops the sync in the Rust core when the person or iOS ends the continued task.
private var continuedStopped: Signal?
/// The identifier of the continued task the sync on screen asked for.
private var continuedIdentifier: String?
/// The time iOS gives to upload the last changes after the app leaves the screen.
private var uploadTask: UIBackgroundTaskIdentifier = .invalid

private func endUpload() {
    guard uploadTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(uploadTask)
    uploadTask = .invalid
}

private func scheduleBackgroundTasks() {
    let refresh = BGAppRefreshTaskRequest(identifier: refreshIdentifier)
    refresh.earliestBeginDate = Date(timeIntervalSinceNow: refreshDelay)
    let processing = BGProcessingTaskRequest(identifier: processingIdentifier)
    processing.earliestBeginDate = Date(timeIntervalSinceNow: processingDelay)
    processing.requiresNetworkConnectivity = true
    // On power iOS runs it most nights and for minutes; on battery it rarely runs at all.
    processing.requiresExternalPower = true
    for request in [refresh, processing] as [BGTaskRequest] {
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            NSLog("[developer] Cannot schedule %@: %@", request.identifier, error.localizedDescription)
        }
    }
}

private func complete(_ tasks: [BGTask], success: Bool) {
    tasks.forEach { $0.setTaskCompleted(success: success) }
    scheduleBackgroundTasks()
}

/// Registers what iOS runs for the refresh and processing tasks, and schedules them whenever the
/// app goes to the background. iOS needs this before the app finishes launching. `launched` runs a
/// pass of the core, `expired` drops it (a sync it started resumes at the next wake), `cancelled` stops the sync a continued task shows,
/// `left` uploads the last changes when the app leaves the screen.
@_cdecl("gooncave_background_register")
public func backgroundRegister(_ launched: Launched, _ expired: Signal, _ cancelled: Signal, _ left: Signal) {
    for identifier in [refreshIdentifier, processingIdentifier] {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            launchedTasks.append(task)
            task.expirationHandler = {
                expired()
                let tasks = launchedTasks
                launchedTasks = []
                complete(tasks, success: false)
            }
            launched(task is BGProcessingTask)
        }
    }
    NotificationCenter.default.addObserver(
        forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
    ) { _ in
        scheduleBackgroundTasks()
        endUpload()
        uploadTask = UIApplication.shared.beginBackgroundTask(withName: "Upload changes", expirationHandler: endUpload)
        left()
    }
    continuedStopped = cancelled
}

/// The pass ended: tells iOS the launched tasks are done and schedules the next ones.
@_cdecl("gooncave_background_finish")
public func backgroundFinish(_ success: Bool) {
    DispatchQueue.main.async {
        let tasks = launchedTasks
        launchedTasks = []
        complete(tasks, success: success)
    }
}

/// The last changes are uploaded, or there were none: gives the time back to iOS.
@_cdecl("gooncave_background_uploaded")
public func backgroundUploaded() {
    DispatchQueue.main.async { endUpload() }
}

/// Asks iOS 26 to let the favorites sync that just started go on after the person leaves the app,
/// with its own progress on the Lock Screen and a Stop button. Before iOS 26 it does nothing.
@_cdecl("gooncave_continued_begin")
public func continuedBegin(_ title: UnsafePointer<CChar>, _ subtitle: UnsafePointer<CChar>) {
    let title = String(cString: title)
    let subtitle = String(cString: subtitle)
    DispatchQueue.main.async {
        guard #available(iOS 26.0, *) else { return }
        let identifier = continuedPrefix + UUID().uuidString
        continuedIdentifier = identifier
        continuedTask = nil
        // iOS reports that a wildcard in the permitted identifiers does not match here, so the
        // exact name is registered before it is submitted.
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            // The sync ended while the request waited: nothing is left to run.
            guard continuedIdentifier == identifier else { return task.setTaskCompleted(success: true) }
            task.expirationHandler = {
                continuedStopped?()
                task.setTaskCompleted(success: false)
                continuedTask = nil
            }
            continuedTask = task
        }
        let request = BGContinuedProcessingTaskRequest(identifier: identifier, title: title, subtitle: subtitle)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            NSLog("[developer] Cannot continue the favorites sync in the background: %@", error.localizedDescription)
        }
    }
}

/// Shows how far the sync is. `total` grows while the sync reads pages.
@_cdecl("gooncave_continued_progress")
public func continuedProgress(_ done: UInt64, _ total: UInt64) {
    DispatchQueue.main.async {
        guard #available(iOS 26.0, *), let task = continuedTask as? BGContinuedProcessingTask else { return }
        let total = max(Int64(clamping: total), 1)
        task.progress.totalUnitCount = total
        task.progress.completedUnitCount = min(Int64(clamping: done), total)
    }
}

/// The sync ended: closes the continued task, or drops the request that never started.
@_cdecl("gooncave_continued_end")
public func continuedEnd(_ success: Bool) {
    DispatchQueue.main.async {
        guard #available(iOS 26.0, *), let identifier = continuedIdentifier else { return }
        continuedIdentifier = nil
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
        continuedTask?.setTaskCompleted(success: success)
        continuedTask = nil
    }
}
