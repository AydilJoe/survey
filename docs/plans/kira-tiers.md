# Kira tiers: Pro taste and trial (AI+ server contract)

Decided 27 Nov 2026 by the owner. This is the server side the AI+ owner builds; Duitful 2.0's Kira bubble reads the result.

## Tiers

| Who | Cloud Kira (AI+ tasks) | Resets | Middle bubble |
|---|---|---|---|
| Free | none: on-device speech and the offline parser only | n/a | big **+** |
| Lifetime Pro (`duitful_pro` / Billplz licence) | **20 text actions + 3 scans a month** ("Pro taste") | 1st of each month, Malaysia time | Kira |
| Pro trial (14 days) | **full AI+ limits, capped at 100 actions + 10 scans** for the trial | once per device, ever | Kira |
| AI+ (any plan) | full AI+ quota (100 scans + 1,000 actions a month) | billing cycle | Kira |

Pro taste never lowers anything. A Pro user who also has AI+ gets AI+.

## Server (`api/ai.js`, `?op=`)

1. **Pro taste entitlement.**
   - **Request:** `op=status` and `op=run` accept the Pro licence the app already holds (the ECDSA P-256 token from `issue-license`, or the native store receipt that unlocked `duitful_pro`).
   - **Verify** it on the server with the existing public key. A token's `id` becomes the subject: `ai_pro:<licenceId>:<yyyymm>` counters in KV, TTL 40 days.
   - **Native Pro purchases:** use the same JWS / Play verification as AI+. The subject is the original transaction ID or the purchase token's order ID.
2. **Trial entitlement.**
   - The trial is opt-in on the phone (`startProTrial`) and can't be trusted on its own, because a reinstall restarts it.
   - The server issues a trial grant only after device attestation: **App Attest** on iOS, **Play Integrity** on Android.
   - The grant is keyed by a hash of the attested device ID: `ai_trial:<hash>` = `{ startedAt, scansUsed, textUsed }`, kept 400 days so a reinstall can't restart it.
   - The web has no attestation, so web trials get no cloud Kira. They use the on-device path only, and the UI says so plainly.
3. **`op=status`** returns `{ tier: "free" | "pro_taste" | "trial" | "aiplus", text: { used, limit }, scan: { used, limit }, resetsAt }` for the bubble's meter.
4. **At the cap**, the server answers `429 { reason: "quota", resetsAt }`. The app falls back quietly to on-device AI, then the rules, and never blocks logging.
5. **Privacy is unchanged:**
   - Logs hold no bodies, only counters.
   - The same task contract (section 6b of `ai-plus-handoff.md`).
   - The same redaction on the phone.

## App (Duitful 2.0)

- **Bubble:** Kira when `tier !== "free"`, the big **+** otherwise. The radial actions are the same for everyone.
- **Meter** on the Kira sheet: "Kira this month: 14 of 20 left · resets 1 Dec".
- **Trial, day 12:** Kira's recap of what it did ("38 spends logged, 6 receipts read, 3 split payments matched"), then the trial-end banner (`trialEndChanges`) names what changes for this user.
- **After the trial:**
  - **Pro** keeps the taste.
  - **AI+** keeps full Kira.
  - **Free** gets the **+** with on-device voice.
- **Prices:** every price comes from `proPriceLabel()` and the AI+ equivalent. Nothing is hard-coded.
