---
title: Split bills without giving an app your bank login (Malaysia 2026) | Duitful guide
description: Bill-splitting apps want an account for you, an account for your friends, and a server that stores the whole graph. Duitful splits a RM 240 dinner into a QR code or a link that decodes on your friend's phone — no sign-up, no server copy, works even without the app.
keywords: split bills malaysia, splitwise alternative malaysia, bill splitting app no account, split dinner bill malaysia, duitnow split bill, who owes me money tracker, payment request link qr, private bill splitting, share bill with friends malaysia
slug: split-bills-without-apps-reading-your-bank-2026
lang: en
og_locale: en_MY
eyebrow: Guide · Malaysia · Splitting bills
h1: The bill was RM 240. An app shouldn't be the one that <em>remembers</em>.
lede: Every bill splitter in the store wants the same three things — an account for you, an account for your friends, and a server quietly mapping who eats with whom, how often, for how much. Splitting a RM 240 dinner four ways is about 300 bytes of information. It does not need a database.
date_published: 2026-07-30
breadcrumb_name: Splitting bills privately
card_title: Split bills without an account — QR codes, not servers
card_blurb: A RM 240 dinner, four ways, no sign-up. The request travels inside the link and decodes on your friend's phone.
cta_title: Split tonight's bill
cta_body: Duitful turns any expense into per-person requests you send as a QR or a link — free for everyone, no account, nothing on a server. Open the Debts tab to see who owes you.
cta_label: Open Duitful
---

## What you're actually handing over

:::compare
title: What a typical splitting app needs
- An account for you — email, password, often a phone number
- An account for every friend you split with
- A server holding the graph: who you eat with, how often, for how much
- Increasingly, a bank connection "to make settling easier"
---
title: What Duitful needs
- Nothing. No sign-up, no email, no bank connection
- Your friend needs no account — and no app at all
- The request lives inside a QR code or a link; there is no server copy to leak
:::

## The request travels inside the link

:::stat
value: 0
label: Servers that ever see the request
note: The payload rides in the URL's # fragment. Browsers never send fragments to the server — duitful.app/split is a static page, and the decoding happens in your friend's browser, on their device.
:::

Duitful compresses the request — name, what it's for, amount, date, optional due date — into a short code and hands WhatsApp an ordinary link. In person, the same code renders as a QR on your screen. Either way nothing was uploaded: the data moved device to device, the way a paper receipt does.

## Transfer details, one tap to paste

"How to pay me" is up to four rows you set once: `DuitNow / 012-3456789`, `Maybank / 512345678901`. Each row shows as its own line with its own copy button, and that button copies the **value only** — the account number, not the bank name — so pasting into MAE or CIMB OCTO leaves nothing to trim.

It's off by default, and the share dialog previews exactly what is about to leave your device.

## Four taps, start to finish

:::steps
title: Split from the expense you already logged
text: On the RM 240 dinner row, tap "Split this bill" — the total prefills. Your expense stays RM 240. Splitting never rewrites what you actually paid.
---
title: Add names, or split equally
text: Type three names, tap split equally, everyone lands on RM 60 — edit any amount if someone only had rice. Your own share shows as the remainder. Names are typed; Duitful never reads your contacts.
---
title: Send as a QR or a link
text: At the table, show the QR. In the group chat, share writes the line for you — "Ali requests RM 60.00 for Dinner @ Naz — link". Or copy the raw code and paste it anywhere.
---
title: Settle when the money lands
text: Tap the person and record the repayment. It books an income row dated to the day it arrived, so your cash flow tells the truth instead of quietly shrinking the original bill.
:::

## When the DuitNow lands, Android notices

With auto-capture switched on, an incoming transfer alert gets checked against what people owe you. RM 60 arriving while Ali owes exactly RM 60 raises one prompt: settle Ali's share? Within RM 1, it still asks. If two people owe the same RM 60 and the notification doesn't say who paid, it asks which — guessing would settle the wrong person.

It never settles by itself, and it never moves money. The ringgit move in your friend's own banking app; Duitful records that they did.

:::faq
q: Does my friend need Duitful?
a: No. The link opens a plain page showing who's asking, how much, what for, and your transfer details if you included them. They pay in their own banking app as usual. There's a get-the-app button, but nothing breaks if they ignore it.
---
q: Is splitting a Pro feature?
a: No. Splitting, requests and lending are free for everyone, with no cap. The one exception is the "scan receipt" shortcut inside the split dialog — it reuses the existing receipt-OCR quota. Typing the total is free and always available.
---
q: Can Duitful collect the money for me?
a: No, deliberately. Moving money in Malaysia is licensed activity under Bank Negara, and Duitful is a tracker, not a payment service. A request is an IOU record; payment happens in your friend's bank app via DuitNow or a normal transfer.
---
q: Someone sent me a request — where does it go?
a: Debts tab → "Add a request": paste the code, scan the QR, or tap through from the link. It lands as something you owe, and settling it offers to log the matching expense. Scanning the same request twice creates one record, not two.
:::
