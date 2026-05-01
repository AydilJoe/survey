---
title: Ringgit stablecoins for Malaysian merchants — Duitful guide
description: Industry reports point to a surge in blockchain-based settlement for the Ringgit, with retail e-payments at RM831 billion. What native MYR stablecoins and DLT clearing actually mean for merchant fees, what to track, and what's still hype.
keywords: ringgit stablecoin malaysia, myr stablecoin, blockchain settlement malaysia, dlt retail payments, merchant transaction fees malaysia, e-payment fees malaysia, sme payment processing, duitful merchant
slug: ringgit-stablecoins-merchant-fees-2026
lang: en
og_locale: en_MY
eyebrow: Guide · Malaysia · Merchant payments
h1: Lower fees, <em>same Ringgit</em>.
lede: With Malaysian retail e-payments at RM831 billion, infrastructure is moving toward native MYR stablecoins and DLT-based clearing — pitched at lower merchant fees and faster settlement. Here's what's real, what's still pilot, and what a small merchant should track in Duitful right now.
date_published: 2026-05-01
breadcrumb_name: Ringgit stablecoins for merchants
card_title: Ringgit stablecoins, demystified
card_blurb: What native MYR stablecoins and blockchain settlement mean for merchant fees. Track what's real, ignore the hype, log every channel cleanly in Duitful.
cta_title: Track every payment channel separately
cta_body: Card, DuitNow QR, e-wallet, and now stablecoin rails — fees differ on each. Log channel as a Category in Duitful and Reports tells you which channel is bleeding margin. Free to start, RM 19.90 one-time for Pro.
cta_label: Open Duitful
---

## The headline number

:::stat
value: RM 831 billion
label: Malaysian retail e-payments volume, latest BNM figures
note: Roughly the same scale as the entire national budget. Even a 10–20 bps fee reduction on a fraction of this flow is meaningful for SME merchants.
:::

The pitch for blockchain-based settlement and native MYR stablecoins is simple: merchants today pay 0.5–2.5% per transaction on cards and certain e-wallets, with T+1 to T+3 settlement. DLT rails promise sub-1% fees and near-instant settlement, with the underlying unit of account still being one Ringgit.

## What's actually happening

:::steps
title: Bank-issued tokenised deposits
text: Major Malaysian banks are piloting tokenised deposits — your RM in a bank account, represented on a permissioned ledger. For merchants, this changes the back-end (how the money moves between banks), not the front-end (you still accept DuitNow QR or card on the customer side).
---
title: Native MYR stablecoins
text: Industry consortia and BNM-overseen projects are exploring 1:1 MYR-backed stablecoins on permissioned and public chains. Use cases: cross-border SME payouts (replacing SWIFT correspondent fees) and B2B supplier payments (replacing 3-day GIRO).
---
title: Wholesale DLT clearing
text: BNM's wholesale DLT initiatives (think Project Dunbar successor work) target interbank settlement, not retail. Merchants benefit indirectly via lower interchange and faster funds availability.
:::

## What it means for merchant fees

:::compare
title: Today
- Card: 0.8–2.5% (debit cheaper, credit/AmEx pricier)
- DuitNow QR: free up to RM 1,000 / capped above
- E-wallet: variable, 0–1.5% with surcharges
- Cross-border: 2–4% incl. FX spread
- Settlement: T+1 to T+3 typical
---
title: With DLT / stablecoin rails (12–36 mo)
- Card: largely unchanged in the near term
- DuitNow QR: stays the cheapest domestic rail
- E-wallet: pressure to compress fees
- Cross-border: target 0.3–0.8% incl. FX
- Settlement: near-instant for participating rails
:::

The biggest near-term win for SMEs is **cross-border**. Domestic DuitNow QR is already best-in-class on fee — DLT doesn't change that meaningfully. Cross-border SME payouts (paying a Singapore designer, receiving from a Jakarta client) is where 2–4% becomes sub-1%, and that compounds fast on a small business with even modest international flow.

## What to track right now

:::steps
title: Channel as a Category on every settlement
text: When the daily payout hits, log it in Duitful with Category set to the channel — `Card`, `DuitNow QR`, `Touch n Go`, `Boost`, `GrabPay`, etc. The fee is the difference between gross sales and the payout. After 90 days, Reports tells you which channel is bleeding margin.
---
title: Cross-border separately
text: Any payment that crosses a currency — log the original currency and let Duitful auto-convert. Note the FX spread the processor charged. That's the line item DLT rails will eventually compress; you want to know your starting point.
---
title: Effective fee rate per channel
text: Monthly: total fees ÷ total gross volume per channel. Most merchants don't know their effective rate per channel. Once you know it, switching the mix toward cheaper channels is a 30-second decision.
:::

## What to ignore (for now)

:::steps
title: Public-chain MYR stablecoin marketing
text: Any project promising "MYR stablecoin on Ethereum/Solana" without explicit BNM oversight is regulatory grey at best. Don't accept it as a merchant. The legitimate retail rails will come through licensed banks and PSPs.
---
title: Crypto-as-payment for retail
text: Accepting BTC/ETH at the till is not the same conversation. Volatility, tax treatment, and customer base in Malaysia don't justify it for most retail SMEs in 2026.
---
title: "Save 90% on fees" pitches
text: Real fee compression in the near term is in the 30–60% range on cross-border, and minimal on domestic QR (which is already nearly free). Anyone promising 90% on domestic flow is either misrepresenting or rolling out unsustainable subsidies.
:::

For broader SME expense and payment hygiene, the [SME / freelancer tracker guide](/guides/sme-freelancer-expense-tracker/) is the operational baseline — channel-level tracking layers on top of that.

## Common questions

:::faq
q: Should I switch processors for the new rails?
a: Not yet for most merchants. Wait until your existing bank or processor offers DLT settlement as part of the standard merchant agreement — that's the first signal it's production-grade. Track your current effective fee rate so the comparison is real, not vibes.
---
q: Is BNM banning crypto?
a: No. BNM regulates payment instruments and licensed e-money. Public-chain crypto for investment sits with the Securities Commission. Stablecoin issuance for retail payments will likely require BNM licensing under the existing payment system framework.
---
q: How does this affect my e-invoice obligations?
a: Not at all. E-invoice requirements are independent of the settlement rail. Whether the customer paid in card, DuitNow, or a future MYR stablecoin, you still issue the e-invoice with the MYR amount. Duitful's CSV export keeps the channel and amount cleanly separated for your accountant.
---
q: What about cross-border payouts to my Singapore designer today?
a: Today, the cheapest licensed options are Wise Business, fintech FX accounts (Aspire, Airwallex), and DuitNow Cross-Border (where supported). Log the SGD amount in Duitful, let it auto-convert to MYR, and track the spread. When DLT rails ship at scale, you'll have a clean baseline to compare.
:::
