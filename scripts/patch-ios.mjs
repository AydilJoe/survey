#!/usr/bin/env node
// Stamps the generated ios/ project with everything Capacitor's template
// doesn't know about: the three usage-description strings App Review
// requires, the export-compliance flag, the Google sign-in URL scheme that
// Drive backup needs, the Home Screen quick actions (icon long-press menu)
// and the AppDelegate glue that routes them, the actions-only WidgetKit
// extension, and the Associated Domains entitlement that makes
// https://duitful.app/split open the app.
//
// The ios/ project is git-ignored and regenerated on every CI run (and on
// any Mac), so this script — wired into cap:sync and into the iOS release
// workflow, exactly like the patch-android-* trio — re-applies the changes
// after a fresh `npx cap add ios`. Idempotent; no-op on Android-only
// checkouts.
//
// The other half of Universal Links is the server side:
// /.well-known/apple-app-site-association in this repo, which still needs
// the real Team ID pasted in before iOS will verify the domain. See
// .well-known/README.md and the "Universal Links" section of IOS_BUILD.md.
// Until then links keep opening in Safari — the intended fallback, not a
// failure.
//
// Env switches:
//   DUITFUL_IOS_SKIP_ASSOCIATED_DOMAINS=1
//     Skip the entitlement entirely. Use this for the very first build if
//     the Associated Domains capability isn't enabled on the App ID yet —
//     signing fails outright when the profile can't carry the entitlement.
//   DUITFUL_IOS_SKIP_ICLOUD=1
//     Leave out the iCloud entitlement (iCloud backup). Same reason: use it
//     if the App ID doesn't have iCloud enabled, with the
//     iCloud.com.aydiljoe.duitful container, yet. The app then simply offers
//     Google Drive only.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readIosClientId, reversedClientId } from "./google-ios-client.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IOS_APP = resolve(ROOT, "ios/App");
const INFO_PLIST = resolve(IOS_APP, "App/Info.plist");
const DRIVE_CONFIG = resolve(ROOT, "app/drive-config.js");
const ENTITLEMENTS = resolve(IOS_APP, "App/App.entitlements");
const PBXPROJ = resolve(IOS_APP, "App.xcodeproj/project.pbxproj");
const APP_DELEGATE = resolve(IOS_APP, "App/AppDelegate.swift");
const CAP_CONFIG = resolve(ROOT, "capacitor.config.json");
// The WidgetKit extension (section 4). Sources live beside App/ inside the
// same Xcode project directory, so INFOPLIST_FILE is a plain SRCROOT-
// relative path exactly like the App target's.
const WIDGET_NAME = "DuitfulWidget";
const WIDGET_DIR = resolve(IOS_APP, WIDGET_NAME);
const WIDGET_SWIFT = resolve(WIDGET_DIR, `${WIDGET_NAME}.swift`);
const WIDGET_PLIST = resolve(WIDGET_DIR, "Info.plist");
// Widgets are a much younger API than the app itself: the app floor stays
// at 15.5 (originally set for GoogleMLKit before 1.64.0 dropped it; see the
// last block in this file), but nothing forces the extension that low, and
// 16.0 keeps the SwiftUI used below on well-trodden ground. An extension may
// require a newer iOS than its host app — iOS simply doesn't offer the widget
// on older devices, which is the correct behaviour here.
const WIDGET_DEPLOYMENT_TARGET = "16.0";
// Shared App Group used by the main app and the DuitfulShare Share Extension
// so shared PDFs and receipt photos can pass safely between them.
const APP_GROUP = "group.com.aydiljoe.duitful";
const SHARE_NAME = "DuitfulShare";
const SHARE_DIR = resolve(IOS_APP, SHARE_NAME);
const SHARE_SWIFT = resolve(SHARE_DIR, `${SHARE_NAME}.swift`);
const SHARE_PLIST = resolve(SHARE_DIR, "Info.plist");
const SHARE_ENTITLEMENTS = resolve(SHARE_DIR, `${SHARE_NAME}.entitlements`);
const SHARE_DEPLOYMENT_TARGET = "15.5";

const HOSTS = ["duitful.app", "www.duitful.app"];
// Quick-action types are namespaced with the real bundle id, read from the
// one place that already owns it. Hard-coding it here would let a rename in
// capacitor.config.json silently orphan the menu. Parsed defensively: a
// checkout with no ios/ never gets far enough to care.
const APP_ID = (() => {
  try {
    return String(JSON.parse(readFileSync(CAP_CONFIG, "utf8")).appId || "").trim();
  } catch {
    return "";
  }
})();
// The custom scheme the quick actions (and any future duitful:// link) ride
// in on. Registered in CFBundleURLTypes alongside — never instead of — the
// Google reversed-client-id scheme.
const APP_SCHEME = "duitful";
// Home Screen quick actions, in menu order (iOS shows at most four). The
// type is namespaced with the bundle id, App Store convention; AppDelegate
// takes the last dot-component back off and turns it into
// duitful://action/<name>, which is what the web layer already parses.
const SHORTCUTS = [
  ["spend", "Log a spend", "UIApplicationShortcutIconTypeAdd"],
  ["scan", "Scan a receipt", "UIApplicationShortcutIconTypeCapture"],
  ["split", "Split a bill", "UIApplicationShortcutIconTypeShare"],
  ["debt", "Log a debt payment", "UIApplicationShortcutIconTypeConfirmation"],
];
const SKIP_DOMAINS = process.env.DUITFUL_IOS_SKIP_ASSOCIATED_DOMAINS === "1";
const SKIP_ICLOUD = process.env.DUITFUL_IOS_SKIP_ICLOUD === "1";
// iCloud backup (native/icloud-backup) writes into this container. It must
// also exist in the developer portal and be assigned to the App ID.
const ICLOUD_CONTAINER = "iCloud.com.aydiljoe.duitful";

if (!existsSync(INFO_PLIST)) {
  console.log("patch-ios: ios/ project not present, skipping.");
  process.exit(0);
}

/* ---------- 1. Info.plist usage descriptions ---------- */
// Every one of these is a hard App Review requirement: iOS kills the app
// on the spot if it touches the camera / photo library / Face ID without
// the matching string, and Review rejects vague wording. Keep the copy
// specific about what is done AND about what isn't (nothing leaves the
// device) — that claim is what the whole product is built on.
const PLIST_KEYS = [
  [
    "NSCameraUsageDescription",
    "Scan receipts and split-bill QR codes — images never leave your device",
  ],
  [
    "NSPhotoLibraryUsageDescription",
    "Pick a receipt photo to scan — images never leave your device",
  ],
  [
    "NSFaceIDUsageDescription",
    "Unlock Duitful with Face ID — your passcode stays the only key",
  ],
];

let plist = readFileSync(INFO_PLIST, "utf8");
let plistAdded = 0;

for (const [key, value] of PLIST_KEYS) {
  if (plist.includes(`<key>${key}</key>`)) continue;
  plist = insertPlistEntry(plist, `\t<key>${key}</key>\n\t<string>${value}</string>\n`);
  plistAdded++;
}

// Export compliance: Duitful encrypts the local vault with AES-GCM via the
// platform's own crypto. That is standard, non-proprietary encryption used
// only to protect the user's own data on their own device, so the app is
// exempt. Declaring it here means TestFlight builds go straight to testers
// instead of parking on "Missing Compliance" until someone answers the
// question by hand in App Store Connect. Re-check this if Duitful ever
// ships its own crypto — see IOS_BUILD.md.
// "Siti says they paid" while the app is closed: a BGAppRefreshTask
// (DuitfulRelayWatch in the DuitfulKit pod). iOS crashes a register() whose
// id isn't listed here, and only runs refresh tasks with the fetch mode.
// Share / Open in: a statement PDF or photos from Mail, Files or a bank app.
// iOS copies the file into the app's Inbox and opens Duitful with its URL
// (appUrlOpen); DuitfulKit.readSharedFile reads it once and deletes it.
if (!plist.includes("<key>CFBundleDocumentTypes</key>")) {
  plist = insertPlistEntry(plist, [
    "\t<key>CFBundleDocumentTypes</key>",
    "\t<array>",
    "\t\t<dict>",
    "\t\t\t<key>CFBundleTypeName</key>\n\t\t\t<string>Bank statement (PDF)</string>",
    "\t\t\t<key>CFBundleTypeRole</key>\n\t\t\t<string>Viewer</string>",
    "\t\t\t<key>LSHandlerRank</key>\n\t\t\t<string>Alternate</string>",
    "\t\t\t<key>LSItemContentTypes</key>\n\t\t\t<array>\n\t\t\t\t<string>com.adobe.pdf</string>\n\t\t\t</array>",
    "\t\t</dict>",
    "\t\t<dict>",
    "\t\t\t<key>CFBundleTypeName</key>\n\t\t\t<string>Receipt or statement photo</string>",
    "\t\t\t<key>CFBundleTypeRole</key>\n\t\t\t<string>Viewer</string>",
    "\t\t\t<key>LSHandlerRank</key>\n\t\t\t<string>Alternate</string>",
    "\t\t\t<key>LSItemContentTypes</key>\n\t\t\t<array>\n\t\t\t\t<string>public.image</string>\n\t\t\t</array>",
    "\t\t</dict>",
    "\t</array>",
    "\t<key>LSSupportsOpeningDocumentsInPlace</key>",
    "\t<false/>",
    "",
  ].join("\n"));
  plistAdded++;
}
if (!plist.includes("<key>BGTaskSchedulerPermittedIdentifiers</key>")) {
  plist = insertPlistEntry(plist, "\t<key>BGTaskSchedulerPermittedIdentifiers</key>\n\t<array>\n\t\t<string>com.aydiljoe.duitful.relay-watch</string>\n\t</array>\n");
  plistAdded++;
}
if (!plist.includes("<key>UIBackgroundModes</key>")) {
  plist = insertPlistEntry(plist, "\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>fetch</string>\n\t</array>\n");
  plistAdded++;
} else if (!/<key>UIBackgroundModes<\/key>\s*<array>[\s\S]*?<string>fetch<\/string>/.test(plist)) {
  plist = plist.replace(/(<key>UIBackgroundModes<\/key>\s*<array>)/, "$1\n\t\t<string>fetch</string>");
  plistAdded++;
}

if (!plist.includes("<key>ITSAppUsesNonExemptEncryption</key>")) {
  plist = insertPlistEntry(plist, "\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>\n");
  plistAdded++;
}

// Google Drive sign-in on iOS: Google's SDK hands the OAuth result back on a
// custom URL scheme — the client ID with its domain parts reversed — and
// refuses to start if that scheme isn't registered in CFBundleURLTypes. The
// value is derived from DRIVE_CONFIG.iosClientId in app/drive-config.js
// rather than hard-coded, so re-pointing the app at another Google project
// is a one-line edit there. An empty id (a fork with no Google project of
// its own) skips this cleanly: the app then reports cloud backup as not
// configured instead of failing at sign-in. See app/drive-sync.js.
const IOS_URL_SCHEME = existsSync(DRIVE_CONFIG)
  ? reversedClientId(readIosClientId(readFileSync(DRIVE_CONFIG, "utf8")))
  : null;

if (!IOS_URL_SCHEME) {
  console.log("patch-ios: DRIVE_CONFIG.iosClientId is empty, no Google URL scheme to add.");
} else if (plist.includes(`<string>${IOS_URL_SCHEME}</string>`)) {
  console.log("patch-ios: Google URL scheme already registered, skipping.");
} else {
  plist = registerUrlScheme(plist, IOS_URL_SCHEME);
  plistAdded++;
  console.log(`patch-ios: registered Google URL scheme ${IOS_URL_SCHEME}.`);
}

/* ---------- 2. Home Screen quick actions (Info.plist) ---------- */
// The menu behind a long press on the app icon. Two halves live here: the
// static UIApplicationShortcutItems array below (iOS reads it straight out
// of the bundle, so the menu exists before the app has ever been opened),
// and the duitful:// scheme those actions are delivered on — see section 3
// for the AppDelegate half that does the delivering.
//
// The scheme registration deliberately goes through the same helper as the
// Google one: CFBundleURLTypes is a single array shared by every scheme the
// app answers to, and appending to it is the only correct move. Replacing
// it would silently break Drive sign-in.
// Scoped to the CFBundleURLTypes block rather than the whole file: unlike
// the reversed client id, "duitful" is a plausible value elsewhere in a
// plist, and a false positive here would skip the registration silently.
if (schemeAlreadyRegistered(plist, APP_SCHEME)) {
  console.log(`patch-ios: ${APP_SCHEME}:// URL scheme already registered, skipping.`);
} else {
  plist = registerUrlScheme(plist, APP_SCHEME);
  plistAdded++;
  console.log(`patch-ios: registered ${APP_SCHEME}:// URL scheme.`);
}

if (!APP_ID) {
  console.error("patch-ios: no appId in", CAP_CONFIG, "— cannot namespace the quick actions.");
  process.exit(1);
} else if (plist.includes("<key>UIApplicationShortcutItems</key>")) {
  console.log("patch-ios: UIApplicationShortcutItems already present, skipping.");
} else {
  const items = SHORTCUTS.map(([name, title, icon]) =>
    "\t\t<dict>\n" +
    "\t\t\t<key>UIApplicationShortcutItemType</key>\n" +
    `\t\t\t<string>${APP_ID}.${name}</string>\n` +
    "\t\t\t<key>UIApplicationShortcutItemTitle</key>\n" +
    `\t\t\t<string>${title}</string>\n` +
    "\t\t\t<key>UIApplicationShortcutItemIconType</key>\n" +
    `\t\t\t<string>${icon}</string>\n` +
    "\t\t</dict>\n").join("");
  plist = insertPlistEntry(
    plist,
    "\t<key>UIApplicationShortcutItems</key>\n\t<array>\n" + items + "\t</array>\n",
  );
  plistAdded++;
  console.log(`patch-ios: added ${SHORTCUTS.length} Home Screen quick action(s).`);
}

/* ---------- 2b. iPad: full screen, every orientation (Info.plist) ----------
   Since 1.63 the app ships on iPad too (TARGETED_DEVICE_FAMILY "1,2", the
   last block in this file). UIRequiresFullScreen opts out of iPad
   multitasking: no Split View or Slide Over, so the app never has to lay out
   in a third of the screen, and iPadOS does not demand that it support every
   orientation for multitasking. The web layer handles any size anyway (rail
   from 600px, sidebar from 1000px, see folds/fold-lab.js). The iPad gets all
   four orientations; the iPhone list (UISupportedInterfaceOrientations) is
   left exactly as Capacitor's template writes it. */
const IPAD_ORIENTATIONS = [
  "UIInterfaceOrientationPortrait",
  "UIInterfaceOrientationPortraitUpsideDown",
  "UIInterfaceOrientationLandscapeLeft",
  "UIInterfaceOrientationLandscapeRight",
];
{
  const r = ensureIpadPlist(plist);
  if (r.changes.length) {
    plist = r.plist;
    plistAdded += r.changes.length;
    for (const c of r.changes) console.log(`patch-ios: iPad: ${c}.`);
  } else {
    console.log("patch-ios: iPad full screen and orientations already set, skipping.");
  }
}

if (plistAdded) {
  writeFileSync(INFO_PLIST, plist);
  console.log(`patch-ios: added ${plistAdded} key(s) to Info.plist.`);
} else {
  console.log("patch-ios: Info.plist keys already present, skipping.");
}

/* ---------- 3. Quick-action routing in AppDelegate.swift ---------- */
// iOS does not hand a quick action to the app as a URL — it arrives as a
// UIApplicationShortcutItem on the app delegate, so nothing in the web
// layer would ever see it. This injects the two delegate callbacks that
// translate the item into duitful://action/<name> and push it through
// ApplicationDelegateProxy, i.e. the exact same door a real deep link
// walks through, which is what makes it come out as Capacitor's
// appUrlOpen / getLaunchUrl.
//
// AppDelegate.swift is regenerated by `npx cap add ios`, so the injection
// re-runs from scratch every time. It appends whole new methods just above
// the class's closing brace rather than rewriting anything Capacitor
// generated — the template's own didFinishLaunching / open-url methods are
// left byte-for-byte alone.
const SHORTCUT_SWIFT = `    // MARK: - Home Screen quick actions (injected by scripts/patch-ios.mjs)
    //
    // A quick action is a UIApplicationShortcutItem, never a URL. Turn it
    // into the duitful://action/<name> URL the web layer already listens
    // for and hand it to Capacitor's delegate proxy, which posts it as
    // appUrlOpen and records it as the launch URL.

    private func duitfulShortcutURL(_ item: UIApplicationShortcutItem) -> URL? {
        // "com.aydiljoe.duitful.spend" -> "duitful://action/spend"
        guard let name = item.type.components(separatedBy: ".").last, !name.isEmpty else {
            return nil
        }
        return URL(string: "${APP_SCHEME}://action/" + name)
    }

    @discardableResult
    private func duitfulHandleShortcut(_ application: UIApplication, _ item: UIApplicationShortcutItem) -> Bool {
        guard let url = duitfulShortcutURL(item) else { return false }
        return ApplicationDelegateProxy.shared.application(application, open: url, options: [:])
    }

    // Warm start: the app is already alive, so this surfaces in JS as an
    // appUrlOpen event, exactly like a tapped deep link.
    func application(_ application: UIApplication, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(duitfulHandleShortcut(application, shortcutItem))
    }

    // Cold start: when the quick action LAUNCHES the app, iOS delivers the
    // item in the launch options instead of calling performActionFor. Feed
    // it to the proxy here — that sets the proxy's lastURL, which is what
    // App.getLaunchUrl() returns, so the web layer picks it up on its first
    // read just like a cold-started deep link.
    //
    // Returning false is Apple's documented "already handled" signal: it
    // stops iOS also calling performActionFor for the same tap, which would
    // otherwise log the action twice. And if a launch ever arrives without
    // the key, we return true and the performActionFor path above delivers
    // it instead — one route or the other, never both.
    func application(_ application: UIApplication, willFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // The split-payment check (DuitfulKit's DuitfulRelayWatch) has to be
        // registered before launch ends, or iOS refuses it later.
        DuitfulRelayWatch.register()
        guard let item = launchOptions?[.shortcutItem] as? UIApplicationShortcutItem else {
            return true
        }
        return !duitfulHandleShortcut(application, item)
    }
`;

if (!existsSync(APP_DELEGATE)) {
  console.error("patch-ios: AppDelegate.swift not found at", APP_DELEGATE);
  process.exit(1);
}

let swift = readFileSync(APP_DELEGATE, "utf8");

if (swift.includes("duitfulHandleShortcut")) {
  console.log("patch-ios: AppDelegate already routes quick actions, skipping.");
} else {
  // Insert before the final closing brace, which in Capacitor's template
  // (and in anything Xcode would produce) is the one that ends the
  // AppDelegate class.
  const classIdx = swift.indexOf("class AppDelegate");
  const closeIdx = swift.lastIndexOf("\n}");
  if (classIdx === -1 || closeIdx <= classIdx) {
    console.error("patch-ios: unrecognised AppDelegate.swift, cannot inject quick actions:", APP_DELEGATE);
    process.exit(1);
  }
  swift = swift.slice(0, closeIdx + 1) + SHORTCUT_SWIFT + swift.slice(closeIdx + 1);
  // DuitfulRelayWatch lives in the DuitfulKit pod (a static framework).
  if (!/^import DuitfulCapacitorKit$/m.test(swift)) swift = swift.replace(/^import UIKit$/m, "import UIKit\nimport DuitfulCapacitorKit");
  writeFileSync(APP_DELEGATE, swift);
  console.log("patch-ios: injected quick-action routing into AppDelegate.swift.");
}

/* ---------- 3b. Siri & Shortcuts (App Intents) ---------- */
// "Log a spend" and "Scan a receipt" as App Intents, so they show up in
// Siri, Spotlight and the Shortcuts app, and "Log a spend" can be the action
// of a Wallet "Transaction" automation (iOS 17+): tap Apple Pay, and the
// amount and merchant land in Duitful to confirm.
//
// They live in AppDelegate.swift because iOS only discovers App Intents
// compiled into the app target itself (an intent inside a CocoaPods
// framework is invisible to Siri), and this file is already ours to patch.
// Appended after the AppDelegate class, never inside it.
//
// The vault is encrypted under a key that only exists while the app is open
// and unlocked, and "Log a spend" runs without opening the app. So it writes
// a small plain entry (amount, merchant, time) to a queue in UserDefaults;
// DuitfulKitPlugin.drainQuickAdd hands the queue to the web layer on unlock,
// where each entry becomes a pending transaction to confirm. Same design,
// and same privacy cost, as Android's quick-add queue.
// Every string the intents show (titles, descriptions, dialogs, phrases)
// must not say "Apple" or "Siri": App Store Connect rejects the build in
// processing with ITMS-90626, after a successful upload, and only says why by
// email. 1.53.0 lost two TestFlight uploads to "Apple Pay" in a description.
// tests/e2e.mjs checks the quoted strings below.
const INTENTS_MARK = "DuitfulLogSpendIntent";
const INTENTS_SWIFT = `
// MARK: - Siri & Shortcuts (injected by scripts/patch-ios.mjs)

/// The queue "Log a spend" writes to. The key is shared with
/// DuitfulKitPlugin.quickAddKey (native/duitful-kit); rename both or neither.
enum DuitfulQuickAddQueue {
    static let key = "duitful.quickAdd.queue"
    static let cap = 50

    /// "RM12.50", "12.5", "MYR 1,234.00" -> 12.5 / 1234.0. Wallet hands the
    /// amount over as formatted currency text.
    static func parseAmount(_ raw: String) -> Double? {
        let cleaned = raw.replacingOccurrences(of: ",", with: "")
        guard let range = cleaned.range(of: #"\\d+(?:\\.\\d{1,2})?"#, options: .regularExpression),
              let value = Double(cleaned[range]), value > 0, value < 1_000_000 else { return nil }
        return (value * 100).rounded() / 100
    }

    static func append(amount: Double, merchant: String?, category: String? = nil, wallet: String? = nil) {
        let defaults = UserDefaults.standard
        var items = defaults.array(forKey: key) as? [[String: Any]] ?? []
        var entry: [String: Any] = ["a": amount, "t": Date().timeIntervalSince1970 * 1000, "s": "shortcut"]
        if let name = merchant?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            entry["c"] = String(name.prefix(60))
        }
        if let cat = category?.trimmingCharacters(in: .whitespacesAndNewlines), !cat.isEmpty {
            entry["cat"] = String(cat.prefix(32))
        }
        if let w = wallet?.trimmingCharacters(in: .whitespacesAndNewlines), !w.isEmpty {
            entry["w"] = String(w.prefix(40))
        }
        items.append(entry)
        if items.count > cap { items.removeFirst(items.count - cap) }
        defaults.set(items, forKey: key)
    }
}

@available(iOS 16.0, *)
enum DuitfulCategoryEnum: String, AppEnum {
    case food = "Food"
    case groceries = "Groceries"
    case transport = "Transport"
    case bills = "Bills"
    case health = "Health"
    case shopping = "Shopping"
    case others = "Others"

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Category"
    static var caseDisplayRepresentations: [DuitfulCategoryEnum: DisplayRepresentation] = [
        .food: "Food",
        .groceries: "Groceries",
        .transport: "Transport",
        .bills: "Bills",
        .health: "Health",
        .shopping: "Shopping",
        .others: "Others",
    ]
}

@available(iOS 16.0, *)
struct DuitfulWalletEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Wallet"
    static var defaultQuery = DuitfulWalletQuery()

    var id: String
    var name: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\\(name)")
    }
}

@available(iOS 16.0, *)
struct DuitfulWalletQuery: EntityQuery {
    private static func savedNames() -> [String] {
        UserDefaults.standard.stringArray(forKey: "duitful.assistant.wallets") ?? []
    }

    func entities(for identifiers: [String]) async throws -> [DuitfulWalletEntity] {
        let known = Set(Self.savedNames())
        return identifiers.filter { known.contains($0) }.map { DuitfulWalletEntity(id: $0, name: $0) }
    }

    func suggestedEntities() async throws -> [DuitfulWalletEntity] {
        Self.savedNames().map { DuitfulWalletEntity(id: $0, name: $0) }
    }
}

@available(iOS 16.0, *)
struct ${INTENTS_MARK}: AppIntent {
    static var title: LocalizedStringResource = "Log a spend"
    static var description = IntentDescription(
        "Adds a spend to Duitful to confirm next time you open it. Add it to a Wallet transaction automation to log every card tap.")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Amount", requestValueDialog: "How much did you spend?")
    var amount: String

    @Parameter(title: "Merchant")
    var merchant: String?

    @Parameter(title: "Category")
    var category: DuitfulCategoryEnum?

    @Parameter(title: "Wallet")
    var wallet: DuitfulWalletEntity?

    static var parameterSummary: some ParameterSummary {
        Summary("Log \\(\\.$amount) at \\(\\.$merchant) in Duitful") {
            \\.$category
            \\.$wallet
        }
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let value = DuitfulQuickAddQueue.parseAmount(amount) else {
            throw $amount.needsValueError("What was the amount? For example 12.50")
        }
        DuitfulQuickAddQueue.append(amount: value, merchant: merchant, category: category?.rawValue, wallet: wallet?.name)
        return .result(dialog: "Added to Duitful. Open it to confirm.")
    }
}

@available(iOS 16.0, *)
struct DuitfulScanReceiptIntent: AppIntent {
    static var title: LocalizedStringResource = "Scan a receipt"
    static var description = IntentDescription("Opens Duitful's receipt scanner.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        // The same door the Home Screen quick action uses.
        if let url = URL(string: "${APP_SCHEME}://action/scan") {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
        }
        return .result()
    }
}

@available(iOS 16.0, *)
struct DuitfulNoSpendTodayIntent: AppIntent {
    static var title: LocalizedStringResource = "No spend today"
    static var description = IntentDescription("Checks in today as a no-spend day to keep your Duitful streak alive.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        if let url = URL(string: "${APP_SCHEME}://action/no-spend") {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
        }
        return .result()
    }
}

@available(iOS 16.0, *)
struct DuitfulLogBySentenceIntent: AppIntent {
    static var title: LocalizedStringResource = "Tell Duitful"
    static var description = IntentDescription("Say a sentence like 'RM 40 nasi lemak, split half with Ali' and Duitful pre-fills the spend or split for 1-tap confirmation.")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Sentence", requestValueDialog: "What did you spend?")
    var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("Tell Duitful \\(\\.$text)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        let q = text.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        if let url = URL(string: "${APP_SCHEME}://action/voice?text=\\(q)") {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
        }
        return .result()
    }
}

@available(iOS 16.0, *)
struct DuitfulCreateSplitRequestIntent: AppIntent {
    static var title: LocalizedStringResource = "Draft a split request"
    static var description = IntentDescription("Builds a ready-to-send split request message you can chain into Send Message or WhatsApp in Shortcuts, and queues the spend in Duitful.")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Total amount", requestValueDialog: "What was the total bill?")
    var totalAmount: String

    @Parameter(title: "Person", requestValueDialog: "Who are you splitting with?")
    var person: String

    @Parameter(title: "Item", default: "Shared bill")
    var item: String

    @Parameter(title: "Share percent", default: 50)
    var sharePercent: Int

    static var parameterSummary: some ParameterSummary {
        Summary("Split \\(\\.$totalAmount) for \\(\\.$item) (\\(\\.$sharePercent)%) with \\(\\.$person)")
    }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        guard let total = DuitfulQuickAddQueue.parseAmount(totalAmount) else {
            throw $totalAmount.needsValueError("What was the total amount? For example 40")
        }
        let pct = max(1, min(100, sharePercent))
        let share = ((total * Double(pct) / 100.0) * 100).rounded() / 100
        let cleanPerson = person.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanItem = item.trimmingCharacters(in: .whitespacesAndNewlines)
        DuitfulQuickAddQueue.append(amount: total, merchant: cleanItem.isEmpty ? "Shared bill" : cleanItem)
        let msg = String(format: "Hi %@, your share for %@ is RM %.2f (from RM %.2f total).", cleanPerson, cleanItem.isEmpty ? "our bill" : cleanItem, share, total)
        return .result(value: msg, dialog: "Drafted split request for \\(cleanPerson).")
    }
}

// Siri only runs an App Shortcut when what you say is close to one of these
// phrases; anything else goes to Siri's own answer ("Duitful does not
// support Siri"). A phrase can't carry the amount (only an AppEntity or
// AppEnum can be spoken inline), so each one starts the intent and Siri asks
// "How much did you spend?".
// Keep 3 to 5 plain English phrases per shortcut, in the base language only.
// 1.69.0 to 1.70.0 mixed Malay and Chinese lines into this English list, and
// Siri on a real iPhone never picked the shortcuts up. Other languages belong
// in an AppShortcuts.strings per .lproj, keyed by these English phrases (Siri
// has no Malay, so a Malay list would never be heard). tests/e2e.mjs checks it.
@available(iOS 17.0, *)
struct DuitfulAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ${INTENTS_MARK}(), phrases: [
            "Log a spend in \\(.applicationName)",
            "Add a spend to \\(.applicationName)",
            "Add spending to \\(.applicationName)",
            "Log spending in \\(.applicationName)",
            "Add an expense to \\(.applicationName)",
        ], shortTitle: "Log a spend", systemImageName: "plus.circle")
        AppShortcut(intent: DuitfulScanReceiptIntent(), phrases: [
            "Scan a receipt in \\(.applicationName)",
            "Scan a receipt with \\(.applicationName)",
            "Scan receipt in \\(.applicationName)",
        ], shortTitle: "Scan a receipt", systemImageName: "doc.viewfinder")
        AppShortcut(intent: DuitfulNoSpendTodayIntent(), phrases: [
            "No spend today in \\(.applicationName)",
            "Mark no spend today in \\(.applicationName)",
            "Log a no spend day in \\(.applicationName)",
        ], shortTitle: "No spend today", systemImageName: "flame")
        AppShortcut(intent: DuitfulLogBySentenceIntent(), phrases: [
            "Tell \\(.applicationName)",
            "Tell \\(.applicationName) what I spent",
            "Log by voice in \\(.applicationName)",
            "Help me log in \\(.applicationName)",
            "Log it in \\(.applicationName)",
        ], shortTitle: "Tell Duitful", systemImageName: "mic")
    }
}
`;

{
  let swift = readFileSync(APP_DELEGATE, "utf8");
  if (swift.includes(INTENTS_MARK)) {
    console.log("patch-ios: AppDelegate already has the Siri & Shortcuts intents, skipping.");
  } else {
    if (!/^import UIKit$/m.test(swift)) {
      console.error("patch-ios: no `import UIKit` in AppDelegate.swift, cannot add App Intents:", APP_DELEGATE);
      process.exit(1);
    }
    if (!/^import AppIntents$/m.test(swift)) swift = swift.replace(/^import UIKit$/m, "import UIKit\nimport AppIntents");
    swift = swift.replace(/\s*$/, "\n") + INTENTS_SWIFT;
    writeFileSync(APP_DELEGATE, swift);
    console.log("patch-ios: added the Siri & Shortcuts App Intents to AppDelegate.swift.");
  }
}

// iOS only refreshes the App Shortcuts it shows Siri and Spotlight when the
// app tells it to; call it once per launch, from the template's own
// didFinishLaunching (the one line we add inside a Capacitor method).
const SHORTCUTS_REFRESH = "DuitfulAppShortcuts.updateAppShortcutParameters()";
{
  let swift = readFileSync(APP_DELEGATE, "utf8");
  if (swift.includes(SHORTCUTS_REFRESH)) {
    console.log("patch-ios: AppDelegate already refreshes the App Shortcuts, skipping.");
  } else {
    const re = /(func application\(_ application: UIApplication, didFinishLaunchingWithOptions [^{]*\{\n)/;
    if (!re.test(swift)) {
      console.error("patch-ios: no didFinishLaunchingWithOptions in AppDelegate.swift, cannot register App Shortcuts:", APP_DELEGATE);
      process.exit(1);
    }
    swift = swift.replace(re, `$1        if #available(iOS 17.0, *) { ${SHORTCUTS_REFRESH} }\n`);
    writeFileSync(APP_DELEGATE, swift);
    console.log("patch-ios: AppDelegate refreshes the App Shortcuts at launch.");
  }
}

/* ---------- 3c. App privacy manifest (PrivacyInfo.xcprivacy) ---------- */
// App Store Connect refuses a build whose own binary calls a "required
// reason" API without declaring why. The pods that ship their own manifest
// (Capacitor) cover their frameworks, but static pods such as
// DuitfulCapacitorKit link into the app binary itself, and the Siri &
// Shortcuts queue above lives in AppDelegate.swift: both use UserDefaults,
// for this app's own data only (reason CA92.1). The collected-data entry
// mirrors the App Privacy answers in APP_STORE_LISTING.md (purchase history
// for referral commissions, not linked, not tracking); keep them in step.
const PRIVACY_MANIFEST = resolve(IOS_APP, "App/PrivacyInfo.xcprivacy");
const PRIVACY_MANIFEST_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>NSPrivacyTracking</key>
\t<false/>
\t<key>NSPrivacyTrackingDomains</key>
\t<array/>
\t<key>NSPrivacyCollectedDataTypes</key>
\t<array>
\t\t<dict>
\t\t\t<key>NSPrivacyCollectedDataType</key>
\t\t\t<string>NSPrivacyCollectedDataTypePurchaseHistory</string>
\t\t\t<key>NSPrivacyCollectedDataTypeLinked</key>
\t\t\t<false/>
\t\t\t<key>NSPrivacyCollectedDataTypeTracking</key>
\t\t\t<false/>
\t\t\t<key>NSPrivacyCollectedDataTypePurposes</key>
\t\t\t<array>
\t\t\t\t<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
\t\t\t</array>
\t\t</dict>
\t</array>
\t<key>NSPrivacyAccessedAPITypes</key>
\t<array>
\t\t<dict>
\t\t\t<key>NSPrivacyAccessedAPIType</key>
\t\t\t<string>NSPrivacyAccessedAPICategoryUserDefaults</string>
\t\t\t<key>NSPrivacyAccessedAPITypeReasons</key>
\t\t\t<array>
\t\t\t\t<string>CA92.1</string>
\t\t\t</array>
\t\t</dict>
\t</array>
</dict>
</plist>
`;

if (!existsSync(PRIVACY_MANIFEST) || readFileSync(PRIVACY_MANIFEST, "utf8") !== PRIVACY_MANIFEST_BODY) {
  writeFileSync(PRIVACY_MANIFEST, PRIVACY_MANIFEST_BODY);
  console.log("patch-ios: wrote App/PrivacyInfo.xcprivacy.");
}
{
  let proj = readFileSync(PBXPROJ, "utf8");
  if (proj.includes("PrivacyInfo.xcprivacy in Resources")) {
    console.log("patch-ios: PrivacyInfo.xcprivacy already in the App target, skipping.");
  } else {
    const ref = pbxUuid("privacyManifestRef");
    const build = pbxUuid("privacyManifestBuildFile");
    if (proj.includes(ref) || proj.includes(build)) {
      console.error("patch-ios: privacy manifest UUID collides with an existing object.");
      process.exit(1);
    }
    const appTarget = pbxObjects(proj, "PBXNativeTarget")
      .find((o) => o.body.includes('productType = "com.apple.product-type.application";'));
    const resources = appTarget && appTarget.body.match(/([0-9A-F]{24}) \/\* Resources \*\//);
    const appGroup = pbxObjects(proj, "PBXGroup").find((o) => o.body.includes("/* AppDelegate.swift */"));
    if (!resources || !appGroup) {
      console.error("patch-ios: couldn't find the App target's Resources phase or the App group in", PBXPROJ);
      process.exit(1);
    }
    proj = pbxAppend(proj, "PBXBuildFile",
      `\t\t${build} /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = ${ref} /* PrivacyInfo.xcprivacy */; };\n`);
    proj = pbxAppend(proj, "PBXFileReference",
      `\t\t${ref} /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };\n`);
    proj = pbxAddToList(proj, appGroup.uuid, "children", `${ref} /* PrivacyInfo.xcprivacy */,`);
    proj = pbxAddToList(proj, resources[1], "files", `${build} /* PrivacyInfo.xcprivacy in Resources */,`);
    writeFileSync(PBXPROJ, proj);
    console.log("patch-ios: added PrivacyInfo.xcprivacy to the App target's resources.");
  }
}

/* ---------- 4. Home Screen widget (WidgetKit extension) ---------- */
// A widget extension is a SEPARATE PROCESS. It cannot decrypt anything:
// the vault is AES-GCM sealed under a key derived from the user's passcode
// and that key exists only in the app's memory. So this widget is
// deliberately ACTIONS ONLY — no amount, no balance, no count, no date, no
// name. There is no App Group, no shared UserDefaults suite, no shared
// container and no file the extension reads. Nothing is written outside
// the encrypted vault, which is the whole point of the product; adding a
// shared container "for later" would quietly undo that, so it is not here
// and must not be added.
//
// The four regions open duitful://action/<name> — the same contract as the
// quick actions in section 2, on the same scheme registered there, parsed
// by the same code in app/script.js. One scheme, one URL shape.
//
// ios/ is git-ignored and regenerated by `npx cap add ios` on every CI
// run, so the extension cannot be committed; it has to be injected here,
// which means doing by hand what Xcode's "New Target" sheet would do:
// write the sources, then add a second PBXNativeTarget with its file
// references, sources/frameworks build phases, XCBuildConfiguration pair
// and configuration list, plus an Embed App Extensions copy-files phase
// and a target dependency on the App target.
//
// WHY THIS SECTION SITS HERE, ahead of the entitlement work: both of the
// sections below exit(0) early — section 5 on the env switch, section 6
// once CODE_SIGN_ENTITLEMENTS is already present, which is every re-run —
// so anything placed after them would silently stop running. Section 6
// re-reads project.pbxproj from disk, so it picks up the file this section
// has just written.
if (!existsSync(PBXPROJ)) {
  console.error("patch-ios: project.pbxproj not found at", PBXPROJ);
  process.exit(1);
}

// Written with String.raw: the Swift below is full of backslashes
// (@Environment(\.colorScheme), keypaths) that an ordinary template
// literal would eat, turning valid Swift into code that does not compile.
// ${...} still interpolates, which is all this needs.
const WIDGET_SWIFT_BODY = String.raw`//  ${WIDGET_NAME}.swift
//  Generated by scripts/patch-ios.mjs — do not edit here. ios/ is
//  git-ignored and regenerated on every build; edit the generator.
//
//  Option D Home Screen & Lock Screen widget: month countdown ring ("12d"),
//  sage/peach/butter tiles, and quick-action pills, following the user's
//  Light / Dark / Pastel palette. Never shows a balance or amount.

import AppIntents
import SwiftUI
import WidgetKit

// MARK: - Palette (Light, Dark, Pastel)

private enum DuitfulThemeMode: String {
    case light
    case dark
    case pastel
}

private enum DuitfulPalette {
    static func resolve(_ choice: String, scheme: ColorScheme) -> DuitfulThemeMode {
        if choice == "pastel" { return .pastel }
        if choice == "light" { return .light }
        if choice == "dark" { return .dark }
        return scheme == .dark ? .dark : .light
    }

    static func canvas(_ mode: DuitfulThemeMode) -> Color {
        switch mode {
        case .pastel: return Color(red: 0.992, green: 0.945, blue: 0.890) // #fdf1e3
        case .dark:   return Color(red: 0.133, green: 0.118, blue: 0.102) // #221e1a
        case .light:  return Color(red: 0.976, green: 0.961, blue: 0.929) // #f9f5ed
        }
    }

    static func well(_ mode: DuitfulThemeMode) -> Color {
        switch mode {
        case .pastel: return Color(red: 0.961, green: 0.878, blue: 0.792) // #f5e0ca
        case .dark:   return Color(red: 0.180, green: 0.157, blue: 0.137) // #2e2823
        case .light:  return Color(red: 0.925, green: 0.898, blue: 0.847) // #ece5d8
        }
    }

    static func sage(_ mode: DuitfulThemeMode) -> Color {
        switch mode {
        case .pastel: return Color(red: 0.769, green: 0.800, blue: 0.737) // #c4ccbc
        case .dark:   return Color(red: 0.192, green: 0.231, blue: 0.196) // #313b32
        case .light:  return Color(red: 0.863, green: 0.898, blue: 0.827) // #dce5d3
        }
    }

    static func peach(_ mode: DuitfulThemeMode) -> Color {
        switch mode {
        case .pastel: return Color(red: 0.988, green: 0.831, blue: 0.737) // #fcd4bc
        case .dark:   return Color(red: 0.239, green: 0.169, blue: 0.133) // #3d2b22
        case .light:  return Color(red: 0.949, green: 0.875, blue: 0.827) // #f2dfd3
        }
    }

    static func butter(_ mode: DuitfulThemeMode) -> Color {
        switch mode {
        case .pastel: return Color(red: 0.988, green: 0.784, blue: 0.424) // #fcc86c
        case .dark:   return Color(red: 0.259, green: 0.204, blue: 0.125) // #423420
        case .light:  return Color(red: 0.953, green: 0.890, blue: 0.776) // #f3e3c6
        }
    }

    static func action(_ mode: DuitfulThemeMode) -> Color {
        switch mode {
        case .pastel: return Color(red: 0.941, green: 0.565, blue: 0.392) // #f09064
        case .dark:   return Color(red: 0.910, green: 0.835, blue: 0.725) // #e8d5b9
        case .light:  return Color(red: 0.110, green: 0.169, blue: 0.220) // #1c2b38
        }
    }

    static func actionText(_ mode: DuitfulThemeMode) -> Color {
        switch mode {
        case .pastel: return Color(red: 0.165, green: 0.102, blue: 0.063) // #2a1a10
        case .dark:   return Color(red: 0.098, green: 0.086, blue: 0.078) // #191614
        case .light:  return Color(red: 0.976, green: 0.961, blue: 0.929) // #f9f5ed
        }
    }

    static func ink(_ mode: DuitfulThemeMode) -> Color {
        switch mode {
        case .pastel: return Color(red: 0.239, green: 0.169, blue: 0.122) // #3d2b1f
        case .dark:   return Color(red: 0.953, green: 0.929, blue: 0.882) // #f3ede1
        case .light:  return Color(red: 0.141, green: 0.122, blue: 0.102) // #241f1a
        }
    }

    static func ink2(_ mode: DuitfulThemeMode) -> Color {
        switch mode {
        case .pastel: return Color(red: 0.341, green: 0.255, blue: 0.184) // #57412f
        case .dark:   return Color(red: 0.769, green: 0.741, blue: 0.690) // #c4bdb0
        case .light:  return Color(red: 0.341, green: 0.306, blue: 0.271) // #574e45
        }
    }

    static func ringArc(_ mode: DuitfulThemeMode, tone: String) -> Color {
        if tone == "over" {
            return mode == .dark
                ? Color(red: 0.878, green: 0.447, blue: 0.467)
                : Color(red: 0.690, green: 0.180, blue: 0.227)
        }
        if tone == "warn" {
            return mode == .dark
                ? Color(red: 0.941, green: 0.694, blue: 0.478)
                : Color(red: 0.851, green: 0.467, blue: 0.141)
        }
        switch mode {
        case .pastel: return Color(red: 0.310, green: 0.541, blue: 0.471) // #4f8a78
        case .dark:   return Color(red: 0.612, green: 0.769, blue: 0.698) // #9cc4b2
        case .light:  return Color(red: 0.239, green: 0.435, blue: 0.271) // #3d6f45
        }
    }
}

// MARK: - Action contract

struct DuitfulAction: Identifiable {
    let id: String
    let title: String
    let symbol: String

    var url: URL {
        URL(string: "${APP_SCHEME}://action/" + id) ?? URL(fileURLWithPath: "/")
    }

    static let all: [DuitfulAction] = [
        DuitfulAction(id: "spend", title: "Spend", symbol: "plus.circle.fill"),
        DuitfulAction(id: "scan", title: "Scan receipt", symbol: "camera.fill"),
        DuitfulAction(id: "split", title: "Split", symbol: "person.2.fill"),
        DuitfulAction(id: "debt", title: "Pay debt", symbol: "creditcard.fill"),
    ]

    static var primary: DuitfulAction { all[0] }
    static var scan: DuitfulAction { all[1] }
    static var split: DuitfulAction { all[2] }
    static var debt: DuitfulAction { all[3] }
    static let noSpend = DuitfulAction(id: "no-spend", title: "No spend", symbol: "flame.fill")
}

// MARK: - Timeline & Summary

struct DuitfulEntry: TimelineEntry {
    let date: Date
    let themeChoice: String
    let locked: Bool
    let status: String
    let tone: String
    let month: String
    let daysLeft: Int
    let dayFraction: Double
    let daysLeftShort: String
    let daysLeftLong: String
    let reviewCount: Int
    let reviewWord: String
    let comingUp: String
    let due1Name: String
    let due1When: String
    let due2Name: String
    let due2When: String
    let dueSub: String
    let logSpendLabel: String
    let scanLabel: String
    let splitLabel: String
    let streakDays: Int
    let streakLabel: String

    static func current(at now: Date = Date()) -> DuitfulEntry {
        let cal = Calendar.current
        let day = cal.component(.day, from: now)
        let range = cal.range(of: .day, in: .month, for: now) ?? 1..<31
        let total = max(1, range.count)
        let left = max(1, total - day + 1)
        let frac = min(1.0, max(0.08, Double(day) / Double(total)))
        let fmt = DateFormatter()
        fmt.dateFormat = "MMMM"
        let defaultMonth = fmt.string(from: now)

        let raw = UserDefaults.standard.dictionary(forKey: "duitful.widget.summary") ?? [:]
        let locked = (raw["locked"] as? Bool) ?? false
        let theme = (raw["theme"] as? String) ?? "system"
        let status = !locked ? ((raw["status"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "On track") : "Duitful"
        let tone = !locked ? ((raw["tone"] as? String) ?? "ok") : "ok"
        let month = (raw["month"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? defaultMonth
        let daysShort = (raw["daysLeftShort"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "\(left)d"
        let daysLong = (raw["daysLeftLong"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "\(left) days left"
        let revCount = (raw["reviewCount"] as? Int) ?? 0
        let revWord = (raw["reviewWord"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "to review"
        let coming = (raw["comingUp"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Coming up"
        let d1Name = !locked ? ((raw["due1Name"] as? String) ?? "") : ""
        let d1When = !locked ? ((raw["due1When"] as? String) ?? "") : ""
        let d2Name = !locked ? ((raw["due2Name"] as? String) ?? "") : ""
        let d2When = !locked ? ((raw["due2When"] as? String) ?? "") : ""
        let dSub = !locked ? ((raw["dueSub"] as? String) ?? "") : ""
        let logLbl = (raw["logSpendLabel"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "+ Log a spend"
        let scanLbl = (raw["scanLabel"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Scan receipt"
        let splitLbl = (raw["splitLabel"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Split"
        let sDays = !locked ? max(0, (raw["streakDays"] as? Int) ?? 0) : 0
        let sLbl = (!locked && sDays > 0) ? ((raw["streakLabel"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "🔥 \(sDays)d") : ""

        return DuitfulEntry(
            date: now,
            themeChoice: theme,
            locked: locked,
            status: status,
            tone: tone,
            month: month,
            daysLeft: left,
            dayFraction: frac,
            daysLeftShort: daysShort,
            daysLeftLong: daysLong,
            reviewCount: revCount,
            reviewWord: revWord,
            comingUp: coming,
            due1Name: d1Name,
            due1When: d1When,
            due2Name: d2Name,
            due2When: d2When,
            dueSub: dSub,
            logSpendLabel: logLbl,
            scanLabel: scanLbl,
            splitLabel: splitLbl,
            streakDays: sDays,
            streakLabel: sLbl
        )
    }

    var monthWithStreak: String {
        streakLabel.isEmpty ? month : "\(month) · \(streakLabel)"
    }
}

struct DuitfulProvider: TimelineProvider {
    func placeholder(in context: Context) -> DuitfulEntry {
        DuitfulEntry.current()
    }

    func getSnapshot(in context: Context, completion: @escaping (DuitfulEntry) -> Void) {
        completion(DuitfulEntry.current())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DuitfulEntry>) -> Void) {
        let now = Date()
        let nextMidnight = Calendar.current.nextDate(
            after: now,
            matching: DateComponents(hour: 0, minute: 1),
            matchingPolicy: .nextTime
        ) ?? now.addingTimeInterval(3600)
        completion(Timeline(entries: [DuitfulEntry.current(at: now)], policy: .after(nextMidnight)))
    }
}

// MARK: - Option D Pieces

private struct DuitfulMonthRing: View {
    let entry: DuitfulEntry
    let mode: DuitfulThemeMode
    let size: CGFloat
    let lineWidth: CGFloat

    var body: some View {
        ZStack {
            Circle()
                .stroke(DuitfulPalette.ink(mode).opacity(0.14), lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: CGFloat(entry.dayFraction))
                .stroke(
                    DuitfulPalette.ringArc(mode, tone: entry.tone),
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
            Text(entry.daysLeftShort)
                .font(.system(size: size * 0.23, weight: .heavy, design: .rounded))
                .foregroundColor(DuitfulPalette.ink(mode))
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Kira, the receipt friend (1.72.0)
//
// A small static face on the status tile, drawn with SwiftUI Shapes from
// the same 64x72 drawing as app/kira.js: proud (^^ eyes, open smile) while
// a check-in streak runs, happy otherwise. Paper = canvas, outline = the
// month ring's arc colour, face = ink, from the user's Light / Dark /
// Pastel palette. Decorative: hidden from VoiceOver. No animation.

private struct DuitfulKiraBody: Shape {
    func path(in rect: CGRect) -> Path {
        let sx = rect.width / 64
        let sy = rect.height / 72
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * sx, y: rect.minY + y * sy)
        }
        var p = Path()
        p.move(to: pt(12, 5))
        p.addLine(to: pt(52, 5))
        p.addQuadCurve(to: pt(57, 10), control: pt(57, 5))
        p.addLine(to: pt(57, 65))
        var x: CGFloat = 57
        var down = false
        while x > 13 {
            x -= 5.6
            p.addLine(to: pt(x, down ? 65 : 61.4))
            down.toggle()
        }
        p.addLine(to: pt(7, 65))
        p.addLine(to: pt(7, 10))
        p.addQuadCurve(to: pt(12, 5), control: pt(7, 5))
        p.closeSubpath()
        return p
    }
}

private struct DuitfulKiraFace: Shape {
    let proud: Bool
    let strokes: Bool

    func path(in rect: CGRect) -> Path {
        let sx = rect.width / 64
        let sy = rect.height / 72
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * sx, y: rect.minY + y * sy)
        }
        var p = Path()
        if strokes {
            if proud {
                p.move(to: pt(20.5, 39))
                p.addQuadCurve(to: pt(27.5, 39), control: pt(24, 35))
                p.move(to: pt(36.5, 39))
                p.addQuadCurve(to: pt(43.5, 39), control: pt(40, 35))
            } else {
                p.move(to: pt(27, 45))
                p.addQuadCurve(to: pt(37, 45), control: pt(32, 50))
            }
        } else if proud {
            p.move(to: pt(26, 44))
            p.addQuadCurve(to: pt(38, 44), control: pt(32, 51))
            p.closeSubpath()
        } else {
            p.addEllipse(in: CGRect(x: rect.minX + 21.2 * sx, y: rect.minY + 35.2 * sy, width: 5.6 * sx, height: 5.6 * sy))
            p.addEllipse(in: CGRect(x: rect.minX + 37.2 * sx, y: rect.minY + 35.2 * sy, width: 5.6 * sx, height: 5.6 * sy))
        }
        return p
    }
}

private struct DuitfulKiraView: View {
    let mode: DuitfulThemeMode
    let proud: Bool

    var body: some View {
        ZStack {
            DuitfulKiraBody()
                .fill(DuitfulPalette.canvas(mode))
            DuitfulKiraBody()
                .stroke(DuitfulPalette.ringArc(mode, tone: ""), style: StrokeStyle(lineWidth: 1.4, lineJoin: .round))
            DuitfulKiraFace(proud: proud, strokes: false)
                .fill(DuitfulPalette.ink(mode))
            DuitfulKiraFace(proud: proud, strokes: true)
                .stroke(DuitfulPalette.ink(mode), style: StrokeStyle(lineWidth: 1.4, lineCap: .round, lineJoin: .round))
        }
        .frame(width: 24, height: 27)
        .accessibilityHidden(true)
    }
}

// MARK: - Families (Option D)

private struct DuitfulSmallView: View {
    let entry: DuitfulEntry
    let mode: DuitfulThemeMode

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                DuitfulMonthRing(entry: entry, mode: mode, size: 42, lineWidth: 5.5)
                VStack(alignment: .leading, spacing: 1) {
                    Text(entry.status)
                        .font(.system(size: 15, weight: .heavy, design: .rounded))
                        .foregroundColor(DuitfulPalette.ink(mode))
                        .lineLimit(1)
                    Text(entry.reviewCount > 0 ? "\(entry.reviewCount) \(entry.reviewWord)" : (!entry.streakLabel.isEmpty ? entry.streakLabel : entry.month))
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundColor(DuitfulPalette.ink2(mode))
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(entry.reviewCount > 0 ? DuitfulPalette.butter(mode) : DuitfulPalette.sage(mode))
            )

            Spacer(minLength: 0)

            Text(entry.logSpendLabel)
                .font(.system(size: 14, weight: .heavy, design: .rounded))
                .foregroundColor(DuitfulPalette.actionText(mode))
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(
                    Capsule()
                        .fill(DuitfulPalette.action(mode))
                )
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

private struct DuitfulMediumView: View {
    let entry: DuitfulEntry
    let mode: DuitfulThemeMode

    var body: some View {
        HStack(spacing: 10) {
            Link(destination: DuitfulAction.primary.url) {
                HStack(spacing: 10) {
                    DuitfulMonthRing(entry: entry, mode: mode, size: 54, lineWidth: 6.5)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.status)
                            .font(.system(size: 18, weight: .heavy, design: .rounded))
                            .foregroundColor(DuitfulPalette.ink(mode))
                            .lineLimit(2)
                            .minimumScaleFactor(0.85)
                        Text(entry.monthWithStreak)
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundColor(DuitfulPalette.ink2(mode))
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    DuitfulKiraView(mode: mode, proud: entry.streakDays > 0)
                }
                .padding(12)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(DuitfulPalette.sage(mode))
                )
            }

            Link(destination: entry.due1Name.isEmpty ? DuitfulAction.scan.url : DuitfulAction.debt.url) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.comingUp)
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundColor(DuitfulPalette.ink2(mode))
                    if !entry.due1Name.isEmpty {
                        Text(entry.due1Name)
                            .font(.system(size: 16, weight: .heavy, design: .rounded))
                            .foregroundColor(DuitfulPalette.ink(mode))
                            .lineLimit(1)
                        Text(entry.dueSub)
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundColor(DuitfulPalette.ink2(mode))
                            .lineLimit(1)
                    } else {
                        Text(entry.scanLabel)
                            .font(.system(size: 15, weight: .heavy, design: .rounded))
                            .foregroundColor(DuitfulPalette.ink(mode))
                            .lineLimit(1)
                        Text(entry.daysLeftLong)
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundColor(DuitfulPalette.ink2(mode))
                            .lineLimit(1)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(DuitfulPalette.peach(mode))
                )
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct DuitfulLargeView: View {
    let entry: DuitfulEntry
    let mode: DuitfulThemeMode

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                Link(destination: DuitfulAction.primary.url) {
                    HStack(spacing: 10) {
                        DuitfulMonthRing(entry: entry, mode: mode, size: 50, lineWidth: 6)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.status)
                                .font(.system(size: 19, weight: .heavy, design: .rounded))
                                .foregroundColor(DuitfulPalette.ink(mode))
                                .lineLimit(1)
                            Text(entry.monthWithStreak)
                                .font(.system(size: 12, weight: .medium, design: .rounded))
                                .foregroundColor(DuitfulPalette.ink2(mode))
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        DuitfulKiraView(mode: mode, proud: entry.streakDays > 0)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(DuitfulPalette.sage(mode))
                    )
                }

                Link(destination: DuitfulAction.primary.url) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(entry.reviewCount)")
                            .font(.system(size: 21, weight: .heavy, design: .rounded))
                            .foregroundColor(DuitfulPalette.ink(mode))
                        Text(entry.reviewWord)
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundColor(DuitfulPalette.ink2(mode))
                            .lineLimit(1)
                    }
                    .padding(12)
                    .frame(width: 92)
                    .frame(maxHeight: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(DuitfulPalette.butter(mode))
                    )
                }
            }

            Link(destination: DuitfulAction.debt.url) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(entry.comingUp)
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundColor(DuitfulPalette.ink2(mode))
                    HStack {
                        Text(entry.due1Name.isEmpty ? entry.daysLeftLong : entry.due1Name)
                            .font(.system(size: 15, weight: .bold, design: .rounded))
                            .foregroundColor(DuitfulPalette.ink(mode))
                            .lineLimit(1)
                        Spacer()
                        Text(entry.due1When)
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundColor(DuitfulPalette.ink2(mode))
                    }
                    if !entry.due2Name.isEmpty {
                        HStack {
                            Text(entry.due2Name)
                                .font(.system(size: 15, weight: .bold, design: .rounded))
                                .foregroundColor(DuitfulPalette.ink(mode))
                                .lineLimit(1)
                            Spacer()
                            Text(entry.due2When)
                                .font(.system(size: 13, weight: .medium, design: .rounded))
                                .foregroundColor(DuitfulPalette.ink2(mode))
                        }
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(DuitfulPalette.peach(mode))
                )
            }

            HStack(spacing: 8) {
                Link(destination: DuitfulAction.primary.url) {
                    Text(entry.logSpendLabel)
                        .font(.system(size: 14, weight: .heavy, design: .rounded))
                        .foregroundColor(DuitfulPalette.ink(mode))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Capsule().fill(DuitfulPalette.well(mode)))
                }
                Link(destination: DuitfulAction.debt.url) {
                    Text(DuitfulAction.debt.title)
                        .font(.system(size: 14, weight: .heavy, design: .rounded))
                        .foregroundColor(DuitfulPalette.ink(mode))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Capsule().fill(DuitfulPalette.well(mode)))
                }
            }
            .frame(height: 42)

            HStack(spacing: 8) {
                Link(destination: DuitfulAction.scan.url) {
                    Text(entry.scanLabel)
                        .font(.system(size: 14, weight: .heavy, design: .rounded))
                        .foregroundColor(DuitfulPalette.actionText(mode))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Capsule().fill(DuitfulPalette.action(mode)))
                }
                Link(destination: DuitfulAction.split.url) {
                    Text(entry.splitLabel)
                        .font(.system(size: 14, weight: .heavy, design: .rounded))
                        .foregroundColor(DuitfulPalette.ink(mode))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Capsule().fill(DuitfulPalette.well(mode)))
                }
            }
            .frame(height: 44)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Lock Screen Views

private struct DuitfulLockCircularView: View {
    let entry: DuitfulEntry

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.primary.opacity(0.25), lineWidth: 5.5)
            Circle()
                .trim(from: 0, to: CGFloat(entry.dayFraction))
                .stroke(Color.primary, style: StrokeStyle(lineWidth: 5.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text(entry.daysLeftShort)
                .font(.system(size: 13, weight: .heavy, design: .rounded))
        }
    }
}

private struct DuitfulLockRectangularView: View {
    let entry: DuitfulEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(entry.status)
                .font(.system(size: 14, weight: .heavy, design: .rounded))
                .lineLimit(1)
            Text(entry.due1Name.isEmpty ? entry.daysLeftLong : "\(entry.due1Name) · \(entry.due1When)")
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .opacity(0.85)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private extension View {
    @ViewBuilder
    func duitfulWidgetContainer(_ mode: DuitfulThemeMode) -> some View {
        if #available(iOS 17.0, *) {
            self.containerBackground(DuitfulPalette.canvas(mode), for: .widget)
        } else {
            self
                .padding(12)
                .background(DuitfulPalette.canvas(mode))
        }
    }
}

struct DuitfulWidgetEntryView: View {
    var entry: DuitfulProvider.Entry

    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var scheme

    private var mode: DuitfulThemeMode {
        DuitfulPalette.resolve(entry.themeChoice, scheme: scheme)
    }

    var body: some View {
        content.duitfulWidgetContainer(mode)
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .systemSmall:
            DuitfulSmallView(entry: entry, mode: mode).widgetURL(DuitfulAction.primary.url)
        case .systemLarge:
            DuitfulLargeView(entry: entry, mode: mode)
        case .accessoryCircular:
            DuitfulLockCircularView(entry: entry).widgetURL(DuitfulAction.primary.url)
        case .accessoryRectangular:
            DuitfulLockRectangularView(entry: entry).widgetURL(DuitfulAction.primary.url)
        default:
            DuitfulMediumView(entry: entry, mode: mode)
        }
    }
}

// MARK: - Widget

struct DuitfulActionsWidget: Widget {
    let kind = "DuitfulActionsWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: DuitfulProvider()) { entry in
            DuitfulWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Duitful")
        .description("Month pace at a glance, upcoming bills by name, and quick shortcuts. Never shows balances or amounts.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular])
    }
}

@available(iOS 18.0, *)
struct DuitfulLogSpendControl: ControlWidget {
    let kind = "DuitfulLogSpendControl"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: kind) {
            ControlWidgetButton(action: OpenURLIntent(DuitfulAction.primary.url)) {
                Label("Log a spend", systemImage: "plus.circle")
            }
        }
        .displayName("Log a spend")
        .description("Open Duitful straight to add a spend.")
    }
}

@available(iOS 18.0, *)
struct DuitfulScanReceiptControl: ControlWidget {
    let kind = "DuitfulScanReceiptControl"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: kind) {
            ControlWidgetButton(action: OpenURLIntent(DuitfulAction.scan.url)) {
                Label("Scan a receipt", systemImage: "doc.viewfinder")
            }
        }
        .displayName("Scan a receipt")
        .description("Open Duitful's receipt scanner.")
    }
}

@available(iOS 18.0, *)
struct DuitfulNoSpendControl: ControlWidget {
    let kind = "DuitfulNoSpendControl"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: kind) {
            ControlWidgetButton(action: OpenURLIntent(DuitfulAction.noSpend.url)) {
                Label("No spend today", systemImage: "flame")
            }
        }
        .displayName("No spend today")
        .description("Check in a no-spend day to keep your Duitful streak alive.")
    }
}

@main
struct DuitfulWidgetBundle: WidgetBundle {
    var body: some Widget {
        DuitfulActionsWidget()
        if #available(iOS 18.0, *) {
            DuitfulLogSpendControl()
            DuitfulScanReceiptControl()
            DuitfulNoSpendControl()
        }
    }
}
`;

// CFBundlePackageType is XPC! for every .appex. The version keys are build
// settings so the Fastfile's MARKETING_VERSION / CURRENT_PROJECT_VERSION
// xcargs reach the extension too — App Store Connect rejects a bundle
// whose extension versions disagree with the app's.
const WIDGET_PLIST_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDevelopmentRegion</key>
\t<string>$(DEVELOPMENT_LANGUAGE)</string>
\t<key>CFBundleDisplayName</key>
\t<string>Duitful</string>
\t<key>CFBundleExecutable</key>
\t<string>$(EXECUTABLE_NAME)</string>
\t<key>CFBundleIdentifier</key>
\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
\t<key>CFBundleInfoDictionaryVersion</key>
\t<string>6.0</string>
\t<key>CFBundleName</key>
\t<string>$(PRODUCT_NAME)</string>
\t<key>CFBundlePackageType</key>
\t<string>XPC!</string>
\t<key>CFBundleShortVersionString</key>
\t<string>$(MARKETING_VERSION)</string>
\t<key>CFBundleVersion</key>
\t<string>$(CURRENT_PROJECT_VERSION)</string>
\t<key>NSExtension</key>
\t<dict>
\t\t<key>NSExtensionPointIdentifier</key>
\t\t<string>com.apple.widgetkit-extension</string>
\t</dict>
</dict>
</plist>
`;

mkdirSync(WIDGET_DIR, { recursive: true });
let widgetFilesWritten = 0;
for (const [path, body] of [[WIDGET_SWIFT, WIDGET_SWIFT_BODY], [WIDGET_PLIST, WIDGET_PLIST_BODY]]) {
  if (existsSync(path) && readFileSync(path, "utf8") === body) continue;
  writeFileSync(path, body);
  widgetFilesWritten++;
}
if (widgetFilesWritten) {
  console.log(`patch-ios: wrote ${widgetFilesWritten} ${WIDGET_NAME} source file(s).`);
} else {
  console.log(`patch-ios: ${WIDGET_NAME} sources already up to date, skipping.`);
}

{
  let proj = readFileSync(PBXPROJ, "utf8");

  if (proj.includes(`${WIDGET_NAME}.appex`)) {
    console.log(`patch-ios: ${WIDGET_NAME} target already in project.pbxproj, skipping.`);
  } else if (!APP_ID) {
    // Already fatal in section 2; repeated because the extension's bundle
    // id must be the app's plus a suffix or iOS refuses to install it.
    console.error("patch-ios: no appId in", CAP_CONFIG, "— cannot name the widget bundle.");
    process.exit(1);
  } else {
    // Deterministic object IDs. A pbxproj UUID is 24 uppercase hex
    // characters and only has to be unique inside this one file, so they
    // are the first 96 bits of a SHA-1 over a fixed seed. Same input,
    // same output, every run and every machine — which is what makes a
    // re-run byte-identical instead of churning the project file.
    const SEEDS = [
      "productRef", "sourceRef", "plistRef", "group",
      "sourceBuildFile", "embedBuildFile",
      "widgetKitRef", "swiftUIRef", "widgetKitBuildFile", "swiftUIBuildFile",
      "sourcesPhase", "frameworksPhase", "embedPhase",
      "target", "configList", "debugConfig", "releaseConfig",
      "dependency", "containerProxy",
    ];
    const ID = {};
    for (const seed of SEEDS) {
      const uuid = pbxUuid(seed);
      if (Object.values(ID).includes(uuid) || proj.includes(uuid)) {
        console.error(`patch-ios: generated pbxproj UUID ${uuid} (${seed}) collides with an existing object.`);
        process.exit(1);
      }
      ID[seed] = uuid;
    }

    // Anchors read out of the project rather than hard-coded: Capacitor
    // has changed these UUIDs before, and a stale constant would attach
    // the extension to nothing.
    const projectObject = pbxMatch(proj, /rootObject = ([0-9A-F]{24}) \/\* Project object \*\//, "rootObject");
    const mainGroup = pbxMatch(proj, /mainGroup = ([0-9A-F]{24});/, "mainGroup");
    const productsGroup = pbxMatch(proj, /productRefGroup = ([0-9A-F]{24})/, "productRefGroup");
    const appTarget = pbxObjects(proj, "PBXNativeTarget")
      .find((o) => o.body.includes('productType = "com.apple.product-type.application";'));
    if (!appTarget) {
      console.error("patch-ios: no application PBXNativeTarget found in", PBXPROJ);
      process.exit(1);
    }

    const settings = (config) => [
      "\t\t\t\tCLANG_ENABLE_MODULES = YES;",
      "\t\t\t\tCODE_SIGN_STYLE = Automatic;",
      "\t\t\t\tCURRENT_PROJECT_VERSION = 1;",
      `\t\t\t\tINFOPLIST_FILE = ${WIDGET_NAME}/Info.plist;`,
      `\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = ${WIDGET_DEPLOYMENT_TARGET};`,
      '\t\t\t\tLD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks";',
      "\t\t\t\tMARKETING_VERSION = 1.0;",
      `\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${APP_ID}.${WIDGET_NAME};`,
      '\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";',
      "\t\t\t\tSKIP_INSTALL = YES;",
      config === "Debug"
        ? "\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;"
        : '\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = "";',
      "\t\t\t\tSWIFT_VERSION = 5.0;",
      '\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";', // iPhone and iPad, like the app (see the last block)
    ].join("\n");

    // --- new objects, appended to their sections in Xcode's own order ---
    proj = pbxAppend(proj, "PBXBuildFile", [
      `\t\t${ID.sourceBuildFile} /* ${WIDGET_NAME}.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${ID.sourceRef} /* ${WIDGET_NAME}.swift */; };`,
      `\t\t${ID.embedBuildFile} /* ${WIDGET_NAME}.appex in Embed App Extensions */ = {isa = PBXBuildFile; fileRef = ${ID.productRef} /* ${WIDGET_NAME}.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };`,
      `\t\t${ID.widgetKitBuildFile} /* WidgetKit.framework in Frameworks */ = {isa = PBXBuildFile; fileRef = ${ID.widgetKitRef} /* WidgetKit.framework */; };`,
      `\t\t${ID.swiftUIBuildFile} /* SwiftUI.framework in Frameworks */ = {isa = PBXBuildFile; fileRef = ${ID.swiftUIRef} /* SwiftUI.framework */; };`,
      "",
    ].join("\n"));

    proj = pbxInsertSection(proj, "PBXContainerItemProxy", [
      `\t\t${ID.containerProxy} /* PBXContainerItemProxy */ = {`,
      "\t\t\tisa = PBXContainerItemProxy;",
      `\t\t\tcontainerPortal = ${projectObject} /* Project object */;`,
      "\t\t\tproxyType = 1;",
      `\t\t\tremoteGlobalIDString = ${ID.target};`,
      `\t\t\tremoteInfo = ${WIDGET_NAME};`,
      "\t\t};",
      "",
    ].join("\n"), "PBXFileReference");

    // dstSubfolderSpec 13 is PlugIns/ — the only place iOS looks for an
    // embedded app extension.
    proj = pbxInsertSection(proj, "PBXCopyFilesBuildPhase", [
      `\t\t${ID.embedPhase} /* Embed App Extensions */ = {`,
      "\t\t\tisa = PBXCopyFilesBuildPhase;",
      "\t\t\tbuildActionMask = 2147483647;",
      '\t\t\tdstPath = "";',
      "\t\t\tdstSubfolderSpec = 13;",
      "\t\t\tfiles = (",
      `\t\t\t\t${ID.embedBuildFile} /* ${WIDGET_NAME}.appex in Embed App Extensions */,`,
      "\t\t\t);",
      '\t\t\tname = "Embed App Extensions";',
      "\t\t\trunOnlyForDeploymentPostprocessing = 0;",
      "\t\t};",
      "",
    ].join("\n"), "PBXFileReference");

    proj = pbxAppend(proj, "PBXFileReference", [
      `\t\t${ID.productRef} /* ${WIDGET_NAME}.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = ${WIDGET_NAME}.appex; sourceTree = BUILT_PRODUCTS_DIR; };`,
      `\t\t${ID.sourceRef} /* ${WIDGET_NAME}.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${WIDGET_NAME}.swift; sourceTree = "<group>"; };`,
      `\t\t${ID.plistRef} /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };`,
      `\t\t${ID.widgetKitRef} /* WidgetKit.framework */ = {isa = PBXFileReference; lastKnownFileType = wrapper.framework; name = WidgetKit.framework; path = System/Library/Frameworks/WidgetKit.framework; sourceTree = SDKROOT; };`,
      `\t\t${ID.swiftUIRef} /* SwiftUI.framework */ = {isa = PBXFileReference; lastKnownFileType = wrapper.framework; name = SwiftUI.framework; path = System/Library/Frameworks/SwiftUI.framework; sourceTree = SDKROOT; };`,
      "",
    ].join("\n"));

    proj = pbxAppend(proj, "PBXFrameworksBuildPhase", [
      `\t\t${ID.frameworksPhase} /* Frameworks */ = {`,
      "\t\t\tisa = PBXFrameworksBuildPhase;",
      "\t\t\tbuildActionMask = 2147483647;",
      "\t\t\tfiles = (",
      `\t\t\t\t${ID.widgetKitBuildFile} /* WidgetKit.framework in Frameworks */,`,
      `\t\t\t\t${ID.swiftUIBuildFile} /* SwiftUI.framework in Frameworks */,`,
      "\t\t\t);",
      "\t\t\trunOnlyForDeploymentPostprocessing = 0;",
      "\t\t};",
      "",
    ].join("\n"));

    proj = pbxAppend(proj, "PBXGroup", [
      `\t\t${ID.group} /* ${WIDGET_NAME} */ = {`,
      "\t\t\tisa = PBXGroup;",
      "\t\t\tchildren = (",
      `\t\t\t\t${ID.sourceRef} /* ${WIDGET_NAME}.swift */,`,
      `\t\t\t\t${ID.plistRef} /* Info.plist */,`,
      "\t\t\t);",
      `\t\t\tpath = ${WIDGET_NAME};`,
      '\t\t\tsourceTree = "<group>";',
      "\t\t};",
      "",
    ].join("\n"));
    proj = pbxAddToList(proj, mainGroup, "children", `${ID.group} /* ${WIDGET_NAME} */,`);
    proj = pbxAddToList(proj, productsGroup, "children", `${ID.productRef} /* ${WIDGET_NAME}.appex */,`);
    // The two system frameworks live in the existing Frameworks group when
    // there is one, so no object is left dangling outside the navigator.
    const frameworksGroup = pbxObjects(proj, "PBXGroup").find((o) => o.name === "Frameworks");
    if (!frameworksGroup) {
      console.error("patch-ios: no Frameworks PBXGroup found in", PBXPROJ);
      process.exit(1);
    }
    proj = pbxAddToList(proj, frameworksGroup.uuid, "children", `${ID.widgetKitRef} /* WidgetKit.framework */,`);
    proj = pbxAddToList(proj, frameworksGroup.uuid, "children", `${ID.swiftUIRef} /* SwiftUI.framework */,`);

    proj = pbxAppend(proj, "PBXNativeTarget", [
      `\t\t${ID.target} /* ${WIDGET_NAME} */ = {`,
      "\t\t\tisa = PBXNativeTarget;",
      `\t\t\tbuildConfigurationList = ${ID.configList} /* Build configuration list for PBXNativeTarget "${WIDGET_NAME}" */;`,
      "\t\t\tbuildPhases = (",
      `\t\t\t\t${ID.sourcesPhase} /* Sources */,`,
      `\t\t\t\t${ID.frameworksPhase} /* Frameworks */,`,
      "\t\t\t);",
      "\t\t\tbuildRules = (",
      "\t\t\t);",
      "\t\t\tdependencies = (",
      "\t\t\t);",
      `\t\t\tname = ${WIDGET_NAME};`,
      `\t\t\tproductName = ${WIDGET_NAME};`,
      `\t\t\tproductReference = ${ID.productRef} /* ${WIDGET_NAME}.appex */;`,
      '\t\t\tproductType = "com.apple.product-type.app-extension";',
      "\t\t};",
      "",
    ].join("\n"));

    proj = pbxAddToList(proj, projectObject, "targets", `${ID.target} /* ${WIDGET_NAME} */,`);
    proj = pbxAddTargetAttributes(proj, projectObject, ID.target);

    proj = pbxAppend(proj, "PBXSourcesBuildPhase", [
      `\t\t${ID.sourcesPhase} /* Sources */ = {`,
      "\t\t\tisa = PBXSourcesBuildPhase;",
      "\t\t\tbuildActionMask = 2147483647;",
      "\t\t\tfiles = (",
      `\t\t\t\t${ID.sourceBuildFile} /* ${WIDGET_NAME}.swift in Sources */,`,
      "\t\t\t);",
      "\t\t\trunOnlyForDeploymentPostprocessing = 0;",
      "\t\t};",
      "",
    ].join("\n"));

    proj = pbxInsertSection(proj, "PBXTargetDependency", [
      `\t\t${ID.dependency} /* PBXTargetDependency */ = {`,
      "\t\t\tisa = PBXTargetDependency;",
      `\t\t\ttarget = ${ID.target} /* ${WIDGET_NAME} */;`,
      `\t\t\ttargetProxy = ${ID.containerProxy} /* PBXContainerItemProxy */;`,
      "\t\t};",
      "",
    ].join("\n"), "PBXVariantGroup");

    proj = pbxAppend(proj, "XCBuildConfiguration", [
      `\t\t${ID.debugConfig} /* Debug */ = {`,
      "\t\t\tisa = XCBuildConfiguration;",
      "\t\t\tbuildSettings = {",
      settings("Debug"),
      "\t\t\t};",
      "\t\t\tname = Debug;",
      "\t\t};",
      `\t\t${ID.releaseConfig} /* Release */ = {`,
      "\t\t\tisa = XCBuildConfiguration;",
      "\t\t\tbuildSettings = {",
      settings("Release"),
      "\t\t\t};",
      "\t\t\tname = Release;",
      "\t\t};",
      "",
    ].join("\n"));

    proj = pbxAppend(proj, "XCConfigurationList", [
      `\t\t${ID.configList} /* Build configuration list for PBXNativeTarget "${WIDGET_NAME}" */ = {`,
      "\t\t\tisa = XCConfigurationList;",
      "\t\t\tbuildConfigurations = (",
      `\t\t\t\t${ID.debugConfig} /* Debug */,`,
      `\t\t\t\t${ID.releaseConfig} /* Release */,`,
      "\t\t\t);",
      "\t\t\tdefaultConfigurationIsVisible = 0;",
      "\t\t\tdefaultConfigurationName = Release;",
      "\t\t};",
      "",
    ].join("\n"));

    // --- and finally hang it off the App target ---
    // Appended at the END of buildPhases so the .appex is copied after the
    // app's own Sources/Resources have run, and after CocoaPods' phases.
    proj = pbxAddToList(proj, appTarget.uuid, "buildPhases", `${ID.embedPhase} /* Embed App Extensions */,`);
    proj = pbxAddToList(proj, appTarget.uuid, "dependencies", `${ID.dependency} /* PBXTargetDependency */,`);

    writeFileSync(PBXPROJ, proj);
    console.log(`patch-ios: added the ${WIDGET_NAME} app-extension target (${APP_ID}.${WIDGET_NAME}) to project.pbxproj.`);
  }
}

/* ---------- 4c. Share Extension (PDFs & photos from WhatsApp / Files / banks) ---------- */
// Lets iOS users tap Share → Duitful from WhatsApp, Files, Mail, or banking apps.
// Copies up to 12 PDF/image files (<= 25 MB each) into the shared App Group inbox
// (group.com.aydiljoe.duitful/SharedInbox), then opens duitful://share so the
// main app drains them once unlocked (DuitfulKitPlugin.takeSharedFiles).
const SHARE_SWIFT_BODY = `import UIKit
import UniformTypeIdentifiers

@objc(DuitfulShareViewController)
final class DuitfulShareViewController: UIViewController {
    private static let appGroup = "${APP_GROUP}"
    private static let maxFiles = 12
    private static let maxBytes = 25 * 1024 * 1024
    private static let allowedExts: Set<String> = ["pdf", "jpg", "jpeg", "png", "heic", "heif", "webp"]
    private var started = false

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        stageSharedItems()
    }

    private func stageSharedItems() {
        guard let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup) else {
            finish(openApp: false)
            return
        }
        let inbox = base.appendingPathComponent("SharedInbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)

        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        let wanted = providers.filter {
            $0.hasItemConformingToTypeIdentifier(UTType.pdf.identifier)
            || $0.hasItemConformingToTypeIdentifier(UTType.image.identifier)
            || $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
        }
        if wanted.isEmpty {
            finish(openApp: false)
            return
        }

        let group = DispatchGroup()
        let lock = NSLock()
        var saved = 0
        let stamp = Int(Date().timeIntervalSince1970 * 1000)

        for (idx, provider) in wanted.prefix(Self.maxFiles).enumerated() {
            let typeId: String
            if provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) {
                typeId = UTType.pdf.identifier
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                typeId = UTType.image.identifier
            } else {
                typeId = UTType.fileURL.identifier
            }
            group.enter()
            provider.loadItem(forTypeIdentifier: typeId, options: nil) { item, _ in
                defer { group.leave() }
                if let url = item as? URL {
                    let ext = url.pathExtension.lowercased()
                    guard Self.allowedExts.contains(ext) else { return }
                    let access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    guard let data = try? Data(contentsOf: url), !data.isEmpty, data.count <= Self.maxBytes else { return }
                    let clean = url.lastPathComponent.replacingOccurrences(of: "/", with: "_")
                    let dest = inbox.appendingPathComponent(String(format: "%lld_%02d_%@", stamp, idx, clean))
                    if (try? data.write(to: dest, options: .atomic)) != nil {
                        lock.lock(); saved += 1; lock.unlock()
                    }
                } else if let img = item as? UIImage, let data = img.jpegData(compressionQuality: 0.9), data.count <= Self.maxBytes {
                    let dest = inbox.appendingPathComponent(String(format: "%lld_%02d_shared.jpg", stamp, idx))
                    if (try? data.write(to: dest, options: .atomic)) != nil {
                        lock.lock(); saved += 1; lock.unlock()
                    }
                } else if let data = item as? Data, !data.isEmpty, data.count <= Self.maxBytes {
                    let ext = typeId == UTType.pdf.identifier ? "pdf" : "jpg"
                    let dest = inbox.appendingPathComponent(String(format: "%lld_%02d_shared.%@", stamp, idx, ext))
                    if (try? data.write(to: dest, options: .atomic)) != nil {
                        lock.lock(); saved += 1; lock.unlock()
                    }
                }
            }
        }

        group.notify(queue: .main) {
            self.finish(openApp: saved > 0)
        }
    }

    private func finish(openApp: Bool) {
        if openApp, let url = URL(string: "${APP_SCHEME}://share") {
            var responder: UIResponder? = self
            let selector = NSSelectorFromString("openURL:")
            while let cur = responder {
                if cur.responds(to: selector) {
                    _ = cur.perform(selector, with: url)
                    break
                }
                responder = cur.next
            }
        }
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
`;

const SHARE_PLIST_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDevelopmentRegion</key>
\t<string>$(DEVELOPMENT_LANGUAGE)</string>
\t<key>CFBundleDisplayName</key>
\t<string>Duitful</string>
\t<key>CFBundleExecutable</key>
\t<string>$(EXECUTABLE_NAME)</string>
\t<key>CFBundleIdentifier</key>
\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
\t<key>CFBundleInfoDictionaryVersion</key>
\t<string>6.0</string>
\t<key>CFBundleName</key>
\t<string>$(PRODUCT_NAME)</string>
\t<key>CFBundlePackageType</key>
\t<string>XPC!</string>
\t<key>CFBundleShortVersionString</key>
\t<string>$(MARKETING_VERSION)</string>
\t<key>CFBundleVersion</key>
\t<string>$(CURRENT_PROJECT_VERSION)</string>
\t<key>NSExtension</key>
\t<dict>
\t\t<key>NSExtensionAttributes</key>
\t\t<dict>
\t\t\t<key>NSExtensionActivationRule</key>
\t\t\t<dict>
\t\t\t\t<key>NSExtensionActivationSupportsFileWithMaxCount</key>
\t\t\t\t<integer>12</integer>
\t\t\t\t<key>NSExtensionActivationSupportsImageWithMaxCount</key>
\t\t\t\t<integer>12</integer>
\t\t\t</dict>
\t\t</dict>
\t\t<key>NSExtensionPointIdentifier</key>
\t\t<string>com.apple.share-services</string>
\t\t<key>NSExtensionPrincipalClass</key>
\t\t<string>$(PRODUCT_MODULE_NAME).DuitfulShareViewController</string>
\t</dict>
</dict>
</plist>
`;

const SHARE_ENTITLEMENTS_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>com.apple.security.application-groups</key>
\t<array>
\t\t<string>${APP_GROUP}</string>
\t</array>
</dict>
</plist>
`;

mkdirSync(SHARE_DIR, { recursive: true });
let shareFilesWritten = 0;
for (const [p, body] of [
  [SHARE_SWIFT, SHARE_SWIFT_BODY],
  [SHARE_PLIST, SHARE_PLIST_BODY],
  [SHARE_ENTITLEMENTS, SHARE_ENTITLEMENTS_BODY],
]) {
  if (existsSync(p) && readFileSync(p, "utf8") === body) continue;
  writeFileSync(p, body);
  shareFilesWritten++;
}
if (shareFilesWritten) {
  console.log(`patch-ios: wrote ${shareFilesWritten} ${SHARE_NAME} source file(s).`);
} else {
  console.log(`patch-ios: ${SHARE_NAME} sources already up to date, skipping.`);
}

{
  let proj = readFileSync(PBXPROJ, "utf8");
  if (proj.includes(`${SHARE_NAME}.appex`)) {
    console.log(`patch-ios: ${SHARE_NAME} target already in project.pbxproj, skipping.`);
  } else if (!APP_ID) {
    console.error("patch-ios: no appId in", CAP_CONFIG, "— cannot name the share extension bundle.");
    process.exit(1);
  } else {
    const SEEDS = [
      "productRef", "sourceRef", "plistRef", "entitlementsRef", "group",
      "sourceBuildFile", "embedBuildFile",
      "sourcesPhase", "frameworksPhase",
      "target", "configList", "debugConfig", "releaseConfig",
      "dependency", "containerProxy",
    ];
    const ID = {};
    for (const seed of SEEDS) {
      const uuid = pbxUuid(`share-${seed}`);
      if (Object.values(ID).includes(uuid) || proj.includes(uuid)) {
        console.error(`patch-ios: generated pbxproj UUID ${uuid} (share-${seed}) collides with an existing object.`);
        process.exit(1);
      }
      ID[seed] = uuid;
    }

    const projectObject = pbxMatch(proj, /rootObject = ([0-9A-F]{24}) \/\* Project object \*\//, "rootObject");
    const mainGroup = pbxMatch(proj, /mainGroup = ([0-9A-F]{24});/, "mainGroup");
    const productsGroup = pbxMatch(proj, /productRefGroup = ([0-9A-F]{24})/, "productRefGroup");
    const appTarget = pbxObjects(proj, "PBXNativeTarget")
      .find((o) => o.body.includes('productType = "com.apple.product-type.application";'));
    const embedPhase = pbxObjects(proj, "PBXCopyFilesBuildPhase")
      .find((o) => o.body.includes("dstSubfolderSpec = 13;"));
    if (!appTarget || !embedPhase) {
      console.error("patch-ios: missing App target or Embed App Extensions phase in", PBXPROJ);
      process.exit(1);
    }

    const settings = (config) => [
      "\t\t\t\tCLANG_ENABLE_MODULES = YES;",
      `\t\t\t\tCODE_SIGN_ENTITLEMENTS = ${SHARE_NAME}/${SHARE_NAME}.entitlements;`,
      "\t\t\t\tCODE_SIGN_STYLE = Automatic;",
      "\t\t\t\tCURRENT_PROJECT_VERSION = 1;",
      `\t\t\t\tINFOPLIST_FILE = ${SHARE_NAME}/Info.plist;`,
      `\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = ${SHARE_DEPLOYMENT_TARGET};`,
      '\t\t\t\tLD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks";',
      "\t\t\t\tMARKETING_VERSION = 1.0;",
      `\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${APP_ID}.${SHARE_NAME};`,
      '\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";',
      "\t\t\t\tSKIP_INSTALL = YES;",
      config === "Debug"
        ? "\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;"
        : '\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = "";',
      "\t\t\t\tSWIFT_VERSION = 5.0;",
      '\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";',
    ].join("\n");

    proj = pbxAppend(proj, "PBXBuildFile", [
      `\t\t${ID.sourceBuildFile} /* ${SHARE_NAME}.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${ID.sourceRef} /* ${SHARE_NAME}.swift */; };`,
      `\t\t${ID.embedBuildFile} /* ${SHARE_NAME}.appex in Embed App Extensions */ = {isa = PBXBuildFile; fileRef = ${ID.productRef} /* ${SHARE_NAME}.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };`,
      "",
    ].join("\n"));

    proj = pbxAppend(proj, "PBXContainerItemProxy", [
      `\t\t${ID.containerProxy} /* PBXContainerItemProxy */ = {`,
      "\t\t\tisa = PBXContainerItemProxy;",
      `\t\t\tcontainerPortal = ${projectObject} /* Project object */;`,
      "\t\t\tproxyType = 1;",
      `\t\t\tremoteGlobalIDString = ${ID.target};`,
      `\t\t\tremoteInfo = ${SHARE_NAME};`,
      "\t\t};",
      "",
    ].join("\n"));

    proj = pbxAppend(proj, "PBXFileReference", [
      `\t\t${ID.productRef} /* ${SHARE_NAME}.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = ${SHARE_NAME}.appex; sourceTree = BUILT_PRODUCTS_DIR; };`,
      `\t\t${ID.sourceRef} /* ${SHARE_NAME}.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${SHARE_NAME}.swift; sourceTree = "<group>"; };`,
      `\t\t${ID.plistRef} /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };`,
      `\t\t${ID.entitlementsRef} /* ${SHARE_NAME}.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = ${SHARE_NAME}.entitlements; sourceTree = "<group>"; };`,
      "",
    ].join("\n"));

    proj = pbxAppend(proj, "PBXFrameworksBuildPhase", [
      `\t\t${ID.frameworksPhase} /* Frameworks */ = {`,
      "\t\t\tisa = PBXFrameworksBuildPhase;",
      "\t\t\tbuildActionMask = 2147483647;",
      "\t\t\tfiles = (",
      "\t\t\t);",
      "\t\t\trunOnlyForDeploymentPostprocessing = 0;",
      "\t\t};",
      "",
    ].join("\n"));

    proj = pbxAppend(proj, "PBXGroup", [
      `\t\t${ID.group} /* ${SHARE_NAME} */ = {`,
      "\t\t\tisa = PBXGroup;",
      "\t\t\tchildren = (",
      `\t\t\t\t${ID.sourceRef} /* ${SHARE_NAME}.swift */,`,
      `\t\t\t\t${ID.plistRef} /* Info.plist */,`,
      `\t\t\t\t${ID.entitlementsRef} /* ${SHARE_NAME}.entitlements */,`,
      "\t\t\t);",
      `\t\t\tpath = ${SHARE_NAME};`,
      '\t\t\tsourceTree = "<group>";',
      "\t\t};",
      "",
    ].join("\n"));
    proj = pbxAddToList(proj, mainGroup, "children", `${ID.group} /* ${SHARE_NAME} */,`);
    proj = pbxAddToList(proj, productsGroup, "children", `${ID.productRef} /* ${SHARE_NAME}.appex */,`);

    proj = pbxAppend(proj, "PBXNativeTarget", [
      `\t\t${ID.target} /* ${SHARE_NAME} */ = {`,
      "\t\t\tisa = PBXNativeTarget;",
      `\t\t\tbuildConfigurationList = ${ID.configList} /* Build configuration list for PBXNativeTarget "${SHARE_NAME}" */;`,
      "\t\t\tbuildPhases = (",
      `\t\t\t\t${ID.sourcesPhase} /* Sources */,`,
      `\t\t\t\t${ID.frameworksPhase} /* Frameworks */,`,
      "\t\t\t);",
      "\t\t\tbuildRules = (",
      "\t\t\t);",
      "\t\t\tdependencies = (",
      "\t\t\t);",
      `\t\t\tname = ${SHARE_NAME};`,
      `\t\t\tproductName = ${SHARE_NAME};`,
      `\t\t\tproductReference = ${ID.productRef} /* ${SHARE_NAME}.appex */;`,
      '\t\t\tproductType = "com.apple.product-type.app-extension";',
      "\t\t};",
      "",
    ].join("\n"));

    proj = pbxAddToList(proj, projectObject, "targets", `${ID.target} /* ${SHARE_NAME} */,`);
    proj = pbxAddTargetAttributes(proj, projectObject, ID.target);

    proj = pbxAppend(proj, "PBXSourcesBuildPhase", [
      `\t\t${ID.sourcesPhase} /* Sources */ = {`,
      "\t\t\tisa = PBXSourcesBuildPhase;",
      "\t\t\tbuildActionMask = 2147483647;",
      "\t\t\tfiles = (",
      `\t\t\t\t${ID.sourceBuildFile} /* ${SHARE_NAME}.swift in Sources */,`,
      "\t\t\t);",
      "\t\t\trunOnlyForDeploymentPostprocessing = 0;",
      "\t\t};",
      "",
    ].join("\n"));

    proj = pbxAppend(proj, "PBXTargetDependency", [
      `\t\t${ID.dependency} /* PBXTargetDependency */ = {`,
      "\t\t\tisa = PBXTargetDependency;",
      `\t\t\ttarget = ${ID.target} /* ${SHARE_NAME} */;`,
      `\t\t\ttargetProxy = ${ID.containerProxy} /* PBXContainerItemProxy */;`,
      "\t\t};",
      "",
    ].join("\n"));

    proj = pbxAppend(proj, "XCBuildConfiguration", [
      `\t\t${ID.debugConfig} /* Debug */ = {`,
      "\t\t\tisa = XCBuildConfiguration;",
      "\t\t\tbuildSettings = {",
      settings("Debug"),
      "\t\t\t};",
      "\t\t\tname = Debug;",
      "\t\t};",
      `\t\t${ID.releaseConfig} /* Release */ = {`,
      "\t\t\tisa = XCBuildConfiguration;",
      "\t\t\tbuildSettings = {",
      settings("Release"),
      "\t\t\t};",
      "\t\t\tname = Release;",
      "\t\t};",
      "",
    ].join("\n"));

    proj = pbxAppend(proj, "XCConfigurationList", [
      `\t\t${ID.configList} /* Build configuration list for PBXNativeTarget "${SHARE_NAME}" */ = {`,
      "\t\t\tisa = XCConfigurationList;",
      "\t\t\tbuildConfigurations = (",
      `\t\t\t\t${ID.debugConfig} /* Debug */,`,
      `\t\t\t\t${ID.releaseConfig} /* Release */,`,
      "\t\t\t);",
      "\t\t\tdefaultConfigurationIsVisible = 0;",
      "\t\t\tdefaultConfigurationName = Release;",
      "\t\t};",
      "",
    ].join("\n"));

    proj = pbxAddToList(proj, embedPhase.uuid, "files", `${ID.embedBuildFile} /* ${SHARE_NAME}.appex in Embed App Extensions */,`);
    proj = pbxAddToList(proj, appTarget.uuid, "dependencies", `${ID.dependency} /* PBXTargetDependency */,`);

    writeFileSync(PBXPROJ, proj);
    console.log(`patch-ios: added the ${SHARE_NAME} share-extension target (${APP_ID}.${SHARE_NAME}) to project.pbxproj.`);
  }
}

/* ---------- 5. Entitlements: Associated Domains + iCloud + App Group ---------- */
// A labelled block, not process.exit(): the sections after this one (iOS
// deployment target, device family) must run on every pass — including the
// skip-both first build and any re-run where this is already applied.
//
// The file is rebuilt from scratch on every pass rather than edited, so
// flipping a skip switch between runs can't leave a stale entitlement
// behind. Each capability must be enabled on the App ID, or signing fails.
entitlements: {
  const parts = [];
  if (SKIP_DOMAINS) {
    console.log("patch-ios: DUITFUL_IOS_SKIP_ASSOCIATED_DOMAINS=1, no Associated Domains entitlement.");
  } else {
    const applinks = HOSTS.map((h) => `\t\t<string>applinks:${h}</string>`).join("\n");
    parts.push(`\t<key>com.apple.developer.associated-domains</key>\n\t<array>\n${applinks}\n\t</array>`);
  }
  if (SKIP_ICLOUD) {
    console.log("patch-ios: DUITFUL_IOS_SKIP_ICLOUD=1, no iCloud entitlement (Drive-only backup).");
  } else {
    // CloudKit, not iCloud Documents: an iCloud Drive file needs iCloud
    // Drive switched on, and on a real iPhone with it off the container never
    // opened. CloudKit's private database only needs an iCloud sign-in.
    // (Key-value storage was never an option: it caps out at 1 MB.)
    const container = `\t<array>\n\t\t<string>${ICLOUD_CONTAINER}</string>\n\t</array>`;
    parts.push(
      `\t<key>com.apple.developer.icloud-container-identifiers</key>\n${container}`,
      `\t<key>com.apple.developer.icloud-services</key>\n\t<array>\n\t\t<string>CloudKit</string>\n\t</array>`,
    );
  }
  parts.push(`\t<key>com.apple.security.application-groups</key>\n\t<array>\n\t\t<string>${APP_GROUP}</string>\n\t</array>`);
  if (parts.length === 0) {
    console.log("patch-ios: no entitlements requested, leaving App.entitlements alone.");
    break entitlements;
  }

  const ENTITLEMENTS_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${parts.join("\n")}
</dict>
</plist>
`;

  const current = existsSync(ENTITLEMENTS) ? readFileSync(ENTITLEMENTS, "utf8") : "";
  if (current !== ENTITLEMENTS_BODY) {
    writeFileSync(ENTITLEMENTS, ENTITLEMENTS_BODY);
    console.log(`patch-ios: wrote App.entitlements (${[
      !SKIP_DOMAINS && HOSTS.map((h) => `applinks:${h}`).join(", "),
      !SKIP_ICLOUD && `iCloud ${ICLOUD_CONTAINER}`,
      `App Group ${APP_GROUP}`,
    ].filter(Boolean).join("; ")}).`);
  } else {
    console.log("patch-ios: App.entitlements already up to date, skipping.");
  }

  /* ---------- 6. Wire the entitlement into the Xcode project ---------- */
  // xcodebuild only signs with an entitlements file if CODE_SIGN_ENTITLEMENTS
  // points at it, so the .entitlements above is inert until the build setting
  // exists in both of the App target's configurations.
  //
  // Anchoring on `INFOPLIST_FILE = App/Info.plist;` rather than on the bundle
  // id or a hard-coded object UUID: that line appears exactly twice in
  // Capacitor's template (App target Debug + Release) and never in the Pods
  // project, so the edit can't leak into a dependency's build settings.
  //
  // The file is deliberately NOT added to a PBXGroup. CODE_SIGN_ENTITLEMENTS
  // is a plain SRCROOT-relative path — xcodebuild does not care whether the
  // file appears in the project navigator, and inventing PBXFileReference
  // UUIDs by hand is the fragile part of pbxproj surgery, not this.
  if (!existsSync(PBXPROJ)) {
    console.error("patch-ios: project.pbxproj not found at", PBXPROJ);
    process.exit(1);
  }

  let pbx = readFileSync(PBXPROJ, "utf8");

  if (pbx.includes("CODE_SIGN_ENTITLEMENTS = App/App.entitlements;")) {
    console.log("patch-ios: CODE_SIGN_ENTITLEMENTS already set, skipping.");
    break entitlements;
  }

  const ANCHOR = /^(\s*)INFOPLIST_FILE = App\/Info\.plist;$/gm;
  const matches = [...pbx.matchAll(ANCHOR)];
  if (matches.length === 0) {
    console.error("patch-ios: no `INFOPLIST_FILE = App/Info.plist;` build setting found in", PBXPROJ);
    process.exit(1);
  }

  // Keys inside buildSettings are alphabetical in Xcode's own output;
  // CODE_SIGN_ENTITLEMENTS sorts before INFOPLIST_FILE, so inserting just
  // above the anchor keeps the file looking like Xcode wrote it.
  pbx = pbx.replace(ANCHOR, (line, indent) => `${indent}CODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n${line}`);
  writeFileSync(PBXPROJ, pbx);
  console.log(`patch-ios: set CODE_SIGN_ENTITLEMENTS on ${matches.length} build configuration(s).`);
}

/* ---------- helpers ---------- */
// iPad keys (section 2b). Returns { plist, changes[] }; no change when the
// keys already say what we want, so a second run logs "skipping".
function ensureIpadPlist(src) {
  const changes = [];
  // UIRequiresFullScreen: <true/>, flipping a <false/> the template or a
  // plugin may have written.
  const fs = /(<key>UIRequiresFullScreen<\/key>\s*)<(true|false)\s*\/>/;
  const m = src.match(fs);
  if (!m) {
    src = insertPlistEntry(src, "\t<key>UIRequiresFullScreen</key>\n\t<true/>\n");
    changes.push("added UIRequiresFullScreen (no Split View / Slide Over)");
  } else if (m[2] === "false") {
    src = src.replace(fs, "$1<true/>");
    changes.push("UIRequiresFullScreen set to true");
  }
  // UISupportedInterfaceOrientations~ipad: all four, in Apple's order.
  const block = "\t<key>UISupportedInterfaceOrientations~ipad</key>\n\t<array>\n" +
    IPAD_ORIENTATIONS.map((o) => `\t\t<string>${o}</string>\n`).join("") + "\t</array>\n";
  const ipad = /\t?<key>UISupportedInterfaceOrientations~ipad<\/key>\s*<array>([\s\S]*?)<\/array>\n?/;
  const im = src.match(ipad);
  if (!im) {
    src = insertPlistEntry(src, block);
    changes.push("added UISupportedInterfaceOrientations~ipad (all four)");
  } else if (!IPAD_ORIENTATIONS.every((o) => im[1].includes(`<string>${o}</string>`))) {
    src = src.replace(ipad, block);
    changes.push("UISupportedInterfaceOrientations~ipad set to all four");
  }
  return { plist: src, changes };
}

// Inserts a <key>/<value> pair just before the plist's closing </dict>.
// Text-level on purpose: no plist parser in the dependency tree, and the
// generated file is always Xcode-formatted with tab indentation.
function insertPlistEntry(src, entry) {
  const closeIdx = src.lastIndexOf("</dict>");
  if (closeIdx === -1) {
    console.error("patch-ios: malformed Info.plist (no closing </dict>) at", INFO_PLIST);
    process.exit(1);
  }
  return src.slice(0, closeIdx) + entry + src.slice(closeIdx);
}

// Adds one custom URL scheme to CFBundleURLTypes and returns the new plist.
//
// Capacitor's template ships no CFBundleURLTypes at all, so the first
// caller writes the whole array. Every caller after that — the second
// scheme here, or a future plugin's — appends its dict to the existing
// array instead of replacing it. Getting that wrong is how you'd silently
// unregister Google sign-in, so the append is the only path taken once the
// key exists.
function schemeAlreadyRegistered(src, scheme) {
  const keyIdx = src.indexOf("<key>CFBundleURLTypes</key>");
  return keyIdx !== -1 && src.indexOf(`<string>${scheme}</string>`, keyIdx) !== -1;
}

function registerUrlScheme(src, scheme) {
  const entry =
    "\t\t<dict>\n" +
    "\t\t\t<key>CFBundleURLSchemes</key>\n" +
    "\t\t\t<array>\n" +
    `\t\t\t\t<string>${scheme}</string>\n` +
    "\t\t\t</array>\n" +
    "\t\t</dict>\n";
  if (!src.includes("<key>CFBundleURLTypes</key>")) {
    return insertPlistEntry(src, "\t<key>CFBundleURLTypes</key>\n\t<array>\n" + entry + "\t</array>\n");
  }
  const arrayStart = src.indexOf("<array>", src.indexOf("<key>CFBundleURLTypes</key>"));
  const insertAt = arrayStart === -1 ? -1 : arrayStart + "<array>".length;
  if (insertAt === -1) {
    console.error("patch-ios: CFBundleURLTypes is present but malformed in", INFO_PLIST);
    process.exit(1);
  }
  return src.slice(0, insertAt) + "\n" + entry.replace(/\n$/, "") + src.slice(insertAt);
}

/* ---------- pbxproj helpers (section 4) ---------- */
// project.pbxproj is an OpenStep property list, and there is no parser for
// one in this dependency tree. These helpers therefore work on the text —
// but only ever by APPENDING whole objects to a named section or one entry
// to a named list, never by rewriting anything Capacitor or CocoaPods
// generated. Every one of them exits 1 rather than guessing: a malformed
// pbxproj breaks every iOS build, including the ones that work today.

// A pbxproj object id is 24 uppercase hex characters, unique only within
// this file. Deriving it from a SHA-1 over a fixed seed makes every run
// produce the same ids, so re-running the patch is a no-op instead of
// churning the project. Callers check the result doesn't already occur.
function pbxUuid(seed) {
  return createHash("sha1").update(`duitful-ios-widget:${seed}`).digest("hex").slice(0, 24).toUpperCase();
}

function pbxMatch(src, re, what) {
  const m = src.match(re);
  if (!m) {
    console.error(`patch-ios: could not find ${what} in`, PBXPROJ);
    process.exit(1);
  }
  return m[1];
}

// Splits a section into its objects. Only safe for the multi-line sections
// (targets, groups, phases) — PBXBuildFile/PBXFileReference entries are
// one-liners and are never read back this way.
function pbxObjects(src, section) {
  const begin = src.indexOf(`/* Begin ${section} section */`);
  const end = src.indexOf(`/* End ${section} section */`);
  if (begin === -1 || end === -1 || end < begin) return [];
  const body = src.slice(begin, end);
  const re = /\n\t\t([0-9A-F]{24})(?: \/\* (.*?) \*\/)? = \{\n([\s\S]*?)\n\t\t\};/g;
  const out = [];
  let m;
  while ((m = re.exec(body)) !== null) out.push({ uuid: m[1], name: m[2] || "", body: m[3] });
  return out;
}

// Appends object text just before `/* End <section> section */`.
function pbxAppend(src, section, body) {
  const marker = `/* End ${section} section */`;
  const idx = src.indexOf(marker);
  if (idx === -1) {
    console.error(`patch-ios: no ${section} section in`, PBXPROJ);
    process.exit(1);
  }
  return src.slice(0, idx) + body + src.slice(idx);
}

// Creates a section that Capacitor's template doesn't have at all (it
// ships no copy-files phase, no target dependency and no container
// proxy), placing it where Xcode would — immediately before `beforeSection`.
function pbxInsertSection(src, section, body, beforeSection) {
  if (src.includes(`/* Begin ${section} section */`)) return pbxAppend(src, section, body);
  const marker = `/* Begin ${beforeSection} section */`;
  const idx = src.indexOf(marker);
  if (idx === -1) {
    console.error(`patch-ios: no ${beforeSection} section in`, PBXPROJ);
    process.exit(1);
  }
  return src.slice(0, idx) + `/* Begin ${section} section */\n${body}/* End ${section} section */\n\n` + src.slice(idx);
}

// Appends one entry to the END of a `name = ( ... );` list inside the
// object with the given id — order matters for buildPhases, where the
// embed step has to run last.
function pbxAddToList(src, uuid, listName, entry) {
  const start = src.indexOf(`\n\t\t${uuid} `);
  const end = start === -1 ? -1 : src.indexOf("\n\t\t};", start);
  if (start === -1 || end === -1) {
    console.error(`patch-ios: object ${uuid} not found (or unterminated) in`, PBXPROJ);
    process.exit(1);
  }
  const body = src.slice(start + 1, end);
  const open = body.indexOf(`${listName} = (\n`);
  const close = open === -1 ? -1 : body.indexOf("\n\t\t\t);", open);
  if (open === -1 || close === -1) {
    console.error(`patch-ios: object ${uuid} has no ${listName} list in`, PBXPROJ);
    process.exit(1);
  }
  const at = start + 1 + close + 1;
  return src.slice(0, at) + `\t\t\t\t${entry}\n` + src.slice(at);
}

// The per-target metadata Xcode keeps on the PBXProject. Automatic
// provisioning matches what Capacitor sets for the App target; the
// TestFlight lane pins the App target to manual signing afterwards and
// leaves this one alone.
function pbxAddTargetAttributes(src, projectObject, targetId) {
  const start = src.indexOf(`\n\t\t${projectObject} `);
  const marker = "TargetAttributes = {\n";
  const at = start === -1 ? -1 : src.indexOf(marker, start);
  if (at === -1) {
    console.error("patch-ios: no TargetAttributes on the PBXProject object in", PBXPROJ);
    process.exit(1);
  }
  const entry =
    `\t\t\t\t\t${targetId} = {\n` +
    "\t\t\t\t\t\tCreatedOnToolsVersion = 15.0;\n" +
    "\t\t\t\t\t\tProvisioningStyle = Automatic;\n" +
    "\t\t\t\t\t};\n";
  const insertAt = at + marker.length;
  return src.slice(0, insertAt) + entry + src.slice(insertAt);
}

/* ---------- iOS deployment target: 14.0 → 15.5 ----------
   GoogleMLKit/TextRecognition originally forced iOS 15.5+. Since 1.64.0
   iOS uses Apple Vision and drops ML Kit completely, but the app and
   DuitfulCapacitorKit.podspec keep 15.5 as the floor, while Capacitor's
   template still starts at 14.0 — so `pod install` fails during `cap add ios`
   before this script runs. The workflow tolerates that first pod failure;
   this patch raises the target in BOTH the Podfile (the resolver's input) and
   the pbxproj (the compiler's), and the subsequent `cap sync ios` re-runs
   pod install successfully. iOS 15.5 covers effectively every device in
   use (every iPhone since the 6s can run it). */
{
  const PODFILE = resolve(ROOT, "ios/App/Podfile");
  const PBXPROJ_DT = resolve(ROOT, "ios/App/App.xcodeproj/project.pbxproj");
  const TARGET = "15.5";
  if (existsSync(PODFILE)) {
    let pod = readFileSync(PODFILE, "utf8");
    const patched = pod.replace(/platform :ios, '(\d+\.\d+)'/, (m, v) =>
      parseFloat(v) < parseFloat(TARGET) ? `platform :ios, '${TARGET}'` : m);
    if (patched !== pod) {
      writeFileSync(PODFILE, patched);
      console.log(`patch-ios: Podfile platform raised to iOS ${TARGET}.`);
    } else {
      console.log("patch-ios: Podfile platform already sufficient, skipping.");
    }
  }
  if (existsSync(PBXPROJ_DT)) {
    let proj = readFileSync(PBXPROJ_DT, "utf8");
    const patched = proj.replace(/IPHONEOS_DEPLOYMENT_TARGET = (\d+\.\d+);/g, (m, v) =>
      parseFloat(v) < parseFloat(TARGET) ? `IPHONEOS_DEPLOYMENT_TARGET = ${TARGET};` : m);
    if (patched !== proj) {
      writeFileSync(PBXPROJ_DT, patched);
      console.log(`patch-ios: pbxproj deployment target raised to iOS ${TARGET}.`);
    } else {
      console.log("patch-ios: pbxproj deployment target already sufficient, skipping.");
    }
  }
}

/* ---------- iPhone and iPad (since 1.63) ----------
   Capacitor's template targets iPhone AND iPad ("1,2"). v1.0 to 1.62 shipped
   iPhone-only (family 1) because nobody had designed or screenshotted an
   iPad layout, and App Review tests whatever the family claims. 1.63 ships
   on iPad: full screen only (UIRequiresFullScreen, section 2b), every
   orientation, the web layout's rail / sidebar at tablet sizes, and 13" iPad
   screenshots (2064 x 2752, marketing/app-store/ipad/). The replace below is
   global on purpose, so the widget extension (section 4) gets the same
   family as its host app. Set IOS_DEVICE_FAMILY back to "1" to go
   iPhone-only again (and remove the iPad screenshots in App Store Connect). */
{
  const PBXPROJ_FAM = resolve(ROOT, "ios/App/App.xcodeproj/project.pbxproj");
  const IOS_DEVICE_FAMILY = "1,2";
  if (existsSync(PBXPROJ_FAM)) {
    const proj = readFileSync(PBXPROJ_FAM, "utf8");
    const value = IOS_DEVICE_FAMILY.includes(",") ? `"${IOS_DEVICE_FAMILY}"` : IOS_DEVICE_FAMILY;
    const patched = proj.replace(/TARGETED_DEVICE_FAMILY = (?:"[\d,]+"|\d+);/g, `TARGETED_DEVICE_FAMILY = ${value};`);
    if (patched !== proj) {
      writeFileSync(PBXPROJ_FAM, patched);
      console.log(`patch-ios: device family set to ${IOS_DEVICE_FAMILY === "1" ? "iPhone only" : IOS_DEVICE_FAMILY === "1,2" ? "iPhone and iPad (1,2)" : IOS_DEVICE_FAMILY}.`);
    } else {
      console.log("patch-ios: device family already set, skipping.");
    }
  }
}
