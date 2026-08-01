# Open issues

Tracking known limitations and follow-up work. Items here are not blockers
for the current release but should be addressed in subsequent PRs.

## Notification auto-capture
- [ ] Multi-language notification parsing for SEA markets (currently English-pattern only).
- [ ] Currency rendering in pending-txn UI when captured currency differs from user's display currency.
- [ ] Real-device verification of SEA bank packages (best-effort list, may need correction post-launch).
- [ ] Tighten Rabbit LINE Pay capture: currently piggybacks on the LINE package (`jp.naver.line.android`), so all LINE notifications reach the listener and are filtered only at the JS pattern stage. Future work: scope to wallet-specific notification titles or move LINE Pay to a separate package once it's split out.

## Drive sync
- [ ] iOS Drive sync — wired up via `@capgo/capacitor-social-login` (the codetrix plugin's GoogleSignIn 6.x pods can't coexist with ML Kit), with its own iOS OAuth client in `app/drive-config.js` and the reversed-client-ID URL scheme stamped into Info.plist by `scripts/patch-ios.mjs`. Same encrypted backup file as web/Android. Remaining: **verify on a real device / TestFlight** — the sign-in sheet, the returned scopes and the first upload have only been proven against stubs. See IOS_BUILD.md, "Google Drive sync on iOS".

## Licensing
- [ ] Licence token revocation mechanism (currently no way to invalidate a leaked licence).

## Native plugins
- [ ] `@codetrix-studio/capacitor-google-auth` is on Capacitor-7-incompatible peer-dep metadata (locked to `@capacitor/core ^6.0.0`) but works at runtime on Cap 7 because it only touches stable bridge APIs. We suppress the install-time peer warning with an `overrides` entry in `package.json`. Migrate Android to `@capgo/capacitor-social-login` too when convenient — iOS already uses it, so this would leave one sign-in plugin instead of two. Not urgent: Android's path is shipped and working, and the migration changes the Android sign-in UI (Credential Manager bottom sheet).
- [ ] `@capgo/capacitor-social-login` is iOS-only in intent but, because Android has no `includePlugins` list, it also registers in the Android build. Nothing calls it there (`drive-sync.js` routes Android to GoogleAuth), but its Gradle deps join the Android graph — notably `play-services-auth:21.4.0`, which outranks the `18.+` the codetrix plugin asks for, so Gradle resolves the whole app to 21.4.0. Watch the first Android build/sign-in after this change; if it misbehaves, add an `android.includePlugins` list to `capacitor.config.json` that omits this plugin.
