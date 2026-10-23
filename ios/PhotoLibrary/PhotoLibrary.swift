import Photos
import PhotosUI
import UIKit
import UniformTypeIdentifiers

// The app loads this library at startup and calls the two functions below; see
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
