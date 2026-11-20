# Scanned / photographed bank statements: plan (not started)

Status: **built in 1.57.15** (19 Nov 2026). Follows statement import (1.57.0).
Still to do: check real OCR quality on a phone (the e2e OCR is a stand-in
fed from the synthetic layouts), and skew/rotation if photos come out
crooked — rows are grouped by baseline, so a tilted photo can merge rows.

## Today

`app/statement.js` reads text PDFs with the vendored pdf.js, parses rows with
per-bank rules (`STATEMENT_LAYOUTS`, `parseGenericStatement`), checks totals
with `reconcileStatement`, and uses on-device AI only for category and payee
(`statementAiSuggest`). PDFs with no text layer, and photos of statements,
get "not supported yet".

## Plan

1. **Detect**: a page with no text from pdf.js is a scan. Also accept photos
   (camera / gallery) of statement pages.
2. **OCR on the phone**: render each page to an image with pdf.js, then reuse
   the receipt OCR path (ML Kit text recognition in the Android/iOS shells,
   Tesseract.js on the web). Keep the line boxes (as `receiptReadWithBoxes`
   does) so columns can be rebuilt from x positions.
3. **Rebuild rows**: group OCR lines into rows by y, assign date / description
   / debit / credit / balance columns by x, then feed the same layout rules.
4. **Trust only the maths**: OCR misreads digits, so a statement imports only
   when `reconcileStatement` passes. If it doesn't, show the page and let the
   user correct the flagged rows; never guess. Mark these rows "read from a
   scan" in review.
5. **Privacy**: everything stays on the phone, as with text PDFs. Images are
   dropped after reading.
6. **Gating**: counts toward the same `FREE_STATEMENT_IMPORTS_MONTHLY`.

## Tests

Synthetic scanned PDFs and photos (render the synthetic fixtures in
`tests/fixtures/statement-pdfs.mjs` to images, add noise or skew), with stubbed
OCR results for the shells. **Never use real statements in the repo.**
