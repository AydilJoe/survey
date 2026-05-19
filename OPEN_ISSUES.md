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

## Native plugins
- [ ] `@codetrix-studio/capacitor-google-auth` is on Capacitor-7-incompatible peer-dep metadata (locked to `@capacitor/core ^6.0.0`) but works at runtime on Cap 7 because it only touches stable bridge APIs. We suppress the install-time peer warning with an `overrides` entry in `package.json`. Migrate to a maintained Cap-7-native sign-in plugin (e.g. `@capgo/capacitor-social-login`) when convenient.
