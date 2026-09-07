# Duitful

**A private money, debt and savings tracker for Malaysia.** Your figures are
AES-GCM encrypted in the browser with a key derived from your passcode
(PBKDF2, 250k iterations) and never leave the device. There is no account and
no server holding your money data — because the passcode *is* the key, nobody
including me can read your vault or recover it for you.

**Live:** <https://duitful.app> · **App:** <https://duitful.app/app> ·
**Android:** [Google Play](https://play.google.com/store/apps/details?id=com.aydiljoe.duitful)
· iOS coming soon

Plain HTML/CSS/JS. No framework, no build step for the web app.

## What it does

**Money in and out**
- Monthly income and expenses, plus a daily log with categories
- Reports with a real prior-period comparison, not a lone month
- Receipt scanning (Tesseract OCR, on-device) that reads the total, merchant
  and date, tells you its confidence, and shows whether the line items
  reconcile to the printed total
- Multi-currency with cached FX rates
- Privacy mode — hide every ringgit figure while keeping percentages, so a
  screenshot can be shared

**Debt**
- Avalanche payoff simulator: highest effective rate first, minimums rolled
  forward
- Islamic financing as a first-class contract type, not conventional maths
  with a label: Murabahah, Tawarruq, BBA, AITAB, Ijarah and Musharakah
  Mutanaqisah. Fixed profit that does not compound, ibra' (rebate) on early
  settlement, and a payoff queue that ranks by *effective* profit rate so a
  0%-APR Islamic facility sorts where it actually belongs
- Instalment and BNPL plans, with brand tiles for Malaysian providers
- Android auto-capture: reads bank and e-wallet notifications on-device and
  queues them for review

**Savings and beyond**
- Savings goals with progress
- Zakat: nisab from live gold or silver, haul countdown, deductibles
- Investment holdings and a retirement projection
- Bill splitting

**Your data**
- CSV export and import, round-trip safe
- Optional Google Drive backup of the *encrypted* blob
- Works offline once loaded; installable as a PWA

## Run it locally

```sh
python3 -m http.server 8000
```

- <http://localhost:8000/> — the landing page
- <http://localhost:8000/app/> — the app itself

The web app needs no build step. `/api/` (Billplz payments and licence
signing) only runs on Vercel, so purchase flows are inert locally — everything
else works.

## Tests

```sh
npm install
npm run test:e2e     # Playwright + headless Chromium, ~640 checks
```

The suite self-hosts the repo and starts from a fresh profile. It covers the
debt maths against worked examples, the receipt parser against a fixed corpus
of 120 real scanned receipts (mostly Malaysian) with a pinned accuracy floor,
zakat, CSV round-trips, the encryption boundary, the
service-worker cache-busting rules, and the deployment constraints that have
broken production before. Run it after touching `app/script.js`.

## Repository layout

```
app/          the web app — script.js carries most of it, plus split.js,
              investments.js, drive-sync.js, brands.js, analytics.js, sw.js
api/          Vercel functions: Billplz payments, ECDSA P-256 licence signing
index.html    the landing page (ms/index.html is the Bahasa version)
guides/       generated from scripts/guides/content/*.md — do not hand-edit
native/       Capacitor extras, incl. the Android notification listener
tests/        the end-to-end suite and its fixtures
tools/        internal admin pages (noindex)
```

## CSV format

One file, one row per record, `type` in the first column:

```
type,name,amount,balance,apr,minPayment
income,Salary,5000,,,
expense,Rent,1500,,,
debt,Credit Card,,3000,18,150
saving,Emergency fund,,5000,,
daily,Lunch,12.50,,,
setting,extraMonthly,500,,,
```

Row types: `income`, `expense`, `debt`, `saving`, `daily`, `daily-saving`,
`daily-debt`, `setting`. `income`/`expense`/`daily` use `amount`; `debt` uses
`balance`, `apr`, `minPayment`. `setting` rows carry one key each —
`extraMonthly`, the zakat block, the retirement-plan block — and a build that
doesn't recognise a key skips it rather than failing the import.

## Free and Pro

Pro is a **one-time RM 19.90**, not a subscription, and the same gate applies
on the web app and inside the native shell. Every new vault gets a 7-day Pro
trial.

| | Free | Pro |
| --- | --- | --- |
| Debts | 3 | unlimited |
| Savings goals | 2 | unlimited |
| Investment holdings | 2 | unlimited |
| Receipt scans | 3 per month | unlimited |
| Instalment / BNPL plans | — | ✓ |
| Reminders | — | ✓ |

Product ID `duitful_pro` (non-consumable). The price exists to cover the Apple
Developer Program (USD $99/year) and the Play console fee (USD $25 one-time).
Payment goes through Billplz; the licence is an ECDSA P-256 signed token, so
there is no user database behind it.

## Deployment

- **Vercel** serves <https://duitful.app>, including `/api/`. Note the Hobby
  plan builds at most **12 functions per deployment** — over that the whole
  build fails while the previous deployment keeps serving, so the site looks
  healthy and new endpoints 404. `npm run test:e2e` enforces the budget.
- **GitHub Pages** also publishes the static site from `main` via
  `.github/workflows/pages.yml`, without `/api/`.

## Native builds (Capacitor)

The same web app wraps into iOS and Android apps. The native shell adds
OS-level local notifications that fire when the app is closed, in-app
purchase, bundled OCR, and Android notification auto-capture.

```sh
npm install
npm run cap:add:ios          # first time only, needs Xcode
npm run cap:add:android      # first time only, needs Android Studio

npm run cap:sync             # copy web files into www/, then cap sync
npm run cap:ios              # open in Xcode
npm run cap:android          # open in Android Studio
npm run assets               # regenerate icons + splash from resources/*.svg
```

Signing and store steps are in [ANDROID_BUILD.md](ANDROID_BUILD.md). The
Android notification listener needs two Java files copied into the generated
project — see [`native/notification-listener/`](native/notification-listener/).
It ships patterns for Maybank, CIMB, Hong Leong, RHB, Public Bank, Touch 'n
Go, GrabPay, Boost, BigPay, SPayLater and Atome; add more in `TXN_PROVIDERS`
in `app/script.js` and `ALLOWED` in `DuitfulNotificationListenerService.java`.

---

## Licence

Duitful is free software. Three different things live in this repository and
they are not all covered by the same terms.

| What | Terms |
| --- | --- |
| **The code** — everything that runs | [GPL-3.0-only](LICENSE), plus an [app store exception](LICENSE-EXCEPTION.md) |
| **The name, wordmark, logo and icons** | Not licensed — see [TRADEMARK.md](TRADEMARK.md) |
| **The written guides** under `scripts/guides/content/` and `guides/` | All rights reserved |
| **`tests/fixtures/sroie-receipts.json`** | CC-BY-4.0, third-party — see [the fixture README](tests/fixtures/README.md) |

**GPL-3.0 for the code.** You can run it, read it, change it, and ship it,
including commercially. The condition is reciprocity: if you distribute a
modified version, that version's source has to be available too. A private
fork you keep to yourself carries no obligation at all.

That choice is deliberate. The point of publishing a finance app is that
people can check what it does with their money — a closed fork of a
privacy-first app is the one outcome worth preventing, and copyleft is the
only licence family that prevents it.

**Bring your own name.** The mark is reserved so that "which build is the real
one?" stays answerable at the point of install. Take the code; call it
something else. [TRADEMARK.md](TRADEMARK.md) sets out exactly what is and
isn't allowed, and the answer is more generous than most people expect.

**The guides are not code.** `/guides/` is search distribution, not software,
and it is not licensed for republication.

**One exception to the copyleft, and only one.** Apple's App Store terms
impose restrictions on recipients that the GPL forbids — the conflict that got
VLC pulled from the store in 2011. [LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md)
grants everyone permission to distribute through an app store despite that,
while leaving every other GPL obligation intact: whatever you ship to a store,
its source still has to be available. An app nobody can install protects
nobody's privacy.

### Contributing

Pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the
Developer Certificate of Origin sign-off (`git commit -s`), the cache-busting
rules that will otherwise strand installed users on a stale file, and the
handful of constraints that exist because they have broken something here
before. There is no CLA — you keep the copyright in what you write.

### Don't trust the claims — check them

The whole reason this is public is that "your data never leaves your device"
should be verifiable rather than believed.
[VERIFYING-PRIVACY.md](VERIFYING-PRIVACY.md) walks through the four files that
carry that promise and what to run against each. It takes about ten minutes.

Found a hole? [SECURITY.md](SECURITY.md).
