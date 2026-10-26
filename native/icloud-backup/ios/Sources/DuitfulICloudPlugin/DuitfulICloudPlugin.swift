import Foundation
import Capacitor

/// iCloud backup transport for Duitful.
///
/// Stores ONE file in the app's own iCloud container
/// (iCloud.com.aydiljoe.duitful): the same AES-GCM record the web layer
/// already writes to localStorage and to Google Drive, wrapped with a little
/// metadata. Swift never sees plaintext and never parses the record. All it
/// does is move a string in and out of iCloud.
///
/// The container is private to Duitful. Nothing declares it public in
/// Info.plist (NSUbiquitousContainers), so the file does not show in the
/// Files app, where it could be moved or deleted by accident.
///
/// No container (the user is signed out of iCloud, has turned iCloud off for
/// Duitful, or the build carries no iCloud entitlement, as with AltStore and
/// build-only) is reported as `available: false`, never as an error. The web
/// layer then falls back to Google Drive.
@objc(DuitfulICloudPlugin)
public class DuitfulICloudPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DuitfulICloudPlugin"
    public let jsName = "DuitfulICloud"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
    ]

    private static let containerId = "iCloud.com.aydiljoe.duitful"
    private static let folder = "Backups"
    private static let fileName = "duitful-backup.json"

    // Every container and file operation runs on this queue. Apple says
    // url(forUbiquityContainerIdentifier:) can block while iCloud prepares
    // the container, so it must never run on the main thread.
    private let queue = DispatchQueue(label: "app.duitful.icloud", qos: .userInitiated)
    private var container: URL?

    /// `reason` says which of the two gates failed, so the app can tell
    /// someone what to change instead of one generic line:
    ///   "no-account"   — no iCloud identity: signed out, or iCloud Drive off
    ///   "no-container" — iCloud is on, but this build can't open Duitful's
    ///                    container (entitlement/profile, or iCloud for
    ///                    Duitful switched off)
    @objc func status(_ call: CAPPluginCall) {
        guard FileManager.default.ubiquityIdentityToken != nil else {
            call.resolve(["available": false, "reason": "no-account"])
            return
        }
        queue.async {
            let ok = self.fileURL() != nil
            call.resolve(["available": ok, "reason": ok ? "" : "no-container"])
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        guard let text = call.getString("data"), let data = text.data(using: .utf8) else {
            call.reject("Nothing to save", "BAD_INPUT")
            return
        }
        queue.async {
            guard let url = self.fileURL() else {
                call.reject("iCloud isn't available on this iPhone", "UNAVAILABLE")
                return
            }
            do {
                try FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            } catch {
                call.reject("Couldn't prepare iCloud: \(error.localizedDescription)", "WRITE_FAILED")
                return
            }
            // Coordinated, so iCloud's sync daemon never uploads a half-written file.
            var coordError: NSError?
            var writeError: Error?
            NSFileCoordinator(filePresenter: nil)
                .coordinate(writingItemAt: url, options: .forReplacing, error: &coordError) { target in
                    do { try data.write(to: target, options: .atomic) } catch { writeError = error }
                }
            if let err = writeError ?? (coordError as Error?) {
                call.reject("Couldn't save to iCloud: \(err.localizedDescription)", "WRITE_FAILED")
                return
            }
            call.resolve(["ok": true])
        }
    }

    /// Resolves `{ data: String }`, or `{ data: null }` when there is no backup.
    ///
    /// On a new iPhone the backup can exist in iCloud before this device has
    /// downloaded it, or before the device even knows it exists. So read
    /// first asks iCloud's index (NSMetadataQuery), then downloads the file
    /// and waits for it.
    @objc func read(_ call: CAPPluginCall) {
        queue.async {
            guard let url = self.fileURL() else {
                call.reject("iCloud isn't available on this iPhone", "UNAVAILABLE")
                return
            }
            let fm = FileManager.default
            let placeholder = url.deletingLastPathComponent()
                .appendingPathComponent(".\(Self.fileName).icloud")
            let known = fm.fileExists(atPath: url.path) || fm.fileExists(atPath: placeholder.path)
            if !known && !self.indexHasBackup(timeout: 8) {
                call.resolve(["data": NSNull()])
                return
            }
            guard self.waitUntilCurrent(url, timeout: 30) else {
                call.reject("iCloud is still downloading your backup. Try again in a minute.", "TIMEOUT")
                return
            }
            var coordError: NSError?
            var data: Data?
            var readError: Error?
            NSFileCoordinator(filePresenter: nil)
                .coordinate(readingItemAt: url, options: [], error: &coordError) { target in
                    do { data = try Data(contentsOf: target) } catch { readError = error }
                }
            if let err = readError ?? (coordError as Error?) {
                call.reject("Couldn't read the iCloud backup: \(err.localizedDescription)", "READ_FAILED")
                return
            }
            guard let bytes = data, let text = String(data: bytes, encoding: .utf8) else {
                call.reject("The iCloud backup is damaged", "READ_FAILED")
                return
            }
            call.resolve(["data": text])
        }
    }

    // MARK: - helpers (all on `queue`)

    private func fileURL() -> URL? {
        if container == nil {
            container = FileManager.default.url(forUbiquityContainerIdentifier: Self.containerId)
        }
        return container?
            .appendingPathComponent(Self.folder, isDirectory: true)
            .appendingPathComponent(Self.fileName, isDirectory: false)
    }

    /// Asks iCloud's index whether the backup exists, waiting up to `timeout`
    /// for the first results. NSMetadataQuery needs a run loop, so it lives on main.
    private func indexHasBackup(timeout: TimeInterval) -> Bool {
        let done = DispatchSemaphore(value: 0)
        var query: NSMetadataQuery?
        var observers: [NSObjectProtocol] = []
        var found = false

        DispatchQueue.main.async {
            let q = NSMetadataQuery()
            q.searchScopes = [NSMetadataQueryUbiquitousDataScope]
            q.predicate = NSPredicate(format: "%K == %@", NSMetadataItemFSNameKey, Self.fileName)
            let check: (Notification) -> Void = { _ in
                guard !found, q.resultCount > 0 else { return }
                found = true
                done.signal()
            }
            observers = [
                NotificationCenter.default.addObserver(
                    forName: .NSMetadataQueryDidFinishGathering, object: q, queue: .main, using: check),
                NotificationCenter.default.addObserver(
                    forName: .NSMetadataQueryDidUpdate, object: q, queue: .main, using: check),
            ]
            query = q
            q.start()
        }

        _ = done.wait(timeout: .now() + timeout)
        var result = false
        DispatchQueue.main.sync {
            result = found
            query?.stop()
            observers.forEach { NotificationCenter.default.removeObserver($0) }
        }
        return result
    }

    /// Starts the download if needed and waits until the local copy is the
    /// latest version. If time runs out and an older local copy exists, that
    /// copy is good enough to read. The web layer compares timestamps anyway.
    private func waitUntilCurrent(_ url: URL, timeout: TimeInterval) -> Bool {
        let fm = FileManager.default
        let deadline = Date().addingTimeInterval(timeout)
        var asked = false
        while true {
            var status: URLUbiquitousItemDownloadingStatus?
            var u = url
            u.removeAllCachedResourceValues()
            if let values = try? u.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]) {
                status = values.ubiquitousItemDownloadingStatus
            }
            if status == .current { return true }
            if status == nil && fm.fileExists(atPath: url.path) { return true } // not ubiquitous-tracked yet: a fresh local write
            if !asked {
                try? fm.startDownloadingUbiquitousItem(at: url)
                asked = true
            }
            if Date() >= deadline { return fm.fileExists(atPath: url.path) }
            Thread.sleep(forTimeInterval: 0.4)
        }
    }
}
