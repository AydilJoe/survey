# `/.well-known/` — Android App Links + iOS Universal Links

Two files, one job: make `https://duitful.app/split#…` open the **native
app** instead of a browser tab. `assetlinks.json` does it on Android,
`apple-app-site-association` on iOS. Each carries a placeholder that must be
replaced before the OS will verify the domain; until then links open in the
browser, which is the designed fallback.

**Run `npm run check:applinks` after any DNS or hosting change.** It fetches
both files from every claimed host exactly the way the OS does, and fails
loudly on the traps below. A weekly GitHub Action
(`.github/workflows/applinks.yml`) runs the same check.

## Redirects break verification — the trap that actually bit us

Neither Android's verifier nor Apple's CDN follows redirects when fetching an
association file. A `301`/`307` is treated as *"no file"*, so the host fails
verification even though the same URL renders fine in a browser (browsers
*do* follow redirects, which is what makes this so easy to miss).

In August 2026 `duitful.app` was configured on Vercel to redirect to
`www.duitful.app`. Result: `www` verified, the bare domain failed, and Play
Console reported *"One deep link may be failing because your web domains
aren't associated with your app"*. Because `SPLIT_LINK_BASE` in
`app/split.js` points at the **bare** domain, every link users actually
shared was the one that didn't work.

### The correct config (restored 2026-08-03)

On Vercel → **Settings → Domains**, *both* domains are set to
**Connect to an environment → Production**. Neither redirects:

| Domain | Setting |
|---|---|
| `duitful.app` | Connect to an environment → Production |
| `www.duitful.app` | Connect to an environment → Production |

**Do not "tidy this up" by pointing `www` at the bare domain with a 308.**
That is the obvious-looking move and it does not work: whichever host
redirects is the host that fails verification, so a `www` → bare redirect
simply moves the Play Console warning from one row to the other. Both hosts
are claimed in `AndroidManifest.xml` and `App.entitlements`, so both must
serve the files directly.

Serving the same content on two hosts costs nothing here: all 80 HTML pages
carry `rel="canonical"` pointing at the bare domain and none point at `www`,
so search engines consolidate on `duitful.app` regardless of which host they
crawl.

Check with `npm run check:applinks`, or by hand — note `--max-redirs 0`,
since a plain `curl -L` would follow the redirect and hide the bug:

```bash
curl -sS --max-redirs 0 -o /dev/null -w "%{http_code}\n" \
  https://duitful.app/.well-known/assetlinks.json   # must be 200, not 3xx
```

## Android — `assetlinks.json`

`assetlinks.json` is what lets a `https://duitful.app/split#…` link tapped in
WhatsApp open the **native Duitful app** instead of a browser tab. Android
fetches this file over HTTPS and checks that the app claiming the domain is
signed with the certificate listed here. Until the fingerprint below is real,
verification fails and links keep opening in the browser — which is the
designed fallback, not a breakage.

### Fingerprint — done

`sha256_cert_fingerprints` now carries the real **Play App Signing**
certificate fingerprint (not the upload key — Play re-signs every release).
If it ever needs re-checking or the app is re-keyed, it comes from Play
Console → your app → **Test and release → Setup → App signing** → *App
signing key certificate* → **SHA-256 certificate fingerprint**
(colon-separated uppercase hex).

If you also sideload debug builds and want links to open in those, add the
debug keystore fingerprint as a **second** string in the same array:

```bash
keytool -list -v -keystore ~/.android/debug.keystore \
  -alias androiddebugkey -storepass android -keypass android
```

## Verifying

```bash
npm run check:applinks                                       # both hosts, both files, no-redirect
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
## iOS — `apple-app-site-association`

Same idea, Apple's format. **No file extension** — that is the spec, not an
oversight, so don't "fix" it to `.json`.

### TODO before the first TestFlight build

`appIDs` currently holds `TEAMID.com.aydiljoe.duitful`. Replace `TEAMID`
with your 10-character Apple Developer **Team ID**:

1. <https://developer.apple.com/account> → **Membership details**
2. Copy **Team ID** (e.g. `A1B2C3D4E5`)
3. Paste it in place of `TEAMID` (keep the dot and the bundle id), commit,
   push — Pages redeploys and iOS re-checks on the next install

### Verifying

```bash
npm run check:applinks   # 200 with no redirect, valid JSON, /split claimed
curl -s https://duitful.app/.well-known/apple-app-site-association   # real Team ID, not TEAMID
```

`check:applinks` reports the unresolved `TEAMID` as a *note* rather than a
failure, since it is harmless until an iOS build ships — but Universal Links
will not verify until it is replaced.

Apple's own diagnostics live in **Settings → Developer → Universal Links →
Diagnostics** on a device with a build installed.

Serving notes: Apple wants `Content-Type: application/json`. Vercel is told
so explicitly in `vercel.json`; GitHub Pages guesses from the (absent)
extension and may serve `application/octet-stream`, which Apple's CDN
tolerates in practice but is worth checking with the `curl -sI` above if
verification never turns green. The matching entitlement
(`applinks:duitful.app`, `applinks:www.duitful.app`) is written into the
generated Xcode project by `scripts/patch-ios.mjs`. Full walkthrough in
[`IOS_BUILD.md`](../IOS_BUILD.md).
