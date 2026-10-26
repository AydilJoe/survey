# App Store screenshots

Six 6.9" iPhone screenshots for App Store Connect, in `en/`, upload order:

| # | File | Caption | Screen |
|---|---|---|---|
| 1 | `01-home.png` | See what's *left* this month. | Home: balance after bills and spending |
| 2 | `02-payoff.png` | Know the month you're *debt-free.* | Debts: payoff plan, "When each debt is cleared" |
| 3 | `03-lock.png` | Your money *stays on your phone.* | First-run lock screen: Encrypted / No account / Offline |
| 4 | `04-scan.png` | Snap a receipt. *Done.* | Receipt scan result, total checked, "Add RM 23.40" |
| 5 | `05-split.png` | Split the bill in *one message.* | Split share: "Send all 3 in one message" |
| 6 | `06-islamic.png` | Islamic financing, *done properly.* | Debts: murabahah row with ibra' |

The first three show in search results, so they carry the three reasons to
install: what's left, when you're debt-free, and that nothing leaves the phone.

## Apple's rules this set follows

- **Size:** 1320 × 2868 px portrait (6.9" display). App Store Connect scales
  it down for every smaller iPhone, so no other sizes are required.
- **Format:** PNG, RGB, no alpha channel (App Store Connect rejects
  transparency).
- **Shows the app in use** (guideline 2.3.3). Every screen inside the frame
  is the real app, rendered from this repo with sample data: no mock-ups,
  no features that don't exist.
- **Accurate claims** (2.3.7): each caption describes what that screen does.
- **No other platforms, no outside purchase** (2.3.10, 3.1.1): no Android,
  Google Play, web checkout or prices appear. "Restore with Google" on the
  lock screen is the Google Drive backup sign-in, which the iOS app has.
- **Sample data only:** fictional names and amounts, nobody's real figures.
- The status bar shows 9:41 with full signal and battery, as in Apple's own
  marketing.

## Regenerating

After a UI change, or for a Bahasa Melayu set (copy `en/` to `ms/` and
translate the `h` / `s` captions in `compose.mjs`):

```sh
export WORK=/tmp/duitful-shots
npm i --prefix "$WORK/fonts" @fontsource-variable/fraunces @fontsource-variable/inter @fontsource/jetbrains-mono
python3 -m http.server 8765 &          # from the repo root
node marketing/app-store/scripts/capture.mjs   # real app → raw screens
node marketing/app-store/scripts/compose.mjs   # captions + frame → en/*.png
# then strip the alpha channel, e.g.:
for f in marketing/app-store/en/0*.png; do ffmpeg -y -i "$f" -pix_fmt rgb24 t.png && mv t.png "$f"; done
```

Set `CHROMIUM_PATH` if Playwright's bundled browser isn't installed. The
fonts are installed locally because Google Fonts may be unreachable from CI;
the scripts serve them to the app in place of the Google Fonts request.

## Google Play feature graphic

`../google-play/feature-graphic.png` — 1024 × 500, RGB, the banner across the
top of the Play listing (Play Console → Main store listing → Graphics). The
App Store has no equivalent slot. Regenerate with
`node marketing/app-store/scripts/feature-graphic.mjs` after `capture.mjs`
(it reuses the raw Home screen), then strip the alpha channel as above.

## Creative assets (optional, iOS/iPadOS 27+)

From [App Store asset best practices](https://developer.apple.com/app-store/asset-best-practices/)
and the creative-asset specs. In `creative/`, regenerate with
`node marketing/app-store/scripts/creative-assets.mjs` after `capture.mjs`:

| File | Placement | Size | Idea |
|---|---|---|---|
| `header-21x9.png` | Product page header | 3840 × 1646 (21:9) | "Your money *stays on your phone.*" + Payoff / Home / Scan |
| `search-3x2.png` | Search results | 3840 × 2560 (3:2, the max) | "Be *duitful* with your duit." + Payoff / Home / Split |

Both: PNG, no alpha; one clear idea; real app interface; no prices, URLs,
awards or other platforms. The header's lower-left is kept quiet because the
store draws the app name and Get button over the header.
Upload: App Store Connect → the app version → Product Page Information →
**Header and Search Results** (or Asset Library), then check them in
**Preview** on iPhone and iPad before submitting — the preview is the only
place the system overlay and safe area can be seen exactly.
