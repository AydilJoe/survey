# `app/brand-logos/`

Real logo artwork for the Loans & BNPL rows. Three marks ship today; every
other brand renders as a coloured monogram.

## What's here

| File | Brand | Source |
|---|---|---|
| `spaylater.svg` | Shopee (SPayLater is Shopee's BNPL) | Simple Icons |
| `grabpay.svg` | Grab (GrabPayLater) | Simple Icons |
| `hsbc.svg` | HSBC | Simple Icons |

From [Simple Icons](https://simpleicons.org) — the SVG data is CC0. The
trademarks remain their owners'; inclusion there is not endorsement, and the
nominative-use reasoning below is what actually permits the use here.

**Atome and Boost are deliberately absent.** Simple Icons has no Atome, and
its "Boost" is [Boost Mobile](https://www.boostmobile.com), the US carrier
(orange `#F7901E`) — not Malaysian Boost eWallet (red `#EE2E24`). Shipping
that would have put a US telco's mark on someone's Malaysian BNPL plan. Both
brands need their marks from an official press kit instead.

## Why most brands have no artwork

`app/brands.js` renders every debt as a coloured monogram tile. That works
offline, ships nothing trademarked, and — because the colour is derived
deterministically from the name when a brand isn't in the catalogue — never
leaves a row looking broken.

Real logos are a separate decision with a separate risk profile:

- **Inside the app** — showing Atome's mark next to a plan the user
  themselves created is ordinary nominative use: you can't identify the
  service without naming it, and nothing implies a partnership. Low risk,
  and common practice in account aggregators.
- **In Play Store screenshots or the feature graphic** — materially higher
  risk. Google Play's impersonation policy is enforced hardest on listing
  assets, and those are what a reviewer actually looks at.

So: dropping logos in here is reasonable. Putting the result in a store
screenshot is a different call, and should be a deliberate one.

## How to add one

Drop an SVG named after the brand id from `BRAND_CATALOGUE` in
`app/brands.js`:

```
app/brand-logos/atome.svg
app/brand-logos/spaylater.svg
app/brand-logos/grabpay.svg
```

Then set `logo: true` on that brand's entry in `BRAND_CATALOGUE`:

```js
{ id: "atome", name: "Atome", color: "#edf64b", ink: "#17181a",
  group: "BNPL", logo: true, match: ["atome"] },
```

The flag is required — dropping the file in is not enough. Without it
`brandLogoUrl()` returns `""` and the row keeps its monogram.

That is deliberate. The tempting design is to always emit an `<img>` and let
a missing file fall back via `onerror`. It does not work here: `app/index.html`
sets a CSP whose `script-src` has no `'unsafe-inline'`, so inline handlers
never run and the user gets a broken-image glyph instead of the letters. It
would also mean four 404s on every render for someone with four BNPL plans.
No flag, no `<img>`, no request.

Requirements:

- **SVG**, square-ish, transparent background. It is drawn into a 1.4rem tile
  with `object-fit: contain`, so anything with baked-in padding will look
  small.
- The tile keeps the brand background colour from `BRAND_CATALOGUE`, so a
  mark that assumes a white background needs its own colour set to `#ffffff`
  in the catalogue.
- Keep them small. These are bundled and precached by the service worker;
  add the path to `SHELL` in `app/sw.js` if you want one available offline
  on first load.

## Users can supply their own

Independently of this directory, a debt can carry an inline `image` field
(a `data:` URI, downscaled to 64px). `coerceDebtBrand()` rejects anything
that isn't a `data:image/` URI — a remote URL here would turn a private
debt list into an outbound request on every render, which is the one thing
this feature must never do.
