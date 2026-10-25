---
target: split bills
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:/home/user/survey/split/index.html"
target_fingerprint: "sha256:516921b20994ae6d021f7f1cd1d0206552fbc9f5f38ded77a20ce39da773d117"
target_path: /home/user/survey/split/index.html
timestamp: 2026-10-25T23-20-34Z
slug: split-index-html
---
# Critique: split bills (split/index.html, app/split.js, split dialogs in app/index.html)
Method: dual-agent. Score 24/40 (Acceptable).
| # | Heuristic | Score |
|---|---|---|
| 1 | Visibility of status | 2 |
| 2 | Real world | 2 |
| 3 | Control & freedom | 3 |
| 4 | Consistency | 2 |
| 5 | Error prevention | 3 |
| 6 | Recognition | 2 |
| 7 | Efficiency | 3 |
| 8 | Minimalist | 2 |
| 9 | Error recovery | 3 |
| 10 | Help | 2 |
## Priority issues
- [P0] Friend without Duitful can't close the loop: friend page has only "I have Duitful"/"Get Duitful"; paid receipt only from the app; payToEnabled off by default so no way to pay shown. Fix: primary "I've paid" on the friend page producing a paid link back via wa.me; prompt How to pay me on first share. /impeccable shape
- [P1] Mode pills all active after any tap: generic ".type-pills .pill" handler (script.js:6560) binds split-mode pills, setDailyType(undefined) -> every pill without data-type active (script.js:2193); also wipes Add-entry type. Mode switch drops "What for". /impeccable harden
- [P1] ~22 taps for 3 people; share loop per person with no "1 of 3"; quick split hidden under More details; "Equally" is where you type uneven amounts. /impeccable distill
- [P2] Settled people vanish; no per-bill progress or completion moment. /impeccable delight
- [P2] Friend page: English only, "Someone is requesting", light only, 63x29 copy buttons, account number breaks mid-number, Google Fonts on a "never sent to a server" page, primary button 3.4:1 contrast. /impeccable adapt
## Detector/measured
- split/index.html: .btn-primary #fffaf2 on #c8704b 3.4:1 (x3); pay labels 10.5px; "PEOPLE" 10.24px, "WHAT LEAVES YOUR PHONE" 9.92px in app.
- "How to pay me — edit" 3.19:1, 157x24; share checkbox 13x13; ✕ 35x35; most buttons 34-37px tall.
- No aria-live on compose hint, ingest error, friend Copy buttons. Share dialog initial focus on the dialog itself.
## Personas
Casey: three trips to WhatsApp. Jordan: Split/Request/Lent distinction, "Receivables". Friend: main button assumes the app, no pay details by default, no BM, no "I've paid".
## Minor
DD/MM dates; Remind resends request text; truncated loan toast; long By item dialog; Cancel/Create not full width.
