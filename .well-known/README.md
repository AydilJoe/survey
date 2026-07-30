# `/.well-known/` — Android App Links

`assetlinks.json` is what lets a `https://duitful.app/split#…` link tapped in
WhatsApp open the **native Duitful app** instead of a browser tab. Android
fetches this file over HTTPS and checks that the app claiming the domain is
signed with the certificate listed here. Until the fingerprint below is real,
verification fails and links keep opening in the browser — which is the
designed fallback, not a breakage.

## TODO before the first Play release

`sha256_cert_fingerprints` currently holds the placeholder
`TODO_REPLACE_WITH_PLAY_APP_SIGNING_SHA256_FINGERPRINT`. Replace it with the
**Play App Signing** certificate fingerprint (not the upload key — Play
re-signs every release):

1. Play Console → your app → **Test and release → Setup → App signing**
2. Copy the **SHA-256 certificate fingerprint** under
   *App signing key certificate* (colon-separated uppercase hex)
3. Paste it into `assetlinks.json`, commit, push — GitHub Pages serves the
   file at <https://duitful.app/.well-known/assetlinks.json>

If you also sideload debug builds and want links to open in those, add the
debug keystore fingerprint as a **second** string in the same array:

```bash
keytool -list -v -keystore ~/.android/debug.keystore \
  -alias androiddebugkey -storepass android -keypass android
```

## Verifying

```bash
curl -s https://duitful.app/.well-known/assetlinks.json      # must be JSON, 200, application/json
adb shell pm get-app-links com.aydiljoe.duitful              # want: duitful.app -> verified
adb shell am start -a android.intent.action.VIEW \
  -d "https://duitful.app/split#DFS1.example"                # should open Duitful
```

Google's checker: <https://developers.google.com/digital-asset-links/tools/generator>

## Notes

- The matching intent filter is added to `AndroidManifest.xml` by
  `scripts/patch-android-applinks.mjs`, which `npm run cap:sync` runs. The
  `android/` project is git-ignored, so that patch re-applies on every fresh
  checkout.
- This file must stay strictly valid Digital Asset Links JSON — a top-level
  array of statements, no extra keys — which is why the explanation lives in
  this README rather than in a comment.
- Deployment: the GitHub Pages workflow uploads the whole repo (`path: .`),
  dotfiles included, so `.well-known/` ships as-is. Nothing in
  `scripts/build-web.mjs` or the Vercel build touches it.
- iOS Universal Links (`apple-app-site-association`) land with the future
  native iOS app; there is no iOS project in this repo yet.
