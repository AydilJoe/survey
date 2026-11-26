# Festive Kira stickers

Kira, Duitful's receipt friend, in every mood and every Malaysian holiday
outfit: transparent 1024 × 1024 PNGs, drawn by the app's own code
(`app/kira-seasons.js`, `app/kira.js`, `app/styles.css`, light theme).

```sh
node scripts/build-kira-stickers.mjs          # all stickers + sheet.png
node scripts/build-kira-stickers.mjs --sheet  # sheet.png only
```

Files are `kira-<mood>-<season>.png` (moods: happy, proud, sleepy, worried,
party; seasons: plain plus every look in `KiraSeasons.LOOKS`). The PNGs are
about 15 MB together, so git keeps only `sheet.png`; build the rest when you
need them.

## Using them

- Use Kira as drawn. Don't redraw, recolour, stretch, crop the face, or add
  props, words or other characters onto Kira.
- Be respectful. The outfits follow `docs/plans/kira-festive.md`: props sit
  beside Kira, on the head or in the hand, never on the face or body. Keep
  religious days quiet (no party Kira for Ramadan, Nuzul Al-Quran,
  Aidiladha, Awal Muharram, Maulidur Rasul, Thaipusam or Wesak — the build
  leaves those out), never show Kira eating or drinking during Ramadan, and
  never use Kira to make a joke about a religion or a community.
- Use a season's sticker in its own season, with its own greeting (the rows
  in `scripts/i18n/locales/*/kira.json`).
- Kira never stands for an amount, a balance or advice. No "Kira says buy
  this".
- The counting Kira (with the sempoa) means the phone's on-device AI is
  working and nothing else, so it has no sticker.
- The Duitful name and marks are covered by `TRADEMARK.md`; treat Kira the same way.
