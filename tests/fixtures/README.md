# `sroie-receipts.json` — receipt-parsing benchmark

120 real scanned receipts, **mostly Malaysian**, with the ground-truth
company, date and total that the merchant actually printed. `parseReceiptText`
in `app/script.js` is scored against them by `tests/e2e.mjs`.

## Why this exists

The receipt parser used to be tuned by eye. When it was finally measured it
turned out to be reading the total correctly on **58.4%** of real receipts —
and the failures were not random. It matched `TOTAL SAVINGS` before `TOTAL` at
Watsons, took cash-tendered instead of the bill at McDonald's, and knew no
Malay at all, so a mamak slip saying `JUMLAH` fell through to "largest number
on the page", which is whatever you handed over.

None of that is visible without a corpus. A hand-written test with three
receipts confirms whatever the author already believed. So the score is pinned
here: a change that makes the parser worse fails the build.

## Source and licence

Derived from the **ICDAR 2019 Robust Reading Challenge on Scanned Receipts OCR
and Information Extraction (SROIE)**, task 3 (key information extraction),
via the `jsdnrs/ICDAR2019-SROIE` dataset on Hugging Face.

- <https://rrc.cvc.uab.es/?ch=13>
- <https://huggingface.co/datasets/jsdnrs/ICDAR2019-SROIE>
- Licence: **CC-BY-4.0** — redistribution is permitted with attribution,
  which this file provides.

The receipts date from 2016–2018 and are largely Malaysian, which is the
population Duitful is actually built for.

## What is in the file

An array of 120 objects, taken at an even stride across the dataset's test
split so the sample keeps the same spread of chains as the whole thing rather
than whatever happened to sort first:

| field | meaning |
| --- | --- |
| `key` | the dataset's own identifier |
| `total` | ground-truth bill total, as printed |
| `company` | ground-truth merchant name |
| `date` | ground-truth date, in the receipt's own format (both `D/M/Y` and `M/D/Y` appear) |
| `text` | the OCR words, regrouped into lines |

**No images.** Only text and labels, which is all the parser sees.

`text` is reconstructed from the dataset's word boxes by grouping words whose
vertical centres fall within 0.6× the median glyph height, then ordering each
row left to right — the same rule `splitReconstructRows` applies to live OCR
output, so the fixture exercises the parser through the shape it really meets.

## A caveat worth knowing

This text is close to perfect OCR. Real camera input is worse, so the score
here is an **upper bound**, not a field accuracy. Its value is comparative: it
tells you whether a parser change helped or hurt, and it is the reason the
rewrite could be tuned at all.

The labels are not flawless either — a few carry the scanning error rather
than the receipt (`TED HENG` where the shop is `TEO HENG`). Those cap the
achievable score slightly below 100%, so do not chase the last few points.

## Refreshing it

`scripts/make-sample-data.mjs` is unrelated — that generates *invented* data
for screenshots. This fixture came from the Hugging Face rows API:

```
https://datasets-server.huggingface.co/rows?dataset=jsdnrs%2FICDAR2019-SROIE&config=default&split=test&offset=0&length=100
```

There is no reason to refresh it. A fixed corpus is the point: the number only
means something if the receipts stay the same.
