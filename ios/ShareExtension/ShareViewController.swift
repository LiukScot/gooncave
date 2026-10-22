import UIKit
import UniformTypeIdentifiers

// Same group as `APP_GROUP` in src-tauri/src/share.rs.
private let appGroup = "group.app.gooncave.ios"
// Same folder as `INBOX` in src-tauri/src/share.rs.
private let inboxName = "Inbox"

/// Copies the pictures, videos and files shared from another app into the folder the app
/// shares with this extension. The app adds them to the library the next time it opens.
@objc(ShareViewController)
final class ShareViewController: UIViewController {
    private let message = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        message.numberOfLines = 0
        message.textAlignment = .center
        message.textColor = .label
        message.font = .preferredFont(forTextStyle: .headline)
        message.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(message)
        NSLayoutConstraint.activate([
            message.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            message.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            message.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
        ])
        message.text = "Sending to GoonCave…"
        receive()
    }

    private func receive() {
        guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
            return finish("GoonCave cannot receive shared files on this device.", after: 3)
        }
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
        guard !providers.isEmpty else {
            return finish("There is nothing to send to GoonCave.", after: 2)
        }

        let inbox = root.appendingPathComponent(inboxName, isDirectory: true)
        // Written under a dot name and renamed when complete, so the app never reads half a batch.
        let staging = inbox.appendingPathComponent(".\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        } catch {
            return finish("GoonCave could not save the files: \(error.localizedDescription)", after: 3)
        }

        let lock = NSLock()
        var failed = 0
        let copies = DispatchGroup()
        for (index, provider) in providers.enumerated() {
            guard let type = Self.type(of: provider) else {
                failed += 1
                continue
            }
            copies.enter()
            provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                defer { copies.leave() }
                // The system deletes `url` when this closure returns, so the copy happens here.
                // One folder per item keeps two files with the same name apart.
                let saved = Result {
                    guard let url else { throw error ?? CocoaError(.fileReadUnknown) }
                    let folder = staging.appendingPathComponent(String(index), isDirectory: true)
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    try FileManager.default.copyItem(at: url, to: folder.appendingPathComponent(url.lastPathComponent))
                }
                if case .failure = saved {
                    lock.lock()
                    failed += 1
                    lock.unlock()
                }
            }
        }

        copies.notify(queue: .main) {
            let saved = providers.count - failed
            guard saved > 0 else {
                try? FileManager.default.removeItem(at: staging)
                return self.finish("These files could not be sent to GoonCave.", after: 3)
            }
            let batch = inbox.appendingPathComponent(UUID().uuidString, isDirectory: true)
            do {
                try FileManager.default.moveItem(at: staging, to: batch)
            } catch {
                try? FileManager.default.removeItem(at: staging)
                return self.finish("GoonCave could not save the files: \(error.localizedDescription)", after: 3)
            }
            let sent = saved == 1 ? "1 file" : "\(saved) files"
            if failed == 0 {
                self.finish("\(sent) sent. Open GoonCave to add \(saved == 1 ? "it" : "them").", after: 1.5)
            } else {
                self.finish("\(sent) sent. \(failed) could not be sent.", after: 3)
            }
        }
    }

    /// The first form of `provider` that is a picture, a video or any file, in that order.
    private static func type(of provider: NSItemProvider) -> String? {
        let types = provider.registeredTypeIdentifiers.compactMap { id in UTType(id).map { (id, $0) } }
        for kind in [UTType.image, UTType.movie, UTType.data] {
            if let match = types.first(where: { $0.1.conforms(to: kind) }) { return match.0 }
        }
        return nil
    }

    private func finish(_ text: String, after seconds: TimeInterval) {
        message.text = text
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
            self.extensionContext?.completeRequest(returningItems: nil)
        }
    }
}
