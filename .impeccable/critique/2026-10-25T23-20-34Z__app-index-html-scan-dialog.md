---
target: receipt scan
total_score: 20
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "file:/home/user/survey/app/index.html#scan-dialog"
timestamp: 2026-10-25T23-20-34Z
slug: app-index-html-scan-dialog
---
# Critique: receipt scan (app/index.html #scan-dialog, app/script.js runReceiptOcr/startReceiptScan)
Method: dual-agent. Score 20/40 (Acceptable).
| # | Heuristic | Score |
|---|---|---|
| 1 | Visibility of status | 2 |
| 2 | Real world | 3 |
| 3 | Control & freedom | 2 |
| 4 | Consistency | 2 |
| 5 | Error prevention | 1 |
| 6 | Recognition | 3 |
| 7 | Efficiency | 2 |
| 8 | Minimalist | 2 |
| 9 | Error recovery | 1 |
| 10 | Help | 2 |
## Priority issues
- [P0] Total marked READ when items/TUNAI-BAKI disagree (live: 23.40 read as 23.46, READ, "RM 0.06 unaccounted" below fold). parseReceiptTotal confidence = keyword tier only (script.js:11306). Fix: downgrade on mismatch, show "Items add up to RM 23.40 — use that?" on the total card, focus amount. /impeccable harden
- [P1] Stray </div> at index.html:1761 closes #scan-result early; type pills, debt field, items, Raw OCR text visible during loading/failure. /impeccable polish
- [P1] Failure dead end: "Scan failed: <err.message>" (Tesseract jargon), no Retake/Enter manually, progress track stays; quota spent at file pick (script.js:12172/12197). /impeccable clarify
- [P1] "Use these values" doesn't save; type asked twice (dialog pills + form pills). Make primary "Add RM 23.40" with undo; demote form edit. /impeccable distill
- [P2] Loading not honest/accessible: #scan-status no aria-live, raw engine strings, bar 0% during engine load, no progressbar role, dialog unnamed. /impeccable harden
## Detector/measured
- Confidence chips 9.92px, green "read" 3.98-4.27:1 (fail). "Total" label 10.88px.
- Targets <44px: #scan-amount 38h, currency toggle 37h, pills 34h, summaries 24h.
- Scan receipt button under the bottom tab bar on first load at 390x844.
- False positives: broken-image #scan-preview (src set at runtime); width transition on 6px progress bar.
## Personas
Casey: Use these values looks final -> entry lost. Jordan: "Raw OCR text", Tesseract error, US date format, quota unexplained. Riley: failed scan costs quota; no-keyword receipt takes TUNAI 50.00.
## Minor
alt="" on preview; READ ambiguous; 46-currency select no recents; category never suggested for known chains.
