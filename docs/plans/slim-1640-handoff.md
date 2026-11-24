# 1.64.0 "a smaller app": handoff (WIP on branch `slim-1640`)

Plan: `docs/plans/backlog.md` → "iPhone size cut". Nothing here is tested yet:
no e2e run, no iOS build.

## Done

**iOS: Vision instead of ML Kit + Tesseract**
- `native/duitful-kit/ios/Sources/DuitfulKitPlugin/DuitfulTextReader.swift` (new):
  - `DuitfulTextReader.recognize`: `VNRecognizeTextRequest`, `.accurate`, language correction off by default (it would turn TEH into THE), languages en-US / ms-MY / zh-Hans filtered by `supportedRecognitionLanguages()`.
  - It returns ML Kit's exact shape: `{text, blocks[{text, boundingBox{left,top,right,bottom}, cornerPoints, recognizedLanguage, lines[{…, elements[]}]}]}`. Boxes are in image pixels with a top-left origin, converted from Vision's normalised bottom-left boxes. There is one block per observation. Word boxes come from `boundingBox(for:)`, falling back to a proportional slice of the line when that call fails.
  - `DuitfulDateReader`: NSDataDetector dates (`hasDay` heuristic) that replace ML Kit Entity Extraction.
- `DuitfulKitPlugin.swift`:
  - `import MLKitEntityExtraction` and the extractor are removed.
  - New `recognizeText({base64Image, rotation?, languageCorrection?})`.
  - `extractEntities` now returns `{money: [], dates}` from NSDataDetector. On iOS it is only used for the receipt date.
- `DuitfulCapacitorKit.podspec`: the `GoogleMLKit/EntityExtraction` dependency is removed, `Vision` framework added, `static_framework` kept (for the privacy manifest and linking). The floor stays at 15.5.
- `capacitor.config.json`: the ML Kit text plugin is removed from `ios.includePlugins` and stays in Android's list.
- Tesseract is left out of the iOS bundle:
  - New `scripts/trim-native-web.mjs`, run through the `"capacitor:copy:after"` hook in `package.json`, deletes `ios/App/App/public/vendor/tesseract` after every cap copy/sync/add on iOS.
  - Not yet verified on a Mac or in CI.

**JS (`app/script.js`, `app/statement.js`)**
- `tesseractAllowed()` is false on iOS. `loadTesseract` / `detectLocalTesseract` then never fetch.
- `nativeTextReader()` returns `{engine, detectText}`: Vision via `duitfulKit("recognizeText")` on iOS (45 s timeout), else the ML Kit plugin.
- `ocrEnv()` and `pickOcrEngine()` now return `"vision" | "mlkit" | "tesseract" | "none"`. Existing tests still match.
- `runMlKitOcr` uses `nativeTextReader`. Its name is kept, but it means "native OCR".
- Call sites updated:
  - `runReceiptOcr`: an empty read on iOS gives `text = ""`.
  - `ocrAlertScreenshot`.
  - `stmtOcrImage` in statement.js, which also covers statement scans and the EA form (tax.js uses the statement readers).
- `mlkitTextPlugin()` still returns the ML Kit plugin only (e2e uses it).

**Tesseract trim (web + Android)**
- `scripts/fetch-tesseract.mjs` ships only `tesseract-core-simd-lstm.wasm.js` and `tesseract-core-lstm.wasm.js`. The `.wasm.js` embeds its wasm as base64, so the bare `.wasm` files were never loaded.
- `pruneUnlisted()` deletes any other file from `vendor/tesseract`.
- The app sets `corePath` to the exact file (`tesseractCoreFile()`, the same SIMD probe tesseract.js uses). The worker then never asks for relaxedsimd.
- vendor/tesseract shrinks from **22 MB to 9.6 MB** (measured).
- The scan string changed from "about 10 MB" to "about 6 MB" (`scripts/i18n/scan.mjs`), and `npm run build:i18n` has been run.

**Version**: `package.json` is 1.64.0. Nothing else is bumped yet.

## Left to do
1. **Version / release**:
   - `APP_VERSION` and `RELEASE_NOTES` (EN) in `app/script.js`. Use per-platform note filtering (#415).
   - Malay line in `scripts/release-notes-ms.json`.
   - changelog.
   - Bump `sw.js` `VERSION` and the `?v=` numbers for `script.js` / `statement.js` / i18n in `app/index.html` and `app/sw.js`, above main's.
2. **e2e (`tests/e2e.mjs`)**:
   - Section 17 near line 9277: "both platforms still get … OCR" must now say ML Kit is Android-only, not on iOS.
   - Add iOS stubs (`getPlatform: () => 'ios'`, `DuitfulKit.recognizeText` returning the `mlkitResult` fixture near line 6005) for the receipt (`runReceiptOcr`), the statement (`readStatementPhotos`), the EA form (`taxOpenEa` path) and `ocrAlertScreenshot`. Assert they give the same parsed results as the ML Kit path.
   - Assert that no `vendor/tesseract` request happens on iOS: use `page.on('request')`, or stub `getTesseractWorker` to fail on a call.
   - Android with ML Kit missing still falls back to Tesseract.
   - Web real OCR (around line 6107) still passes, and no request goes to `*.wasm` or `relaxedsimd`.
   - Add `recognizeText` to `marketing/app-store/scripts/capture-ipad.mjs` stubs (it stubs ML Kit today).
   - Then run `npm run test:e2e`. A known local-only failure: Malay "Tabung" at 360px on Home.
3. **Docs**:
   - CLAUDE.md DuitfulKit/OCR paragraph: iOS = Vision, Android = ML Kit + Tesseract, web = Tesseract; the plugin exclusion; the copy hook.
   - IOS_BUILD.md, around lines 245 / 399 / 454 / 660 / 705 / 805.
   - ANDROID_BUILD.md line 179 ("iOS falls back to Tesseract" is now wrong).
   - Comments in `scripts/patch-ios.mjs`: line 56 and the 15.5 block near line 1805 still blame GoogleMLKit.
   - `.github/workflows/ios.yml`: the "Build web assets" comment.
   - The backlog entry: mark it built.
   - `llms.txt` / landing only if they claim ML Kit on iPhone (grep).
4. **CI size check**:
   - Add `du -sh` of `App.app`, `Frameworks` and `public` to the "Show what the IPA contains" step in `ios.yml`. Possibly also a bundle size echo in the `ci.yml` android job.
   - Dispatch `ios.yml` with `lane=build-only`, `ref=slim-1640`. Never testflight or signed lanes from a branch.

## How to test
- `npm run test:e2e` (Playwright, needs `vendor/tesseract`: `node scripts/fetch-tesseract.mjs`).
- `CAPACITOR_PLATFORM_NAME=ios node scripts/trim-native-web.mjs` after `npx cap sync ios` on a Mac. Then `ios/App/App/public/vendor/tesseract` must be gone.
- `ios.yml` build-only proves the Swift compiles. On a real iPhone via TestFlight, check:
  - receipts: Scan and photo, Malay and Chinese text, a long receipt;
  - statement scan from photos and from a scanned PDF;
  - EA form scan;
  - the receipt date filled when the parser misses it (NSDataDetector).

## Known risks
- The Swift has never been compiled. Watch the `VNRecognizedText.boundingBox(for:)` optional/throws use, `supportedRecognitionLanguages()` (iOS 15+), and the `Result` type with a custom `Failure` struct (it must conform to `Error`, which it does).
- Vision word boxes on `.accurate` may come back per line on some iOS versions. A proportional fallback is in place, but row reconstruction should be checked on a real device.
- Removing `GoogleMLKit` may change pod resolution for `@capgo/capacitor-social-login` (GoogleSignIn), which was added only to avoid the ML Kit clash. Watch `pod install`.
- The `capacitor:copy:after` hook also runs for Android (a no-op) and only applies when Capacitor runs the copy. Copying `www` by hand would ship Tesseract on iOS, but the JS still never loads it.
- Old Android WebViews without WebAssembly SIMD get the scalar core. That is fine, only slower.
