---
title: Data Residency 2026 — Checklist 5 minit untuk tahu app duit korang simpan data kat mana sebenar
description: DCCI Expo 12 Mei dan rules data-residency 2026 Malaysia dah start. Side infrastructure dah dihandle policy. Side consumer pula tak — ramai orang tak tahu app finance yang diorang trust tu sebenar simpan data kat mana, siapa boleh baca, apa jadi kalau leak. Ni audit 5 minit korang boleh run sendiri hari ni, sebelum leak seterusnya buat keputusan untuk korang.
keywords: data residency malaysia 2026, dcci expo 2026, on shore data malaysia, privacy app finance malaysia, e wallet privacy, pdpa amendment 2026, on device finance app, duitful privacy, data simpan mana, fintech malaysia
slug: data-residency-2026-personal-checklist
lang: ms
og_locale: ms_MY
eyebrow: Panduan · Malaysia · Privacy &amp; data
h1: Data Residency 2026: <em>checklist 5 minit</em> untuk tahu app duit korang simpan data kat mana sebenar.
lede: DCCI Expo bukak 12 Mei dan rules data-residency 2026 Malaysia dah biting. Side infrastructure dah dihandle level policy. Side consumer pula tak — ramai orang tak tahu app yang diorang trust dengan kewangan harian tu sebenar simpan data kat mana, siapa boleh baca, apa jadi kalau salah satu dari diorang leak. Panduan ni audit 5 minit yang korang boleh run sendiri hari ni, atas stack korang sendiri, sebelum leak seterusnya buat keputusan untuk korang.
date_published: 2026-05-05
breadcrumb_name: Checklist data residency 2026
card_title: Data duit korang sebenar duduk mana?
card_blurb: Checklist 5 minit consumer sebelum DCCI Expo. Audit setiap app duit dalam phone — bank, e-wallet, budgeting, BNPL — dan tahu data tu sebenar duduk mana fizikal.
cta_title: Skip cloud terus
cta_body: On-shore tu floor baru. On-device tu satu-satunya ceiling sebenar. Duitful simpan data duit korang dalam phone — encrypted AES-GCM dengan passphrase yang korang sorang tahu. Takda akaun, takda email, takda analytics. Kami sendiri tak boleh baca. Free, RM 19.90 sekali bayar untuk Pro.
cta_label: Buka Duitful
---

## Kenapa benda ni penting minggu ni

:::stat
value: 12 Mei 2026
label: DCCI Expo bukak — moment public-facing bila "data korang duduk mana" stop jadi soalan infrastructure dan jadi expectation consumer
note: Rules data-residency 2026 apply pada institusi kewangan dan fintech berlesen. App personal-finance dan SaaS handle PII Malaysian follow over 12–24 bulan akan datang. Most consumer takkan tahu app mana comply sampai sesuatu tak kena.
:::

Launch Sovereign AI Cloud [minggu lepas](/guides/sovereign-ai-cloud-data-sovereignty-2026/) cover side policy dan apa maksudnya level infrastructure. Panduan ni complement praktikal — checklist untuk app yang dah ada dalam phone korang, ditulis untuk orang yang bukan kerja tech.

## Hierarki yang korang patut tahu

:::compare
title: Lebih baik
- On-device, encrypted dengan passphrase yang korang sorang control
- On-device, encrypted dengan biometric/key system
- Cloud-hosted dalam Malaysia, end-to-end encrypted (provider tak boleh decrypt)
- Cloud-hosted dalam Malaysia, encrypted-at-rest (provider boleh decrypt dengan key)
---
title: Lebih teruk
- Cloud-hosted dalam Malaysia, plaintext
- Cloud-hosted offshore, encrypted-at-rest (provider Malaysia boleh request, foreign provider pegang keys)
- Cloud-hosted offshore, plaintext
- Cloud-hosted offshore, owned by parent tak related dalam jurisdiction lain
:::

Hierarki ni bukan pasal Malaysia vs offshore je — tu rail policy. Ni pasal berapa pihak boleh baca data korang, dan apa jadi kalau salah satu compromised. On-device dengan encryption tu satu-satunya architecture di mana jawapan untuk "siapa boleh baca data ni" adalah "takda sesiapa kecuali korang."

## Audit 5 minit

Pilih 4 app dalam phone yang korang paling guna untuk duit. Run 5 soalan sama untuk setiap satu. Most readers jumpa at least satu app yang jawapannya "saya tak tahu" — tu yang patut tengok dulu.

:::steps
title: Soalan 1 — Data tu fizikal duduk mana?
text: Tengok dalam privacy policy app, atau dalam settings bawah "Data &amp; privacy." Kalau dia tulis "data anda diproses dan disimpan dalam server di [negara]," tu jawapan. Kalau dia tulis "globally distributed servers," hampir confirm offshore. Kalau dia tak tulis langsung, anggap offshore.
---
title: Soalan 2 — Developer boleh baca tak?
text: Encryption tu pintu. "Encrypted in transit and at rest" biasa maksudnya developer pegang key dan boleh baca on demand atau bawah court order. "End-to-end encrypted" atau "zero-knowledge" maksudnya developer tak boleh. Language marketing matter sini — baca betul-betul.
---
title: Soalan 3 — Perlu akaun ke?
text: Akaun = email, no phone, password reset flow, session token simpan kat mana-mana. Setiap akaun tu attack surface dan vector leak. App yang kerja tanpa akaun (jarang untuk financial tool) eliminate seluruh kelas breach authentication-system.
---
title: Soalan 4 — Apa jadi kalau company tutup?
text: Test ni yang ramai skip. Kalau company fold, apa jadi data dengan akses korang? App on-device terus jalan selagi binary dalam phone korang boleh run. App cloud boleh hilang dengan notis 30 hari — dan history data korang sekali. Tracking expense tiga tahun korang tak selamat kalau duduk atas server orang lain dengan clause off-ramp 30 hari.
---
title: Soalan 5 — Policy tu boleh check ke sebenar?
text: Privacy policy tu janji. Codebase open-source atau audit security yang published tu evidence. App yang publish architecture diorang (atau simple sampai boleh verify) boleh dicheck. App yang cakap "kami serius pasal privacy korang" tanpa tunjuk kerja sebenar tak boleh.
:::

## Mana app duit Malaysian biasa duduk (pattern umum)

:::compare
title: App bank typical (Maybank, CIMB, RHB, Public Bank, HLB)
- On-shore by regulation (BNM mandate residency Malaysia)
- Bank boleh baca data korang; tu macam mana servicing akaun jalan
- Account-protected; biometric + password
- Survival = survival bank; PIDM-insured level deposit (bukan level data)
- Verdict: trustworthy by regulation, tapi setiap bank ada dan akan ada leak
---
title: E-wallet typical (Touch 'n Go, GrabPay, Boost, BigPay)
- On-shore untuk ledger wallet; SDK offshore untuk analytics common
- Operator boleh baca most history transaksi korang
- Account-protected; some ada biometric, semua ada recovery via no phone
- Survival = survival operator; safeguard level wallet ada tapi lebih lemah dari deposit bank
- Verdict: convenient, dengan exposure data material kepada partner advertising/analytics
:::

:::compare
title: App budgeting / aggregator typical
- Selalu offshore-hosted (server US, Singapore)
- Aggregator yang connect ke bank korang biasa boleh baca semua
- Akaun perlu; some perlu login bank korang (red flag)
- Risk survival real; sektor 2024–2025 nampak beberapa closure
- Verdict: convenience datang dengan data exposure paling besar dari semua kategori
---
title: Tool accounting/SME typical
- Mixed — some on-shore (gaya BukuKas), most offshore (Xero, QuickBooks)
- Operator boleh baca buku korang; tu produk
- Account-protected
- Survival typically strong tapi jurisdiction berbeza-beza
- Verdict: appropriate untuk record business yang IRB dah nampak, less appropriate untuk duit peribadi
:::

Pattern: lagi useful app tu rasa, lagi exposed data korang biasanya. Tu bukan kebetulan — feature useful (analytics, recommendation, social, sync) biasa perlu app baca data korang.

## Apa nak buat hujung minggu ni

:::steps
title: Run 5 soalan atas 4 app duit utama korang
text: App bank, e-wallet utama, app budgeting, dan satu lagi (provider BNPL, brokerage, accounting). Tulis jawapan dalam note. Most orang terkejut at least satu. Tu yang penting — korang dah informed.
---
title: Decide setiap app perlu tahu apa
text: Bank korang perlu tahu baki bank korang — tu structural. E-wallet perlu tahu seluruh history transaksi korang ke bila korang guna mostly untuk transit? App budgeting perlu login bank korang ke bila korang boleh log expense manual? Strip permissions yang korang tak guna sebenar.
---
title: Pindah record peribadi sensitive ke on-device
text: Track expense peribadi, schedule bayar hutang, goal simpanan, breakdown gaji — takda satu pun dari ni structurally perlu cloud. Diorang benefit dari feature convenience yang cloud enable, tapi data itself tak perlu duduk situ. On-device, encrypted, dengan passphrase yang korang sorang control tu baseline selamat.
---
title: Track move tu dalam Duitful sendiri
text: Tambah reminder berulang untuk audit privacy tahunan (1 Mac, contoh). Stack korang berubah; audit korang patut track perubahan. Tag apa-apa spend data-migration (upgrade app berbayar untuk option privacy lebih baik, subscription password manager) bawah `Privacy · 2026` supaya nampak privacy cost berapa setahun — biasa kurang RM 100, selalu kurang dari harga satu dinner.
:::

## Apa nak abaikan

:::steps
title: Claim "kami tak jual data anda" tanpa specifics
text: Tak jual bukan sama dengan tak share. Banyak app share dengan "trusted partners" atau "untuk analytics purposes" — tu vector leak yang matter. Baca section data-sharing, bukan copy marketing.
---
title: VPN dengan teater "private browsing" untuk data app
text: VPN protect traffic korang in transit. Dia tak ubah mana app simpan data korang lepas dia sampai. Kalau server app tu di Singapore, data korang di Singapore — VPN ke tak. VPN solve problem berbeza.
---
title: Janji "kami akan pindah ke server on-shore Q3"
text: Migration yang dijanji selalu slip. Soalan relevant tu data duduk mana hari ni dan dah duduk mana 12 bulan lepas. Migration future tak retroactively protect data yang dah dikumpul.
---
title: Switch dari satu app cloud ke satu lagi app cloud dan rasa lebih selamat
text: Dua app cloud dengan architecture similar adalah architecture similar. Architecture itself tu soalan — bukan provider mana yang sekarang nampak friendlier. Kalau data duduk atas server orang lain, threat model lebih kurang sama.
:::

## Soalan biasa

:::faq
q: Guna app bank tu langgar privacy hygiene baik ke?
a: Tak. Bank operate bawah PIDM dan regulation BNM; obligasi handling data diorang lebih kuat dari hampir semua app consumer. Point bukan elak bank korang — point elak layer 5 lagi app cloud atas bank yang semua nak baca apa bank dah tahu. Satu source-of-truth regulated (bank), plus tracking peribadi on-device, tu architecture sound.
---
q: Rule data residency 2026 Malaysia apply pada app budgeting saya ke?
a: Untuk institusi kewangan berlesen, ya — dah. Untuk app personal-finance tak berlesen dan SaaS, timeline rolling out 2026–2027. Banyak app akan comply diam-diam; some akan exit pasaran Malaysia daripada re-architect. Korang akan tahu mana yang mana dalam 12 bulan akan datang.
---
q: Macam mana kalau saya suka app budgeting cloud sekarang?
a: Teruskan kalau jalan untuk korang. Cuma jawab 5 soalan, tahu apa korang trade, dan jangan letak data dalam tu yang korang tak comfortable nampak dalam leak. Audit ni bukan pasal quit app — pasal informed pasal apa korang pilih.
---
q: On-device data risky tak kalau hilang phone?
a: Bergantung pada app. App on-device yang dibina betul encrypt dengan passphrase, jadi phone yang dicuri yield data encrypted-tapi-tak-boleh-baca. Trade-off: kalau hilang passphrase, takda provider boleh recover. Tu trade-off sama dengan password manager — dan most reader manage risk tu OK dengan backup tertulis passphrase recovery simpan offline.
---
q: Macam mana Duitful handle benda ni?
a: Duitful on-device by design. Seluruh app tu satu file HTML yang browser atau phone korang run locally. Data encrypted AES-GCM dengan passphrase yang korang sorang control (250,000 PBKDF2 iterations atas key derivation). Takda akaun, takda email, takda analytics SDK. Kami literally tak boleh baca data korang — bukan by policy, by architecture. Trade-off: takda auto sync across devices kecuali korang handle export/import sendiri, yang documented dalam app.
:::
