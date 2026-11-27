# Duitful 2.0 — Country-Aware Tax Relief Packs (`MYS` / `SGP` / `HKG` + Global Vault)

*Verified against official IRD (Hong Kong), IRAS (Singapore), and LHDN (Malaysia) 2026 publications.*

## 1. Architecture & Pack Resolution

| Country Code | Mode | Pack Source | Currency | Authority | Locale Fit |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `MYS` | Built-in Pack | `app/tax-data.js` (`TAX_PACKS.MYS`) | `MYR` | LHDN | `en`, `ms`, `zh` |
| `SGP` | Built-in Pack | `app/tax-packs.js` (`TAX_PACKS.SGP`) | `SGD` | IRAS | `en`, `ms`, `zh` |
| `HKG` | Built-in Pack | `app/tax-packs.js` (`TAX_PACKS.HKG`) | `HKD` | IRD | `en`, `zh` |
| Other / `GLOBAL` | **Global Tax Receipt Vault** | `app/tax-packs.js` (`TAX_PACKS.GLOBAL`, `mode: "vault_only"`) | Vault currency | Generic | All |

- **Auto-selection:** `regionCountry()` (`MY`/`SG`/`HK`) → `MYS`/`SGP`/`HKG`; all others default to `GLOBAL` (Vault Only).
- **Override precedence:** `state.tax.rules` (custom JSON) → `TAX_PACKS[state.tax.pack]` → auto-detected from region → `GLOBAL`.

## 2. Optional Schema Extensions for `app/tax.js`

All new fields are optional and 100% backward-compatible with `MYS`:
1. `fiscal_year`: `{ start_mm_dd, end_mm_dd, assessment_basis: "current" | "preceding", label_format: "single" | "split" }` (`MYS` Jan–Dec current; `SGP` Jan–Dec preceding `YA = Y+1`; `HKG` Apr 1–Mar 31 split `2026/27`).
2. `overall_relief_cap`: `number | null` (`SGP`: `80000`; items with `counts_toward_overall_cap: false` such as SG 250% IPC donations sit outside the cap).
3. `standard_rate_bands`: optional array for `HKG` (`min(progressiveTax, standardRateTax)` — 15% up to HK\$5M, 16% above, on Net Income before allowances).
4. `tax_reduction`: `{ pct, cap }` for one-off Budget reductions (`HKG` 2025/26: 100% up to HK\$3,000; `SGP` YA 2026: 0).
5. `withholding_mode`: `"paye"` (`MYS`) | `"provisional"` (`HKG` Jan/Apr instalments) | `"giro_assessment"` (`SGP` NOA / 12-month GIRO).
6. `zakat_mode`: `"rebate"` (`MYS`) | `"none"` (`SGP`/`HKG`).
7. Item modifiers: `pct_of_income_cap` (`HKG` 35% charity), `deduction_multiplier` (`SGP` 2.5× IPC donations), `counts_toward_overall_cap`, `per_unit` (`HKG` VHIS HK\$8k/insured).

## 3. Verified 2025/26 & 2026/27 Key Figures

### Hong Kong (`HKG` — IRD Salaries Tax, `HKD`)
- **Fiscal year:** 1 Apr – 31 Mar (`2025/26`, `2026/27`). Filing: May–Jul (eTAX); payment Jan (75%) / Apr (25%).
- **Progressive bands:** 2% / 6% / 10% / 14% / 17% (steps of HK\$50k). **Two-Tier Standard Rate cap:** 15% up to HK\$5M, 16% above.
- **2026-27 Budget increases (enacted May 2026):** Basic Allowance HK\$132k → **HK\$145k**; Married HK\$264k → **HK\$290k**; Child HK\$130k → **HK\$140k** (newborn +HK\$140k for first 2 years); Parent 60+ HK\$50k → **HK\$55k**; Elderly Residential Care HK\$100k → **HK\$110k**. One-off 2025/26 tax reduction: 100% capped at **HK\$3,000**.
- **Deduction buckets:** MPF HK\$18k, Annuity/TVC HK\$60k, VHIS HK\$8k/insured, Self-Education HK\$100k, Home Loan Interest HK\$100k (HK\$120k w/ newborn), Domestic Rents HK\$100k (HK\$120k w/ newborn), Assisted Reproductive Services HK\$100k, Approved Charity up to 35% of net income.

### Singapore (`SGP` — IRAS Resident, `SGD`)
- **Fiscal year:** 1 Jan – 31 Dec, preceding-year basis (`YA 2026` = 2025 income). Filing: 1 Mar – 18 Apr.
- **Bands:** 0% (≤S\$20k) up to 24% (>S\$1M). **Overall relief cap:** S\$80,000/YA. **No personal rebate for YA 2026.**
- **Key reliefs:** Earned Income (S\$1k / S\$6k / S\$8k), Compulsory CPF (S\$20,400), CPF Cash Top-Up Self (S\$8k) + Family (S\$8k), SRS (S\$15.3k / S\$35.7k foreigners), Spouse (S\$2k), QCR (S\$4k/child), Parent (S\$9k staying / S\$5.5k not), NSman (S\$1.5k–S\$5k), IPC Donations (**250%**, outside S\$80k cap). Course Fees Relief **lapsed from YA 2026**.

## 4. `kira-ask` (Stage B) Country-Aware Tax Advice
- All tax math stays on-device; `kira-ask` receives only a compact, zero-PII `taxContext` (`countryCode`, `authority`, `currency`, `yearLabel`, `withholdingMode`, `marginalRate`, `usedStandardRate`, `overallCapRoom`, `filingDeadline`, `topOpportunities[0..4]`).
- Kira automatically tailors relief-gap advice to **LHDN (MY)**, **IRAS (SG)**, or **IRD (HK)** — and switches to receipt-tagging/export help only in `GLOBAL` vault mode.
