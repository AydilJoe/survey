---
title: Your ASB "return" is probably wrong — money-weighted return explained | Duitful guide
description: "Up RM 3,000" means nothing if you topped up monthly along the way. Money-weighted return (XIRR) is the number that accounts for when your cash actually went in — here's why it differs from the dividend rate, and how Duitful computes it on-device.
keywords: money weighted return, xirr malaysia, asb return calculation, epf dividend vs return, unit trust actual return, portfolio return calculator malaysia, annualised return malaysia, duitful investments
slug: money-weighted-return-asb-epf-2026
lang: en
og_locale: en_MY
eyebrow: Guide · Malaysia · Investing
h1: Your portfolio is "up RM 3,000". That tells you <em>almost nothing</em>.
lede: If you topped up along the way, most of that RM 3,000 might just be your own money coming back to greet you. Money-weighted return is the figure that weighs every top-up and dividend at the date it actually happened — and it's usually lower than the number you're proud of.
date_published: 2026-07-29
breadcrumb_name: Money-weighted return
card_title: The return your statement won't compute
card_blurb: "Up RM 3,000" hides when the money went in. Money-weighted return weighs every top-up and dividend by its date — here's the maths and the honest caveats.
cta_title: See your real annualised return
cta_body: Add your holdings once, log top-ups and dividends as they happen, and Duitful shows your money-weighted return per holding and for the whole portfolio — computed on your device, with "—" instead of a guess when there's under 90 days of history.
cta_label: Open Duitful
---

## Why the simple sums lie

:::stat
value: 6.9% vs 21%
label: Same holding, two "returns"
note: RM 10,000 in, RM 400 dividend taken as cash, worth RM 11,000 two years later. "Total gain ÷ capital" says 14%; add the dividend and people quote up to 21% over the period. The money-weighted annualised answer is 6.9% — the only figure you can compare against EPF's dividend or a fund's factsheet.
:::

Two things break the back-of-envelope maths. **Time**: a 10% gain over four years is not a 10% return. **Your own cash flows**: if you started with RM 10,000 and topped up RM 5,000 last year, dividing today's value by RM 15,000 punishes the top-up as if it had all four years to grow.

Money-weighted return (the maths behind Excel's XIRR) fixes both: every top-up, withdrawal and cash dividend is dated, and the solver finds the single annual rate that makes your actual cash-flow history grow into today's value.

## The three rules that keep it honest

:::steps
title: Top-ups are not gains
text: New money in raises your balance, not your return. Duitful records top-ups as flows, distinct from valuations, so a deposit never masquerades as performance.
---
title: Reinvested dividends are not new money
text: An ASB dividend you leave inside is return, not contribution — it's already in the unit balance. Counting it as a flow would double-book it. Cash dividends you take out, on the other hand, are money returned to you and count in your favour.
---
title: Under 90 days, say nothing
text: A 3% gain over three weeks annualises to roughly 68% — precision-shaped nonsense. Duitful shows "—" until a holding has a quarter of history, and never clamps an unanswerable case to a fake number.
:::

## Money-weighted vs the dividend rate

EPF declaring 6.3% and your money-weighted EPF return are different animals: the declared rate applies to the year's opening-ish balance under EPF's formula, while your MWR blends every contribution month across the year. Neither is wrong — but only MWR lets you compare *your* EPF, *your* ASB and *your* unit trust on one footing, fees and timing included.

:::compare
title: What the factsheet shows
- Fund-level, time-weighted performance
- Ignores when you personally bought in
- Gross of your entry timing, sometimes of fees
- Great for judging the manager
---
title: What money-weighted return shows
- Your account, your dates, your fees
- A late lump sum before a dip shows up honestly
- One comparable annualised figure across holdings
- Great for judging your outcome
:::

## The privacy angle

Every calculator that does this online asks you to type your full cash-flow history into someone's server. Duitful runs the solver on your phone against holdings that are already encrypted there — no price API is ever contacted, because a per-holding quote fetch would fingerprint exactly what you own.

:::faq
q: Why is my money-weighted return lower than my fund's advertised return?
a: Usually timing: contributions that arrived late in a good run, or just before a dip, drag your personal rate below the fund's full-period figure. Fees and sales charges land on you too. If the gap is persistently large, your entry pattern — not the fund — is the thing to look at.
---
q: Can it be negative while my balance is at an all-time high?
a: Yes. If most of your balance is recent top-ups, a small market dip can put the dated maths underwater even though the balance number keeps rising. That's the honesty working as intended.
---
q: How is this different from CAGR?
a: CAGR handles one lump sum with no flows — start value, end value, done. The moment you top up monthly, CAGR has no honest answer; money-weighted return is the generalisation that does.
---
q: What does Duitful need from me for the maths to be right?
a: Three habits — record top-ups as top-ups (not by editing the balance), log dividends and tick whether they were reinvested, and update valuations when statements arrive. The flows-vs-valuations distinction is what makes the return computable at all.
:::
