# Store badges

Official artwork, unmodified. Do not redraw, recolour, crop or animate them.

| File | Source | Rules |
|---|---|---|
| `app-store-download-black.svg` | <https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg> | [App Store marketing guidelines](https://developer.apple.com/app-store/marketing/guidelines/): use the official badge, keep clear space of ¼ its height, never smaller than 40 px tall on screen, and put it **first** when shown with other stores' badges. |
| `google-play-get-it-on.png` | <https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png> | [Google Play badge guidelines](https://partnermarketinghub.withgoogle.com/brands/google-play/visual-identity/badge-guidelines/): the PNG already includes its clear space (41 of 250 px). Show it at the same visible height as other badges. |

Side by side, scale the Play PNG to `appleHeight × 250 / 168` with a negative margin of `appleHeight × 41 / 168`, so the two visible badges match (see `marketing/instagram/scripts/triptych.mjs`).
