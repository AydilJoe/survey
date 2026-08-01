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
// Widgets are a much younger API than the app itself: the app floor is
// dragged down to 15.5 by GoogleMLKit (see the last block in this file),
// but nothing forces the extension that low, and 16.0 keeps the SwiftUI
// used below on well-trodden ground. An extension may require a newer iOS
// than its host app — iOS simply doesn't offer the widget on older
// devices, which is the correct behaviour here.
const WIDGET_DEPLOYMENT_TARGET = "16.0";

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
  writeFileSync(APP_DELEGATE, swift);
  console.log("patch-ios: injected quick-action routing into AppDelegate.swift.");
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
//  ACTIONS ONLY, ON PURPOSE. This extension runs in its own process and
//  cannot decrypt Duitful's vault: the AES-GCM key is derived from the
//  user's passcode and never leaves the app's memory. So the widget shows
//  no amount, no balance, no count, no date and no name. It has no App
//  Group, no shared UserDefaults suite, no shared container and no data
//  source of any kind — a single static entry with a .never reload policy.

import SwiftUI
import WidgetKit

// MARK: - Palette
//
// The app's tokens: cream #e8dfd0 on ink #2a2420 in light, #14110e on
// #f3ede1 in dark, terracotta #d76636 as the accent.

private enum DuitfulPalette {
    static let terracotta = Color(red: 0.843, green: 0.400, blue: 0.212)

    static func canvas(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 0.078, green: 0.067, blue: 0.055)
            : Color(red: 0.910, green: 0.875, blue: 0.816)
    }

    static func ink(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 0.953, green: 0.929, blue: 0.882)
            : Color(red: 0.165, green: 0.141, blue: 0.125)
    }

    static func tile(_ scheme: ColorScheme) -> Color {
        ink(scheme).opacity(scheme == .dark ? 0.16 : 0.08)
    }
}

// MARK: - Action contract
//
// Identical to the Home Screen quick actions, in the same order. Each one
// opens ${APP_SCHEME}://action/<name>, which the web layer already parses.

struct DuitfulAction: Identifiable {
    let id: String
    let title: String
    let symbol: String

    var url: URL {
        // Concatenated rather than interpolated, and with a non-failing
        // fallback, so the widget carries no force-unwraps at all.
        URL(string: "${APP_SCHEME}://action/" + id) ?? URL(fileURLWithPath: "/")
    }

    static let all: [DuitfulAction] = [
        DuitfulAction(id: "spend", title: "Spend", symbol: "plus.circle.fill"),
        DuitfulAction(id: "scan", title: "Scan", symbol: "camera.fill"),
        DuitfulAction(id: "split", title: "Split", symbol: "person.2.fill"),
        DuitfulAction(id: "debt", title: "Pay debt", symbol: "creditcard.fill"),
    ]

    // systemSmall has exactly one tap target, so it gets the primary action.
    static var primary: DuitfulAction { all[0] }
}

// MARK: - Timeline
//
// One entry, never refreshed. There is nothing to refresh: the widget has
// no data source.

struct DuitfulEntry: TimelineEntry {
    let date: Date
}

struct DuitfulProvider: TimelineProvider {
    func placeholder(in context: Context) -> DuitfulEntry {
        DuitfulEntry(date: Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (DuitfulEntry) -> Void) {
        completion(DuitfulEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DuitfulEntry>) -> Void) {
        completion(Timeline(entries: [DuitfulEntry(date: Date())], policy: .never))
    }
}

// MARK: - Pieces

private struct DuitfulMark: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 6) {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(DuitfulPalette.terracotta)
                .frame(width: 18, height: 18)
                .overlay(
                    Text("D")
                        .font(.system(size: 12, weight: .heavy, design: .rounded))
                        .foregroundColor(.white)
                )
            Text("Duitful")
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .foregroundColor(DuitfulPalette.ink(scheme))
        }
    }
}

private struct DuitfulTile: View {
    let action: DuitfulAction

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: action.symbol)
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(DuitfulPalette.terracotta)
            Text(action.title)
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .foregroundColor(DuitfulPalette.ink(scheme))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(DuitfulPalette.tile(scheme))
        )
    }
}

// MARK: - Families

private struct DuitfulSmallView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            DuitfulMark()
            Spacer(minLength: 0)
            DuitfulTile(action: DuitfulAction.primary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

// Four separate Link regions, one per action: medium and large are big
// enough for iOS to route the tap to whichever region was hit, so each
// opens its own URL.
private struct DuitfulGridView: View {
    let showsMark: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if showsMark {
                DuitfulMark()
            }
            VStack(spacing: 8) {
                row(DuitfulAction.all[0], DuitfulAction.all[1])
                row(DuitfulAction.all[2], DuitfulAction.all[3])
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func row(_ left: DuitfulAction, _ right: DuitfulAction) -> some View {
        HStack(spacing: 8) {
            Link(destination: left.url) {
                DuitfulTile(action: left)
            }
            Link(destination: right.url) {
                DuitfulTile(action: right)
            }
        }
    }
}

private extension View {
    // iOS 17 refuses to render a widget that hasn't declared a container
    // background, and the modifier doesn't exist before 17 — so it is
    // guarded, and older systems get the app's own canvas colour instead.
    @ViewBuilder
    func duitfulWidgetContainer(_ scheme: ColorScheme) -> some View {
        if #available(iOS 17.0, *) {
            self.containerBackground(.fill.tertiary, for: .widget)
        } else {
            self
                .padding(12)
                .background(DuitfulPalette.canvas(scheme))
        }
    }
}

struct DuitfulWidgetEntryView: View {
    var entry: DuitfulProvider.Entry

    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        content.duitfulWidgetContainer(scheme)
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .systemSmall:
            DuitfulSmallView().widgetURL(DuitfulAction.primary.url)
        case .systemLarge:
            DuitfulGridView(showsMark: true)
        default:
            DuitfulGridView(showsMark: false)
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
        .configurationDisplayName("Duitful actions")
        .description("Four shortcuts into Duitful. No figures are shown — a widget cannot read your encrypted vault.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

@main
struct DuitfulWidgetBundle: WidgetBundle {
    var body: some Widget {
        DuitfulActionsWidget()
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
      '\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";',
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

/* ---------- 5. Associated Domains entitlement ---------- */
if (SKIP_DOMAINS) {
  console.log("patch-ios: DUITFUL_IOS_SKIP_ASSOCIATED_DOMAINS=1, leaving entitlements alone.");
  process.exit(0);
}

const applinks = HOSTS.map((h) => `\t\t<string>applinks:${h}</string>`).join("\n");
const ENTITLEMENTS_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>com.apple.developer.associated-domains</key>
\t<array>
${applinks}
\t</array>
</dict>
</plist>
`;

const wantsRewrite =
  !existsSync(ENTITLEMENTS) ||
  HOSTS.some((h) => !readFileSync(ENTITLEMENTS, "utf8").includes(`applinks:${h}`));

if (wantsRewrite) {
  writeFileSync(ENTITLEMENTS, ENTITLEMENTS_BODY);
  console.log(`patch-ios: wrote App.entitlements (${HOSTS.map((h) => `applinks:${h}`).join(", ")}).`);
} else {
  console.log("patch-ios: App.entitlements already declares both applinks, skipping.");
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
  process.exit(0);
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

/* ---------- helpers ---------- */
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
   GoogleMLKit/TextRecognition 7.0.0 (pulled by the ML Kit plugin)
   requires iOS 15.5+, but Capacitor's template generates the project at
   14.0 — so `pod install` fails during `cap add ios` before this script
   even runs. The workflow tolerates that first pod failure; this patch
   then raises the target in BOTH the Podfile (the resolver's input) and
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
