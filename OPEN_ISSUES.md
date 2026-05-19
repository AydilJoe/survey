# Open issues

Tracking known limitations and follow-up work. Items here are not blockers
for the current release but should be addressed in subsequent PRs.

## Notification auto-capture
- [ ] Multi-language notification parsing for SEA markets (currently English-pattern only).
- [ ] Currency rendering in pending-txn UI when captured currency differs from user's display currency.
- [ ] Real-device verification of SEA bank packages (best-effort list, may need correction post-launch).
- [ ] Tighten Rabbit LINE Pay capture: currently piggybacks on the LINE package (`jp.naver.line.android`), so all LINE notifications reach the listener and are filtered only at the JS pattern stage. Future work: scope to wallet-specific notification titles or move LINE Pay to a separate package once it's split out.

## Drive sync
- [ ] iOS Drive sync — when iOS launches, add the same `@codetrix-studio/capacitor-google-auth` integration. The plugin already supports iOS; the work is iOS OAuth client setup, Capacitor iOS plugin install, and TestFlight verification. Same encrypted backup file as web/Android.

## Licensing
- [ ] Licence token revocation mechanism (currently no way to invalidate a leaked licence).

## Native build toolchain
- [ ] Upgrade Capacitor 6 → 7. Capacitor 6 vendors an `android/build.gradle` that references `proguard-android.txt`, which AGP 8.7+ / Gradle 9 removed. `scripts/patch-capacitor-android.mjs` patches the vendored file on every `npm install` as a stop-gap; the proper fix is the Capacitor 7 upgrade (also picks up better Android 14/15 support, Gradle 8.11.1 baseline, JDK 21 requirement, compileSdk 35). Once on Capacitor 7 the postinstall patch becomes a no-op and can be deleted.
