# Security policy

Duitful holds people's financial records. If you have found a way to read,
corrupt or exfiltrate them, we want to hear about it before anyone else does.

## Reporting

Email **hello@duitful.app**. Please include enough to reproduce it — a
receipt, a CSV, a sequence of taps, a diff.

You will get a first reply within **72 hours**. If you don't, assume the mail
went astray and send it again rather than assuming it was ignored.

There is no bug bounty. This is one person's project funded by a RM 19.90
one-time purchase; there is no budget to pay out, and pretending otherwise
would waste your time. What we can offer is a fast fix, a public entry in the
[changelog](https://duitful.app/changelog/), and credit in it under whatever
name you prefer — or none, if you'd rather.

Please don't open a public issue for a vulnerability until there's a fix out.
Everything else is welcome in the open.

## What is in scope

The whole repository, but these carry the most weight:

| Area | Where |
| --- | --- |
| Vault encryption and key derivation | `app/script.js` — `deriveKey`, `encryptRecord`, `decryptRecord`, `save` |
| Content Security Policy | the `<meta http-equiv="Content-Security-Policy">` at the top of `app/index.html` |
| Anything that can cause a network request | `connect-src` in that CSP is the enforced list |
| Encrypted Google Drive backup | `app/drive-sync.js` |
| Bill splitting (data leaves the device by design here) | `app/split.js` |
| Receipt OCR | `app/script.js`, plus the bundled Tesseract under `app/vendor/` |
| Payment and licence signing | `api/` |
| Android notification capture | `native/notification-listener/` |

Things we would consider serious:

- Any path by which vault contents, receipt images or notification text reach
  a server
- Weakening of the passcode-to-key derivation, or a way to decrypt without it
- A CSP bypass, or XSS reachable from data a user imports (a CSV, a receipt, a
  split code, a QR)
- Forging a Pro licence signature — see the caveat below before spending time
  on it
- Anything that silently loses or corrupts stored data

## Out of scope

- **Unlocking Pro by editing local storage.** Pro is a boolean the device owns
  (`isPro()` in `app/script.js`). It is deliberately not defended: enforcing it
  would mean phoning home about what a user has, which is exactly what this app
  refuses to do. Flipping it on your own device is not a vulnerability. Forging
  a *signed licence* that would validate on someone else's device is.
- Missing hardening headers on the static marketing site
- Automated scanner output with no demonstrated impact
- Anything that requires an already-compromised device, a rooted phone, or
  physical access to an unlocked one
- Social engineering of the maintainer

## What you can verify yourself

Every privacy claim on the site is meant to be checkable in the source rather
than taken on faith. [`VERIFYING-PRIVACY.md`](VERIFYING-PRIVACY.md) is a
walkthrough of the files that carry those claims, and what to run to test them.

## Known and accepted

- **The passcode is the key.** There is no recovery, no reset, no back door. Lose
  it and the data is unrecoverable — by anyone, including us. This is a design
  choice, not an oversight.
- **A shared split link is readable by whoever holds it.** That is what sharing
  means. Only what you put in the bill travels; the vault does not.
