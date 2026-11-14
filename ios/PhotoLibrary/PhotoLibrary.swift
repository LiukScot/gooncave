import Photos
import PhotosUI
import UIKit
import UniformTypeIdentifiers

// The app loads this library at startup and calls the functions below; see
// src-tauri/src/photos.rs. Each answers once by calling `done` with a JSON string.
public typealias Done = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>?) -> Void

/// Keeps the picker's delegate alive while the picker is shown.
private var shown: Picker?

private func reply(_ done: Done, _ context: UnsafeMutableRawPointer?, _ value: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: value)) ?? Data(#"{"error":"No answer."}"#.utf8)
    String(decoding: data, as: UTF8.self).withCString { done(context, $0) }
}

private func topViewController() -> UIViewController? {
    let scene = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .first { $0.activationState == .foregroundActive }
    var top = scene?.windows.first(where: \.isKeyWindow)?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
}

/// Shows the photo picker. Answers `{"files": [{"path", "assetId"?}], "failed": n}`, with no
/// files when the person closes it, or `{"error"}`. Each file is a copy in a folder of its own.
@_cdecl("gooncave_pick_photos")
public func pickPhotos(_ done: Done, _ context: UnsafeMutableRawPointer?) {
    DispatchQueue.main.async {
        guard let top = topViewController() else {
            return reply(done, context, ["error": "GoonCave has no window to show the photo picker in."])
        }
        // `.compatible` turns formats the library cannot read, like HEIC, into JPEG.
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.selectionLimit = 0
        configuration.preferredAssetRepresentationMode = .compatible
        let picker = PHPickerViewController(configuration: configuration)
        let delegate = Picker(done: done, context: context)
        picker.delegate = delegate
        shown = delegate
        top.present(picker, animated: true)
    }
}

/// Deletes the photos with these identifiers, a JSON array of strings, after the system asks the
/// person. Answers `{"deleted": n}` or `{"error"}`.
@_cdecl("gooncave_delete_photos")
public func deletePhotos(_ identifiers: UnsafePointer<CChar>, _ done: Done, _ context: UnsafeMutableRawPointer?) {
    let list = (try? JSONSerialization.jsonObject(with: Data(String(cString: identifiers).utf8))) as? [String] ?? []
    PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
        guard status == .authorized || status == .limited else {
            return reply(done, context, ["error": "GoonCave cannot reach your photos. Allow it in Settings."])
        }
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: list, options: nil)
        let count = assets.count
        PHPhotoLibrary.shared().performChanges({ PHAssetChangeRequest.deleteAssets(assets) }) { deleted, error in
            if deleted {
                reply(done, context, ["deleted": count])
            } else {
                reply(done, context, ["error": error?.localizedDescription ?? "The photos were not deleted."])
            }
        }
    }
}

/// One generator kept prepared, so a tap does not wait for the haptic engine to wake.
private let hapticGenerator = UIImpactFeedbackGenerator(style: .medium)

/// Gives one medium, short tap. Does not answer.
@_cdecl("gooncave_haptic")
public func haptic() {
    DispatchQueue.main.async {
        hapticGenerator.impactOccurred()
        hapticGenerator.prepare()
    }
}

/// Shows the system share sheet with a file (`{"path"}`) or a web address (`{"url"}`). Answers
/// `{"shared": true}` when the person sent it somewhere, `{"shared": false}` when they closed the
/// sheet, or `{"error"}`.
@_cdecl("gooncave_share")
public func share(_ request: UnsafePointer<CChar>, _ done: Done, _ context: UnsafeMutableRawPointer?) {
    let fields = (try? JSONSerialization.jsonObject(with: Data(String(cString: request).utf8))) as? [String: String] ?? [:]
    let item: URL? = fields["path"].map { URL(fileURLWithPath: $0) } ?? fields["url"].flatMap { URL(string: $0) }
    DispatchQueue.main.async {
        guard let item else {
            return reply(done, context, ["error": "There is nothing to share."])
        }
        guard let top = topViewController() else {
            return reply(done, context, ["error": "GoonCave has no window to show the share sheet in."])
        }
        if top.traitCollection.userInterfaceIdiom == .phone {
            presentPhoneShare(from: top, item: item) { reply(done, context, $0) }
        } else {
            presentShareSheet(from: top, item: item) { reply(done, context, $0) }
        }
    }
}

private func presentPhoneShare(from top: UIViewController, item: URL, finish: @escaping ([String: Any]) -> Void) {
    // On iOS 26, the Tauri presenter can clip the activity panel or make it dismiss on touch.
    // Present only after the full-screen UIKit host is visible.
    // See "Sharing from the detail view" in ios/README.md.
    let host = UIViewController()
    host.modalPresentationStyle = .fullScreen
    host.view.backgroundColor = .systemBackground
    // Full-screen presentation removes the live Sources view. Its snapshot keeps the backdrop
    // without putting a second touch target behind the system panel.
    if let backdrop = top.view.snapshotView(afterScreenUpdates: false) {
        backdrop.frame = host.view.bounds
        backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        backdrop.isUserInteractionEnabled = false
        backdrop.accessibilityElementsHidden = true
        host.view.addSubview(backdrop)
    }
    top.present(host, animated: false) {
        presentShareSheet(from: host, item: item) { [weak host] result in
            guard let host else { return finish(result) }
            host.dismiss(animated: false) { finish(result) }
        }
    }
}

private func presentShareSheet(from top: UIViewController, item: URL, finish: @escaping ([String: Any]) -> Void) {
    let sheet = UIActivityViewController(activityItems: [item], applicationActivities: nil)
    let isPad = top.traitCollection.userInterfaceIdiom == .pad
    // On iPhone, configuring the popover can interfere with the system sheet's gestures.
    if isPad {
        sheet.modalPresentationStyle = .popover
        if let popover = sheet.popoverPresentationController {
            let area = top.view.safeAreaLayoutGuide.layoutFrame
            popover.sourceView = top.view
            popover.sourceRect = CGRect(x: area.midX, y: area.midY, width: 1, height: 1)
            popover.permittedArrowDirections = []
        }
    }
    let presenterWindow = top.view.window
    var layout = "\(type(of: top)), " + (isPad ? "iPad popover" : "default iPhone presentation")
    var answered = false
    sheet.completionWithItemsHandler = { _, completed, _, error in
        // The core waits for one answer only.
        guard !answered else { return }
        answered = true
        if let error {
            finish(["error": error.localizedDescription])
        } else {
            finish(["shared": completed, "layout": layout])
        }
    }
    top.present(sheet, animated: true) {
        if let presentation = sheet.presentationController {
            layout += ", presentation \(type(of: presentation)), style \(presentation.presentationStyle.rawValue)"
        }
        if let window = sheet.view.window {
            layout += ", panel in window \(sheet.view.convert(sheet.view.bounds, to: window)), panel window \(window.bounds), same window as presenter \(window === presenterWindow)"
        } else {
            layout += ", panel is outside the window hierarchy"
        }
    }
}

private final class Picker: NSObject, PHPickerViewControllerDelegate {
    private let done: Done
    private let context: UnsafeMutableRawPointer?

    init(done: Done, context: UnsafeMutableRawPointer?) {
        self.done = done
        self.context = context
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        let lock = NSLock()
        var files: [[String: Any]] = []
        var failed = 0
        let copies = DispatchGroup()
        for result in results {
            guard let type = Self.type(of: result.itemProvider) else {
                failed += 1
                continue
            }
            copies.enter()
            result.itemProvider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                defer { copies.leave() }
                // The system deletes `url` when this closure returns, so the copy happens here.
                let copy = Result<URL, Error> {
                    guard let url else { throw error ?? CocoaError(.fileReadUnknown) }
                    let folder = FileManager.default.temporaryDirectory
                        .appendingPathComponent("gooncave-pick-\(UUID().uuidString)", isDirectory: true)
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    let target = folder.appendingPathComponent(url.lastPathComponent)
                    try FileManager.default.copyItem(at: url, to: target)
                    return target
                }
                lock.lock()
                defer { lock.unlock() }
                switch copy {
                case .success(let target):
                    var file: [String: Any] = ["path": target.path]
                    if let identifier = result.assetIdentifier { file["assetId"] = identifier }
                    files.append(file)
                case .failure:
                    failed += 1
                }
            }
        }
        copies.notify(queue: .main) {
            reply(self.done, self.context, ["files": files, "failed": failed])
            shown = nil
        }
    }

    /// The first form of `provider` that is a picture or a video.
    private static func type(of provider: NSItemProvider) -> String? {
        provider.registeredTypeIdentifiers.first { id in
            guard let type = UTType(id) else { return false }
            return type.conforms(to: .image) || type.conforms(to: .movie)
        }
    }
}
