import Foundation
#if canImport(WidgetKit)
import WidgetKit
#endif

/// Isolated in its own file so `import WidgetKit` does not combine with
/// `import PhotosUI` inside `DuitfulKitPlugin.swift` — in Xcode 27+, importing
/// both `PhotosUI` and `WidgetKit` in the same compilation unit loads the
/// `_PhotosUI_WidgetKit` cross-import overlay instead of UIKit's `PhotosUI`
/// (`PHPickerViewController`).
enum DuitfulWidgetReload {
    static func reloadAll() {
        #if canImport(WidgetKit)
        if #available(iOS 14.0, *) {
            WidgetCenter.shared.reloadAllTimelines()
        }
        #endif
    }
}
