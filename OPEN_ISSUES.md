# Open issues

Tracking known limitations and follow-up work. Items here are not blockers
for the current release but should be addressed in subsequent PRs.

## Notification auto-capture
- [ ] Multi-language notification parsing for SEA markets (currently English-pattern only).
- [ ] Currency rendering in pending-txn UI when captured currency differs from user's display currency.
- [ ] Real-device verification of SEA bank packages (best-effort list, may need correction post-launch).
- [ ] Tighten Rabbit LINE Pay capture: currently piggybacks on the LINE package (`jp.naver.line.android`), so all LINE notifications reach the listener and are filtered only at the JS pattern stage. Future work: scope to wallet-specific notification titles or move LINE Pay to a separate package once it's split out.

## Licensing
- [ ] Licence token revocation mechanism (currently no way to invalidate a leaked licence).
