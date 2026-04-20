# Landing page screenshots & hero video

The landing's hero phone frame uses a `<video>` element with fallbacks. Drop any of these exact filenames here and the page picks them up automatically.

| Filename | Type | Purpose |
|---|---|---|
| `hero-home.mp4` | MP4 (H.264) | Primary — autoplays muted + loops in the hero phone frame |
| `hero-home.webm` | WebM (optional) | Smaller file for Chrome/Firefox; falls through to MP4 otherwise |
| `hero-home.PNG` | PNG | Poster frame while the video loads **and** the fallback if a browser blocks video |

The `<video>` references all three — first match wins. The PNG doubles as the poster so slow connections see something useful instantly.

## Record the demo on iPhone

**1. Populate the app** — import `../sample.csv` via **Data → Import** so screens aren't empty.

**2. Enable Screen Recording**
- Settings → Control Center → add **Screen Recording** if not already there.

**3. Record**
- Swipe Control Center → long-press the record button → **Microphone off** → **Start**.
- After the 3-2-1, open Safari → `duitful.app/app` → unlock.
- Walk through slowly (target **10–14 seconds** total):
  1. Home tab (2s — balance left, upcoming)
  2. Tap **Debts** (2s — weighted APR, avalanche order)
  3. Tap **Savings** (2s — progress bars)
  4. Tap **Home** → **Spend** → type a small amount → **Add entry** (2s)
- Stop from Control Center (red pill at top-left).

**4. Trim**
- Photos → find clip → **Edit** → drag yellow handles to cut off the "opening Control Center" bits → **Done** → **Save Video as New Clip**.

**5. Compress** (iOS screen recordings are 20–60 MB raw — need ~1–3 MB for web)

Pick one:

- **CapCut** (free iOS app) — Import → Export → **720p, 30fps, Medium bitrate** → Save.
- **Web tool** — `freeconvert.com/video-compressor` or `ezgif.com/video-to-mp4` → target **~1200 kbps, 720p, 30fps**.

**6. Upload**
- In Files, rename the compressed clip to exactly **`hero-home.mp4`**.
- GitHub in Safari → repo → `screenshots/` → **Add file → Upload files** → pick the mp4 → commit to the branch.

## Still screenshots (optional, for other sections)

| Filename | Content |
|---|---|
| `hero-home.PNG` | Home tab poster — required even if you have a video |
| `debts-summary.png` | Debts tab: total, weighted APR, avalanche order |
| `scan-receipt.png` | Scan receipt modal with OCR result |
| `monthly.png` | Monthly tab: Income list + Recurring expenses |

Capture with the iPhone screenshot gesture, crop the PWA install banner if it appears, save with the exact filename above.

## If you skip the video

Just upload `hero-home.PNG` and the page falls back to a static image cleanly. Zero code changes needed.
