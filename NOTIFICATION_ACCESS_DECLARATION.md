# Notification Access — Play Permissions Declaration Template

Use this wording when filling out the Permissions Declaration form in
Google Play Console for `BIND_NOTIFICATION_LISTENER_SERVICE`.

> **Why this document exists:** Google Play's policy on notification
> listener access has been progressively tightened. Apps are not
> auto-approved — Play requires a written declaration explaining why
> the access is needed, what data is read, where the data goes, and
> what happens if the user revokes access. Submitting weak justification
> language is the most common cause of rejection. The wording below has
> been written to lead with the strongest privacy framing first.

When Play asks each question in the form, copy the matching block below
verbatim (or paraphrase to fit the field's character limit).

---

## Question: Why does your app need access to notifications?

**Answer:**

Duitful is a privacy-first personal finance tracker. It auto-captures
the user's own bank, e-wallet, and BNPL transaction notifications so
that users do not have to manually re-enter every credit card swipe,
bank transfer, or e-wallet payment. Without notification access,
Duitful still works — users simply enter every transaction by hand.
With notification access, it works seamlessly.

We require this access because Southeast Asian banks and e-wallets
(our user base) deliver real-time transaction confirmations primarily
through the Android notification system. SMS-based alerts are largely
deprecated in this region, and most consumer banking apps do not
expose a public account API for third parties.

---

## Question: Is notification access a core feature of your app?

**Answer:** Yes. Auto-capture of transactions is one of the headline
features marketed in the app listing and the user opts in to it
explicitly via Settings → Pending transactions → "Enable auto-capture".

The app does ship with a fully functional manual-entry path; auto-capture
is a workflow accelerator, not the only way to use the app. But
auto-capture is the differentiated feature that makes Duitful preferable
to a generic spreadsheet for our users.

---

## Question: How does your app process notification data?

**Answer:**

All processing is on-device. The flow is:

1. The user's device receives a notification from a whitelisted bank
   or e-wallet app (e.g. Maybank, DBS, BCA, GCash, MoMo).
2. Duitful's `NotificationListenerService` filters by package name
   first — only notifications from the app's pre-defined whitelist of
   bank/e-wallet/BNPL packages reach the parser. All other apps'
   notifications (messaging, social, news, system) are ignored
   immediately at the package check.
3. The notification text is parsed locally with regular expressions
   against a per-bank pattern list (e.g. `"RM 50.00 charged at STARBUCKS"`
   becomes amount=50.00, merchant=STARBUCKS, currency=MYR).
4. A promotional deny-list filters out marketing notifications
   (rewards, cashback offers, points, "limited-time" promos, etc.) so
   they do not generate fake transactions.
5. Successfully parsed transactions are stored in **encrypted local
   storage on the device** (AES-GCM 256-bit, key derived via PBKDF2
   from the user's locally-set passcode). The user is then prompted in
   the app to review and confirm the transaction before it is added to
   their finances.
6. **Notification text is never transmitted to any server.** Duitful
   has no server-side database of user transactions. The only network
   calls the app makes are to its own API for the optional one-time Pro
   purchase flow — which is unrelated to notification access.

---

## Question: Is notification data shared with third parties?

**Answer:** No. The app has no analytics SDK, no third-party telemetry,
and no server-side transaction storage. Notification text is parsed
on-device, presented to the user for review, stored on-device in
encrypted form, and never leaves the device.

---

## Question: How does the user opt in to notification access?

**Answer:**

The user explicitly opts in via a multi-step flow:

1. Settings → Pending transactions in the app.
2. Tap "Enable auto-capture".
3. The app surfaces an explanation screen describing what notification
   access enables, what the app will and will not read, and that the
   feature is fully optional.
4. Tap "Open Notification access settings".
5. Android's system Notification access screen opens.
6. The user must manually toggle Duitful ON.

Until step 6 completes, the listener service exists but receives no
notifications. The app cannot enable notification access on the user's
behalf.

---

## Question: Can the user revoke notification access?

**Answer:** Yes, at any time, via the same Android system screen
(Settings → Apps → Special app access → Notification access → Duitful
→ off). The listener service immediately stops receiving notifications.
The app continues to function; the user reverts to manual transaction
entry. No data is lost.

---

## Question: What alternatives did you consider?

**Answer:**

- **SMS reading (`READ_SMS`):** Most modern Asian consumer banks have
  moved primary alert delivery to push notifications, with SMS used
  only for OTPs and specific edge cases. SMS reading is also
  considerably more privacy-invasive than notification listening
  because SMS contains private conversations.
- **Direct bank API integration:** Most consumer banking accounts in
  the markets we serve (MY, SG, ID, TH, PH, VN) do not expose
  third-party APIs for transaction reads. Where Open Banking exists
  (e.g. Singapore SGFinDex), it is enterprise-only with no consumer
  end-user app pathway.
- **Email parsing:** Would require email account access — a far
  broader privacy ask than notification access.
- **Manual entry only:** This is the fallback we ship; auto-capture
  is layered on top as a convenience.

Notification access is the most narrowly-scoped solution that delivers
the auto-capture feature.

---

## Question: Privacy policy URL

**Answer:** `https://duitful.app/privacy`

The privacy policy page covers notification access in plain language
under the "Auto-capture from notifications" section. The same disclosure
is also surfaced in-app at the opt-in screen, before the user grants
access.

---

## Question: Data minimisation

**Answer:**

The notification listener applies a package-name whitelist before
reading any text. Only the following types of packages are read (full
list is hard-coded in the app source):

- Bank apps from Malaysia (Maybank, CIMB, Hong Leong, RHB, Public Bank,
  AmBank, Bank Islam, BSN), Singapore (DBS, OCBC, UOB), Indonesia (BCA,
  Mandiri, BNI, BRI), Thailand (KBank, SCB, Krungthai, BBL, Krungsri,
  ttb), Philippines (BDO, BPI, Metrobank), Vietnam (Vietcombank,
  VietinBank, Techcombank, BIDV, MB).
- E-wallets and BNPL: TNG, Boost, BigPay, Setel, GrabPay, ShopeePay,
  Atome, MAE, GoPay, OVO, DANA, TrueMoney, Rabbit LINE Pay, GCash,
  Maya, MoMo, ZaloPay, and regional ShopeePay variants.

Notifications from any package outside this whitelist are dropped at
the listener boundary. No text is read, parsed, or stored.

The whitelist is updated only as part of an app update; the user can
inspect the current whitelist at any time by reading the app source on
GitHub.

---

## Format-specific notes

The Permissions Declaration form has fields with character limits
(typically 500–1000 chars per field). Adapt the answers above:

- For very short fields (≤200 chars): use the lead sentence of each
  answer plus the keyword "on-device" or "encrypted".
- For longer fields: paste the full answer.
- If Play asks for screenshots: upload (a) the in-app explanation
  screen at the opt-in flow, (b) the system Notification access screen,
  (c) the in-app pending transaction review screen.
