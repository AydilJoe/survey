# `app/brand-logos/`

Optional real logo artwork for the Loans & BNPL rows. **This directory ships
empty on purpose.**

## Why it's empty

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
