# `/marketing/` — Threads & Instagram kit

Live at **`duitful.app/marketing/`**. The Social section on the landing page
links here, and each card on the landing links to the matching guide on
`duitful.app/guides/` so the social blurb and the long-form article never
drift apart.

## Files

```
marketing/
├── index.html              ← public viewer (tabbed EN/BM captions, copy buttons, downloads)
├── captions.md             ← raw markdown source for all 8 captions
├── README.md               ← this file
└── images/
    ├── 01-be-duitful.svg / .png         (brand intro     → /guides/)
    ├── 02-avalanche.svg / .png          (debt avalanche  → /guides/crush-credit-card-debt-avalanche-2026/)
    ├── 03-privacy.svg / .png            (privacy         → /privacy/)
    └── 04-no-subscription.svg / .png    (pricing         → /#pricing)
```

All images are **1080×1350** (Instagram 4:5 portrait). Same file works for
Threads. Brand palette matches the landing (`#e8dfd0` cream, `#c8704b`
terracotta, `#8fa078` sage, Fraunces serif).

## Re-rendering PNGs

Edit the `.svg` then:

```sh
node scripts/render-marketing-images.mjs
```

Outputs four PNGs back into `marketing/images/`. Uses `sharp` (already a
dev dependency).

## Posting workflow

1. Open `https://duitful.app/marketing/` in the browser.
2. Pick a post, click the right tab (Threads/Instagram, EN/BM), hit **Copy**.
3. Download the PNG below the image.
4. Paste into Threads / Instagram, attach the image, post.
5. On Threads, drop the guide link as the **first reply** (Threads
   de-prioritises posts with external links in the body).

## Suggested cadence

| Week | Post | Channel |
|------|------|---------|
| 1 (Mon) | 01 — Brand intro     | Threads + IG |
| 1 (Thu) | 03 — Privacy         | Threads + IG |
| 2 (Mon) | 02 — Avalanche       | Threads + IG |
| 2 (Fri) | 04 — No subscription | Threads + IG |

Cross-link Threads → IG and vice versa in replies.

## Adding a new post

1. Add a new `.svg` to `images/` (1080×1350, brand palette).
2. Run `node scripts/render-marketing-images.mjs` to produce the PNG.
3. Append a section to `captions.md` with EN + BM for both Threads and IG.
4. Append a card to `marketing/index.html` (copy an existing `<article class="post">`).
5. If it deserves landing-page placement, add a fifth `<a class="s-card">` to
   the `#social` section in both `/index.html` and `/ms/index.html` — but
   the grid is currently sized for 4. Either swap one out or change
   `grid-template-columns: repeat(4, 1fr)` accordingly.
