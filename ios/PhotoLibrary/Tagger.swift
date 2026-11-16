import CoreML
import Foundation

// The Core ML side of automatic tagging; see src-tauri/src/tagger.rs. The Rust core calls these
// from a blocking thread. Each returns false and writes a NUL-terminated message into `message`
// when it fails.

private let side = 448
private let weights = "Data/com.apple.CoreML/weights/weight.bin"

private let lock = NSLock()
private var model: MLModel?

private func modified(_ url: URL) -> Date? {
    (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
}

private func fail(_ reason: String, _ message: UnsafeMutablePointer<CChar>, _ capacity: Int) -> Bool {
    _ = reason.withCString { strlcpy(message, $0, capacity) }
    return false
}

/// Compiling takes seconds, so the compiled model stays next to the package until the package changes.
private func compiled(_ package: URL) throws -> URL {
    let manager = FileManager.default
    let target = package.deletingLastPathComponent().appendingPathComponent("WD14.mlmodelc")
    if let built = modified(target), let source = modified(package.appendingPathComponent(weights)),
        built >= source
    {
        return target
    }
    let temporary = try MLModel.compileModel(at: package)
    if manager.fileExists(atPath: target.path) { try manager.removeItem(at: target) }
    try manager.moveItem(at: temporary, to: target)
    return target
}

@_cdecl("gooncave_tagger_load")
public func taggerLoad(
    _ package: UnsafePointer<CChar>, _ message: UnsafeMutablePointer<CChar>, _ capacity: Int
) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    do {
        let configuration = MLModelConfiguration()
        // The Neural Engine computes in 16 bits, which changes some tags, and the GPU is not
        // available to an app that is not on screen.
        configuration.computeUnits = .cpuOnly
        let url = try compiled(URL(fileURLWithPath: String(cString: package)))
        model = try MLModel(contentsOf: url, configuration: configuration)
        return true
    } catch {
        return fail(error.localizedDescription, message, capacity)
    }
}

@_cdecl("gooncave_tagger_run")
public func taggerRun(
    _ input: UnsafePointer<Float>, _ inputCount: Int, _ output: UnsafeMutablePointer<Float>, _ outputCount: Int,
    _ message: UnsafeMutablePointer<CChar>, _ capacity: Int
) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard let model else { return fail("The model is not loaded.", message, capacity) }
    guard inputCount == side * side * 3 else { return fail("The input has the wrong size.", message, capacity) }
    do {
        let array = try MLMultiArray(
            dataPointer: UnsafeMutableRawPointer(mutating: input), shape: [1, side, side, 3] as [NSNumber],
            dataType: .float32, strides: [side * side * 3, side * 3, 3, 1] as [NSNumber])
        let features = try MLDictionaryFeatureProvider(dictionary: ["input_1": MLFeatureValue(multiArray: array)])
        let result = try model.prediction(from: features)
        guard let scores = result.featureValue(for: "Identity")?.multiArrayValue, scores.count == outputCount,
            scores.dataType == .float32
        else { return fail("The model returned an unexpected result.", message, capacity) }
        output.update(from: scores.dataPointer.assumingMemoryBound(to: Float.self), count: outputCount)
        return true
    } catch {
        return fail(error.localizedDescription, message, capacity)
    }
}

@_cdecl("gooncave_tagger_unload")
public func taggerUnload() {
    lock.lock()
    model = nil
    lock.unlock()
}
