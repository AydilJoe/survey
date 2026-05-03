---
title: Tokenised deposits Malaysia 2026 — How DAIH is moving money on the blockchain
description: BNM's Digital Asset Innovation Hub (DAIH) just onboarded its first wave of tokenised deposit trials for 2026. What tokenised deposits actually are, how they differ from CBDC and stablecoins, what changes for retail and SME users, and what to track in Duitful right now.
keywords: tokenised deposits malaysia, daih bnm, digital asset innovation hub, ringgit blockchain settlement, wholesale cbdc malaysia, project nexus malaysia, dlt clearing malaysia, sme cross border settlement, duitful merchant, blockchain banking malaysia
slug: tokenised-deposits-malaysia-2026
lang: en
og_locale: en_MY
eyebrow: Guide · Malaysia · Banking &amp; settlement
h1: Tokenised deposits 101: <em>how Malaysia is moving money</em> on the blockchain in 2026.
lede: Bank Negara's Digital Asset Innovation Hub (DAIH) just onboarded its first wave of real-world tokenised-deposit trials for wholesale and cross-border settlement. This is the boring, important version of "blockchain in banking" — institutional liquidity, not retail crypto. Here's what it is, what changes for you, and what to track now.
date_published: 2026-05-03
breadcrumb_name: Tokenised deposits Malaysia 2026
card_title: Tokenised deposits, decoded
card_blurb: BNM's DAIH is running tokenised-deposit trials for wholesale and cross-border settlement. What it is, how it differs from stablecoins, and what to track now.
cta_title: Track every settlement channel separately
cta_body: Card, DuitNow QR, e-wallet, GIRO, and now tokenised-deposit rails — fees and timing differ on each. Tag channel as a Category in Duitful and Reports tells you which channel is bleeding margin. Free to start, RM 19.90 one-time for Pro.
cta_label: Open Duitful
---

## What just happened

:::stat
value: First wave · Live trials
label: BNM's Digital Asset Innovation Hub (DAIH) onboarded its first cohort for tokenised-deposit trials, focused on wholesale domestic and cross-border settlement.
note: This is the official transition of blockchain rails in Malaysia from "crypto speculation" to "institutional liquidity." Retail use cases come later, and through licensed banks — not public chains.
:::

Tokenised deposits are commercial-bank money — your RM in a bank account — represented as tokens on a permissioned distributed ledger. The token is a 1:1 claim against the issuing bank, settled in central-bank money behind the scenes. From the customer side, it still feels like Maybank or CIMB. From the bank's side, the rails have changed.

## How it differs from stablecoins and CBDC

:::compare
title: Stablecoins (private)
- Issued by non-banks (often offshore)
- Backed by reserves the issuer holds
- Operate on public chains (Ethereum, Solana, etc.)
- Counterparty risk = the issuer
- Regulatory status in Malaysia: grey, retail-restricted
---
title: Tokenised deposits (banks)
- Issued by licensed banks
- Backed 1:1 by your actual deposit
- Operate on permissioned chains run by banks / central bank
- Counterparty risk = your bank (same as today)
- Regulatory status: under BNM oversight via DAIH
:::

CBDC (a wholesale "digital ringgit" issued directly by BNM) is a separate workstream. Today's DAIH cohort is about commercial-bank tokens settling on shared rails, not BNM minting digital cash for the public.

## What changes for retail (right now: very little)

:::steps
title: You won't see "tokenised" in your banking app
text: The customer experience stays as it is — DuitNow QR, debit card, online banking. The change is back-end: how the money moves between banks, how settlement clears, how cross-border flows route. You experience it as faster availability and (eventually) lower fees, not as a new app.
---
title: Cross-border SME payouts get cheaper first
text: The real near-term win is cross-border. Sending SGD to a Singapore designer, receiving USD from a Jakarta client — those flows today carry 2–4% all-in (FX spread + correspondent fees). Tokenised deposits on shared rails (think Project Nexus, ASEAN-5 corridors) target sub-1% all-in over the next 18–36 months.
---
title: Domestic clearing speeds up, modestly
text: DuitNow QR is already near-instant for retail. Tokenised-deposit rails primarily upgrade interbank GIRO, batch payroll runs, and large-value transfers — moving them from T+1/T+3 to near real-time. Useful for SMEs running payroll on the 25th. Invisible to most consumers.
:::

## What to track in Duitful right now

:::steps
title: Channel as a Category on every settlement
text: When the daily payout from your processor hits — Stripe, iPay88, Razer Merchant, Senangpay, etc. — log it in Duitful with Category set to the channel. The fee is the difference between gross sales and the payout. After 90 days, Reports tells you which channel costs the most.
---
title: Cross-border separately, in source currency
text: Any payment in a non-MYR currency, log the original amount and let Duitful auto-convert. Note the FX spread the processor charged in the description. That's the line item tokenised-deposit rails will compress — you want a clean baseline before they ship.
---
title: Payroll &amp; supplier batches as their own line
text: Monthly GIRO payroll, supplier ACH, contractor payouts — tag them so you can see the timing improvement when banks switch your large-batch transfers to DLT settlement. Most SMEs will start seeing T+0 batch settlement within 12–24 months for participating banks.
:::

## What to ignore

:::steps
title: "Buy the BNM tokenised-deposit token" pitches
text: There is no public token to buy. Tokenised deposits are commercial-bank liabilities on a permissioned ledger — they are not investment instruments. Anyone selling you a token claiming to be DAIH-related is running a scam. Report to BNM's eLINK and the Securities Commission.
---
title: "Public-chain MYR stablecoin" rebrands
text: Some projects are quietly rebranding existing public-chain stablecoins as "Malaysia-friendly." Without explicit BNM oversight under the existing payment systems framework, they sit in regulatory grey. Don't accept them as a merchant. Track only legitimate channels through licensed PSPs.
---
title: "Crypto-as-payment will replace cards" narratives
text: Tokenised deposits are not crypto-as-payment. They are bank money on better rails. The customer-facing payment instruments (cards, QR, wallets) stay the same in 2026. Anyone conflating the two is selling a course or a token.
:::

For broader merchant payment hygiene, the [Ringgit stablecoins for merchants guide](/guides/ringgit-stablecoins-merchant-fees-2026/) covers the same territory from the fee-compression angle. This guide and that one fit together.

## Common questions

:::faq
q: Is my bank deposit safer or riskier on tokenised rails?
a: Same risk as today — the deposit is still a claim against your bank, and PIDM coverage applies the same way. The token is just a representation of that claim on a shared ledger. No new counterparty added.
---
q: Will my CIMB or Maybank app look different?
a: No, not in 2026. The rail change is invisible to the consumer. Banks may eventually surface "instant cross-border" as a feature, but that's a UX label on top of the new plumbing — not a new app.
---
q: How does this affect my e-invoice obligations?
a: Not at all. E-invoice requirements are independent of the settlement rail. Whether the customer paid via DuitNow QR, card, or a future tokenised-deposit transfer, you still issue the e-invoice with the MYR amount. Duitful's CSV export keeps channel and amount cleanly separated for your accountant.
---
q: I run an SME paying suppliers in Singapore and Indonesia. When can I expect lower fees?
a: Expect partial production rollout via your existing bank within 12–18 months for ASEAN-5 corridors, and broader availability over 24–36 months. The price compression you'll feel: today's 2–4% all-in cross-border drops toward 0.5–1.5%. Track your current effective rate now so you have a baseline.
---
q: What do I do today besides waiting?
a: Three things. (1) Log every settlement by channel in Duitful so you have a real fee baseline. (2) When your bank's relationship manager mentions "tokenised settlement" or "DLT-based corridors," ask to be in the early cohort. (3) Don't switch processors based on vendor pitches — wait for your existing bank to ship it as a standard offering.
:::
