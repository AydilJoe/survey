import Foundation
import UIKit
import Capacitor
import VisionKit
import PhotosUI
import StoreKit
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Duitful's on-device "kits" on iOS, one plugin, four jobs:
///
///   scanDocument     VisionKit's document camera (the scanner in Notes):
///                    finds the receipt's edges, straightens it and cleans it
///                    up. "Choose photo" opens the photo picker instead. Pages
///                    come back as JPEG data URLs for the OCR the app already
///                    runs.
///   drainQuickAdd    The Siri & Shortcuts queue. "Log a spend" (an App Intent
///                    in AppDelegate.swift, injected by scripts/patch-ios.mjs)
///                    can run while the app is closed, when the encrypted vault
///                    has no key, so it appends a small plain entry to
///                    UserDefaults. The web layer drains it on unlock and turns
///                    each entry into a pending transaction to confirm, exactly
///                    like Android's quick-add queue.
///   recognizeText    Apple Vision text recognition (DuitfulTextReader.swift):
///                    receipts, statement pages, EA forms and alert
///                    screenshots, answered in ML Kit's blocks / lines /
///                    elements shape so the JS parsers don't change.
///   extractEntities  Dates in text (NSDataDetector), for a receipt the
///                    parser found no date on. No money: iPhones get no bank
///                    alerts, which is what money entities were for.
///   requestReview    The App Store's own rating sheet, asked once per
///                    install at the debt-free moment. iOS decides whether to
///                    show it; resolving says we asked, not that it appeared.
///   aiStatus /       Apple's on-device Foundation Models (iOS 26, Apple
///   aiReadReceipt    Intelligence phones): a second opinion on a receipt the
///                    rule-based parser isn't sure of.
///   takePurchaseIntents  StoreKit 2 PurchaseIntent (iOS 16.4+): a Buy tapped
///                    on the App Store product page (a promoted in-app
///                    purchase). Only the product id is kept, until the web
///                    layer buys it through the purchase plugin.
///   speechAvailable/ "Talk to Kira" (1.80.0, DuitfulSpeech.swift): Apple's
///   speechStart /    Speech framework, on-device only (a language that can't
///   speechStop       be heard on this iPhone reports available:false). Partial
///                    text is the "speechPartial" event; speechStart resolves
///                    {text}. Speech recognition and microphone permission are
///                    asked the first time the mic is used.
///
/// Nothing here talks to a server, and nothing downloads a model: Vision,
/// NSDataDetector and Foundation Models are all part of iOS.
@objc(DuitfulKitPlugin)
public class DuitfulKitPlugin: CAPPlugin, CAPBridgedPlugin,
    VNDocumentCameraViewControllerDelegate, PHPickerViewControllerDelegate {
    public let identifier = "DuitfulKitPlugin"
    public let jsName = "DuitfulKit"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scanDocument", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drainQuickAdd", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recognizeText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "extractEntities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "aiStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "aiReadReceipt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "aiWriteRecap", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestReview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "relayWatch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readSharedFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeSharedFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncWidget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takePurchaseIntents", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speechAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speechStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speechStop", returnType: CAPPluginReturnPromise),
    ]

    /// Shared with the App Intents in AppDelegate.swift. Rename both or neither.
    static let quickAddKey = "duitful.quickAdd.queue"
    /// Long side of a returned page, in pixels. Matches what the OCR
    /// preprocessing upscales to, so nothing useful is thrown away.
    private static let maxSide: CGFloat = 3000

    private var pendingScan: CAPPluginCall?

    // MARK: - Document scanner

    @objc func scanDocument(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.pendingScan == nil else {
                call.reject("A scan is already open", "BUSY")
                return
            }
            guard let vc = self.bridge?.viewController else {
                call.reject("No view to present from", "UNAVAILABLE")
                return
            }
            let allowGallery = call.getBool("allowGallery") ?? true
            // The sheet's words in the language picked in Duitful; English if not sent.
            let labels = (call.options["labels"] as? [String: Any])?.compactMapValues { $0 as? String } ?? [:]
            let L = { (key: String, english: String) -> String in
                guard let v = labels[key], !v.isEmpty else { return english }
                return v
            }
            let canScan = VNDocumentCameraViewController.isSupported
            if !canScan && !allowGallery {
                call.reject("Document scanning isn't supported on this device", "UNAVAILABLE")
                return
            }
            self.pendingScan = call
            if !allowGallery {
                self.presentScanner(from: vc)
                return
            }
            let sheet = UIAlertController(title: L("title", "Scan receipt"), message: nil, preferredStyle: .actionSheet)
            if canScan {
                sheet.addAction(UIAlertAction(title: L("camera", "Scan with camera"), style: .default) { _ in
                    self.presentScanner(from: vc)
                })
            }
            sheet.addAction(UIAlertAction(title: L("photo", "Choose photo"), style: .default) { _ in
                self.presentPicker(from: vc)
            })
            sheet.addAction(UIAlertAction(title: L("cancel", "Cancel"), style: .cancel) { _ in
                self.finishScan(error: ("Scan cancelled", "CANCELLED"))
            })
            // iPad shows an action sheet as a popover, and UIKit throws if it
            // has no anchor. Centred with no arrow: the Scan button lives in
            // the web view, so there is no native view to point at.
            if let pop = sheet.popoverPresentationController {
                pop.sourceView = vc.view
                pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 1, height: 1)
                pop.permittedArrowDirections = []
            }
            vc.present(sheet, animated: true)
        }
    }

    private func presentScanner(from vc: UIViewController) {
        let scanner = VNDocumentCameraViewController()
        scanner.delegate = self
        vc.present(scanner, animated: true)
    }

    private func presentPicker(from vc: UIViewController) {
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 1
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        vc.present(picker, animated: true)
    }

    public func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                             didFinishWith scan: VNDocumentCameraScan) {
        let pages = (0..<scan.pageCount).map { scan.imageOfPage(at: $0) }
        controller.dismiss(animated: true)
        finishScan(images: pages)
    }

    public func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
        controller.dismiss(animated: true)
        finishScan(error: ("Scan cancelled", "CANCELLED"))
    }

    public func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                             didFailWithError error: Error) {
        controller.dismiss(animated: true)
        // Camera access denied lands here too. The web layer falls back to
        // the photo picker it has always had.
        finishScan(error: (error.localizedDescription, "FAILED"))
    }

    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider, provider.canLoadObject(ofClass: UIImage.self) else {
            finishScan(error: ("Scan cancelled", "CANCELLED"))
            return
        }
        provider.loadObject(ofClass: UIImage.self) { object, error in
            DispatchQueue.main.async {
                if let image = object as? UIImage {
                    self.finishScan(images: [image])
                } else {
                    self.finishScan(error: (error?.localizedDescription ?? "Couldn't open that photo", "READ_FAILED"))
                }
            }
        }
    }

    private func finishScan(images: [UIImage]) {
        guard let call = pendingScan else { return }
        pendingScan = nil
        DispatchQueue.global(qos: .userInitiated).async {
            let urls = images.compactMap { Self.jpegDataURL($0) }
            if urls.isEmpty {
                call.reject("Couldn't read the scanned page", "READ_FAILED")
            } else {
                call.resolve(["images": urls])
            }
        }
    }

    private func finishScan(error: (String, String)) {
        guard let call = pendingScan else { return }
        pendingScan = nil
        call.reject(error.0, error.1)
    }

    /// Redraws the page upright (scans and photos can carry an EXIF
    /// orientation the OCR would ignore), no larger than maxSide.
    private static func jpegDataURL(_ image: UIImage) -> String? {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }
        let scale = min(1, maxSide / max(size.width, size.height))
        let target = CGSize(width: floor(size.width * scale), height: floor(size.height * scale))
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let drawn = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        guard let data = drawn.jpegData(compressionQuality: 0.85) else { return nil }
        return "data:image/jpeg;base64," + data.base64EncodedString()
    }

    // MARK: - Siri & Shortcuts queue

    @objc func drainQuickAdd(_ call: CAPPluginCall) {
        let defaults = UserDefaults.standard
        let items = defaults.array(forKey: Self.quickAddKey) ?? []
        defaults.removeObject(forKey: Self.quickAddKey)
        call.resolve(["items": items])
    }

    // MARK: - Promoted in-app purchases (StoreKit 2 PurchaseIntent)

    /// Product ids from Buy taps on the App Store product page, kept until
    /// the web layer takes them (pro.js drainPurchaseIntents), which buys them
    /// through the purchase plugin like the paywall does. Main thread only.
    private var pendingPurchaseIntents: [String] = []
    private var purchaseIntentTask: Task<Void, Never>?

    override public func load() {
        if #available(iOS 16.4, *) {
            watchPurchaseIntents()
        }
    }

    deinit {
        purchaseIntentTask?.cancel()
    }

    @available(iOS 16.4, *)
    private func watchPurchaseIntents() {
        guard purchaseIntentTask == nil else { return }
        purchaseIntentTask = Task { [weak self] in
            for await intent in PurchaseIntent.intents {
                let productId = intent.product.id
                await MainActor.run {
                    guard let plugin = self else { return }
                    if !plugin.pendingPurchaseIntents.contains(productId) {
                        plugin.pendingPurchaseIntents.append(productId)
                    }
                    plugin.notifyListeners("purchaseIntent", data: ["productId": productId])
                }
            }
        }
    }

    @objc func takePurchaseIntents(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let ids = self.pendingPurchaseIntents
            self.pendingPurchaseIntents = []
            call.resolve(["productIds": ids])
        }
    }

    // MARK: - Text recognition (Vision)

    @objc func recognizeText(_ call: CAPPluginCall) {
        guard let image = call.getString("base64Image"), !image.isEmpty else {
            call.reject("No image is given", "EMPTY")
            return
        }
        DuitfulTextReader.recognize(base64: image,
                                    rotation: call.getInt("rotation") ?? 0,
                                    languageCorrection: call.getBool("languageCorrection") ?? false) { result in
            switch result {
            case .success(let payload): call.resolve(payload)
            case .failure(let failure): call.reject(failure.message, failure.code)
            }
        }
    }

    // MARK: - Dates in text (NSDataDetector)

    @objc func extractEntities(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            call.resolve(["money": [], "dates": []])
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            call.resolve(["money": [], "dates": DuitfulDateReader.dates(in: text)])
        }
    }

    // MARK: - On-device AI (Foundation Models)

    @objc func aiStatus(_ call: CAPPluginCall) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                call.resolve(["available": true, "reason": ""])
            case .unavailable(let reason):
                call.resolve(["available": false, "reason": String(describing: reason)])
            }
            return
        }
        #endif
        call.resolve(["available": false, "reason": "unsupported"])
    }

    @objc func aiReadReceipt(_ call: CAPPluginCall) {
        let text = String((call.getString("text") ?? "").prefix(DuitfulReceiptAI.maxChars))
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            call.reject("No text", "EMPTY")
            return
        }
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            Task {
                do {
                    call.resolve(try await DuitfulReceiptAI.read(text))
                } catch {
                    call.reject(error.localizedDescription, "AI")
                }
            }
            return
        }
        #endif
        call.reject("Needs iOS 26 with Apple Intelligence", "UNSUPPORTED")
    }

    /// The monthly recap reworded from the app's own fact lines. The app keeps
    /// the answer only if every number in it is one of the facts'.
    @objc func aiWriteRecap(_ call: CAPPluginCall) {
        let facts = String((call.getString("facts") ?? "").prefix(1200))
        guard !facts.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            call.reject("No facts", "EMPTY")
            return
        }
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            Task {
                do {
                    let session = LanguageModelSession(instructions: DuitfulRecapAI.instructions)
                    let response = try await session.respond(to: "Facts:\n" + facts)
                    call.resolve(["text": response.content])
                } catch {
                    call.reject(error.localizedDescription, "AI")
                }
            }
            return
        }
        #endif
        call.reject("Needs iOS 26 with Apple Intelligence", "UNSUPPORTED")
    }

    /// A PDF or photo opened in Duitful from Mail, Files or a bank app. iOS
    /// copies it into the app's own Inbox and hands over a file URL
    /// (appUrlOpen); this reads it once and deletes the copy. Only files
    /// inside the app's container, only PDFs and images, at most 25 MB.
    /// → {files: [{name, mime, base64}]}
    @objc func readSharedFile(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw), url.isFileURL else {
            call.reject("Not a file", "BAD_URL")
            return
        }
        let home = URL(fileURLWithPath: NSHomeDirectory()).standardizedFileURL.resolvingSymlinksInPath().path
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        guard path.hasPrefix(home + "/") else {
            call.reject("Not in the app's files", "BAD_URL")
            return
        }
        let ext = url.pathExtension.lowercased()
        let mimes = ["pdf": "application/pdf", "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "heic": "image/heic", "heif": "image/heif", "webp": "image/webp"]
        guard let mime = mimes[ext] else {
            call.reject("Not a PDF or photo", "TYPE")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            defer { try? FileManager.default.removeItem(at: url) } // the copy is not kept
            guard let data = try? Data(contentsOf: url), data.count <= 25 * 1024 * 1024 else {
                call.reject("Couldn't read the file", "READ_FAILED")
                return
            }
            call.resolve(["files": [["name": url.lastPathComponent, "mime": mime, "base64": data.base64EncodedString()]]])
        }
    }

    /// Files staged by the DuitfulShare Share Extension in the shared App Group
    /// container (group.com.aydiljoe.duitful/SharedInbox). Each file is read
    /// once and deleted immediately; capped at 12 files and 25 MB each.
    /// → {files: [{name, mime, base64}]}
    @objc func takeSharedFiles(_ call: CAPPluginCall) {
        let appGroup = "group.com.aydiljoe.duitful"
        let mimes = ["pdf": "application/pdf", "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "heic": "image/heic", "heif": "image/heif", "webp": "image/webp"]
        DispatchQueue.global(qos: .userInitiated).async {
            guard let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
                call.resolve(["files": []])
                return
            }
            let inbox = base.appendingPathComponent("SharedInbox", isDirectory: true)
            guard let urls = try? FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else {
                call.resolve(["files": []])
                return
            }
            let sorted = urls.sorted { $0.lastPathComponent < $1.lastPathComponent }
            var out: [[String: String]] = []
            for url in sorted.prefix(12) {
                defer { try? FileManager.default.removeItem(at: url) }
                let ext = url.pathExtension.lowercased()
                guard let mime = mimes[ext],
                      let data = try? Data(contentsOf: url),
                      !data.isEmpty,
                      data.count <= 25 * 1024 * 1024 else { continue }
                out.append([
                    "name": url.lastPathComponent,
                    "mime": mime,
                    "base64": data.base64EncodedString(),
                ])
            }
            call.resolve(["files": out])
        }
    }

    /// The split bills to watch while Duitful is closed (DuitfulRelayWatch):
    /// {boxes: [{id, key, ti, p: {personId: name}}], seen: [eventId], on}.
    /// An empty list, or on:false, cancels the background check and wipes it.
    @objc func relayWatch(_ call: CAPPluginCall) {
        let raw = call.options["boxes"] as? [[String: Any]] ?? []
        let seen = (call.options["seen"] as? [Any] ?? []).compactMap { $0 as? String }
        let on = call.getBool("on") ?? true
        let strings = (call.options["strings"] as? [String: Any])?.compactMapValues { $0 as? String }
        do {
            let data = try JSONSerialization.data(withJSONObject: raw)
            let boxes = try JSONDecoder().decode([DuitfulRelayWatch.Box].self, from: data)
            DuitfulRelayWatch.update(boxes: boxes, seen: seen, on: on, strings: strings)
            call.resolve(["ok": true])
        } catch {
            call.reject(error.localizedDescription, "RELAY")
        }
    }

    /// Pushes the non-amount Option D widget summary (theme, locked state,
    /// status word, month countdown ring, review count and upcoming bill names)
    /// and asks WidgetKit to reload timelines.
    @objc func syncWidget(_ call: CAPPluginCall) {
        let keys = [
            "theme", "status", "tone", "month", "daysLeftShort", "daysLeftLines",
            "daysLeftLong", "reviewWord", "reviewLine", "comingUp", "noUpcoming",
            "lockedTitle", "lockedHint", "logSpendLabel", "scanLabel", "splitLabel",
            "due1Name", "due1When", "due2Name", "due2When", "dueSub", "streakLabel"
        ]
        var dict: [String: Any] = [
            "locked": call.getBool("locked") ?? false,
            "daysLeft": call.getInt("daysLeft") ?? 0,
            "dayPct": call.getInt("dayPct") ?? 0,
            "reviewCount": call.getInt("reviewCount") ?? 0,
            "streakDays": call.getInt("streakDays") ?? 0,
        ]
        for k in keys {
            if let v = call.getString(k) { dict[k] = v }
        }
        UserDefaults.standard.set(dict, forKey: "duitful.widget.summary")
        let locked = call.getBool("locked") ?? false
        let walletNames = locked ? [] : ((call.options["walletNames"] as? [Any])?.compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty } ?? [])
        UserDefaults.standard.set(Array(walletNames.prefix(12)), forKey: "duitful.assistant.wallets")
        DuitfulWidgetReload.reloadAll()
        call.resolve(["ok": true])
    }

    // MARK: - Talk to Kira (Speech, on-device only)

    private var speechObserver: NSObjectProtocol?

    /// {available, onDevice, locale}: can this language be heard on this iPhone.
    @objc func speechAvailable(_ call: CAPPluginCall) {
        let lang = call.getString("lang") ?? "en-MY"
        DispatchQueue.main.async {
            call.resolve(DuitfulSpeech.status(lang: lang))
        }
    }

    /// Listens until speechStop, silence or 30 s; resolves {text} ("" if
    /// nothing was heard). Rejects DENIED when speech or the mic is refused.
    @objc func speechStart(_ call: CAPPluginCall) {
        let lang = call.getString("lang") ?? "en-MY"
        DuitfulSpeech.authorize { granted in
            guard granted else {
                call.reject("Speech recognition or the microphone isn't allowed", "DENIED")
                return
            }
            if self.speechObserver == nil {
                // Never listen in the background.
                self.speechObserver = NotificationCenter.default.addObserver(
                    forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
                ) { _ in DuitfulSpeech.shared.stop() }
            }
            DuitfulSpeech.shared.start(lang: lang, partial: { [weak self] text in
                self?.notifyListeners("speechPartial", data: ["text": text])
            }, finish: { result in
                switch result {
                case .success(let text): call.resolve(["text": text])
                case .failure(let failure): call.reject(failure.message, failure.code)
                }
            })
        }
    }

    /// Let go of Kira / tap the mic: the pending speechStart resolves.
    @objc func speechStop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            DuitfulSpeech.shared.stop()
            call.resolve(["ok": true])
        }
    }

    /// Ask iOS for the rating sheet. The system shows it at most a few times
    /// a year per app and never says which, so `asked` reports that the call
    /// was made, not that anything appeared on screen. Must run on the main
    /// actor and needs the window scene the app is actually in.
    @objc func requestReview(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let scene = self.bridge?.viewController?.view.window?.windowScene else {
                call.resolve(["asked": false])
                return
            }
            if #available(iOS 16.0, *) {
                AppStore.requestReview(in: scene)
            } else {
                SKStoreReviewController.requestReview(in: scene)
            }
            call.resolve(["asked": true])
        }
    }
}

enum DuitfulRecapAI {
    static let instructions = """
        You write a short monthly spending recap for a personal finance app. \
        Use only the facts you are given. Write two or three short sentences in plain, friendly English, not formal. \
        Copy every number exactly as written in the facts. Do not calculate, round, or add any number or percentage. \
        Describe only; do not give advice or suggestions. No greeting, no emoji, no lists.
        """
}

enum DuitfulReceiptAI {
    static let maxChars = 3000
    static let instructions = """
        You read the OCR text of a shop receipt, usually from Malaysia, and pull out four fields. \
        total is the final amount the customer paid after tax, service charge and rounding. \
        It is never the cash handed over, the change, a subtotal, or a savings line. \
        merchant is the shop or company name without its registration number. \
        If a field isn't on the receipt, leave it empty (0 for total).
        """
}

#if canImport(FoundationModels)
@available(iOS 26.0, *)
@Generable
struct DuitfulReceiptFields {
    @Guide(description: "Final amount paid, e.g. 23.40. 0 if not found.")
    var total: Double
    @Guide(description: "Shop or company name, without its registration number")
    var merchant: String
    @Guide(description: "Receipt date as YYYY-MM-DD, or empty")
    var date: String
    @Guide(description: "ISO 4217 currency code such as MYR, or empty")
    var currency: String
}

@available(iOS 26.0, *)
extension DuitfulReceiptAI {
    static func read(_ text: String) async throws -> [String: Any] {
        let session = LanguageModelSession(instructions: instructions)
        let response = try await session.respond(to: "Receipt:\n" + text, generating: DuitfulReceiptFields.self)
        let f = response.content
        return [
            "total": f.total > 0 ? f.total : 0,
            "merchant": f.merchant,
            "date": f.date,
            "currency": f.currency,
        ]
    }

}
#endif
