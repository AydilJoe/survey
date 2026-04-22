# Email setup for duitful.app

Two separate concerns, one DNS zone:

| Concern | Direction | Tool | Address |
| --- | --- | --- | --- |
| People emailing you | **Inbound** | Cloudflare Email Routing (free) | `hello@duitful.app` |
| Duitful emailing people | **Outbound** | Resend | `receipts@duitful.app` (Reply-To `hello@duitful.app`) |

Resend does **not** receive mail. Cloudflare Email Routing does **not** send transactional mail as your domain. Keep both — they don't conflict because inbound uses `MX`, outbound uses `TXT` / `CNAME`.

---

## 1 · Receive mail at hello@duitful.app (Cloudflare Email Routing)

Free. Forwards `hello@duitful.app` to an existing personal inbox (Gmail / iCloud / whatever).

1. Make sure `duitful.app`'s nameservers point to Cloudflare. At your registrar, set them to the two Cloudflare gives you under **Websites → duitful.app → DNS → Records** (top of the page).
2. In Cloudflare → **duitful.app → Email → Email Routing → Get started**.
3. **Destination addresses** → add your personal email → click the verification link Cloudflare emails you.
4. **Routes → Create address** → `hello@duitful.app` → forward to your personal email.
5. Enable. Cloudflare auto-adds the MX and SPF records below. You don't paste these by hand — they're listed here so you can verify them in `Cloudflare → DNS → Records`.

```
MX   @   10  route1.mx.cloudflare.net
MX   @   30  route2.mx.cloudflare.net
MX   @   40  route3.mx.cloudflare.net
TXT  @   "v=spf1 include:_spf.mx.cloudflare.net ~all"
```

**Test:** from a different account, email `hello@duitful.app`. Should land in your personal inbox in a few seconds. If it bounces, check Cloudflare Email Routing → **Activity** for the failure reason.

Later, you can add `aydil@duitful.app`, `support@duitful.app`, etc. as routes without touching DNS again.

---

## 2 · Send transactional mail via Resend

Receipts (license delivery) and owner notifications (new-sale alerts) go out through Resend. The code is already wired — you just need the account + DNS + env vars.

### 2a · Sign up and verify the domain

1. Sign up at <https://resend.com> (free tier: 3000 emails/month, 100/day).
2. Resend dashboard → **Domains → Add domain** → `duitful.app` → choose the region closest to your users (e.g. `ap-northeast-1` Tokyo for Malaysia).
3. Resend will show a set of DNS records. **Don't close this tab.** They look like:

```
TXT    send._domainkey    p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCB... (long)
TXT    resend._domainkey  p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCB... (long)
TXT    @                  v=spf1 include:amazonses.com ~all
MX     send               10 feedback-smtp.<region>.amazonses.com
TXT    send               v=spf1 include:amazonses.com ~all
```

The exact names (`send`, `resend._domainkey`) and values come from Resend — **copy them from the dashboard, not from this doc.**

### 2b · Paste the records into Cloudflare

Cloudflare → **duitful.app → DNS → Records → Add record** — one per Resend row.

Watch out for these:

- **Proxy status = DNS only (grey cloud)** for every record. Orange cloud breaks email.
- The apex `TXT @ v=spf1 include:amazonses.com ~all` **must not conflict** with the Cloudflare Email Routing SPF record. If a `TXT @ v=spf1 ...` already exists, **merge** them into one record:

  ```
  v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all
  ```

  Only one `v=spf1` record is allowed at the apex. Cloudflare will accept two and silently break auth.
- TTL: `Auto` is fine.

### 2c · Verify in Resend

Back in Resend → **Domains → duitful.app → Verify**. Usually green within 1–5 minutes. If it stays "pending" after 10 minutes, re-open your records in Cloudflare and confirm the `TXT` values match exactly (one stray space kills DKIM).

### 2d · (Optional but recommended) DMARC

Once Resend is verified, add this in Cloudflare → DNS:

```
TXT   _dmarc   v=DMARC1; p=none; rua=mailto:hello@duitful.app; fo=1
```

`p=none` just asks receiving mailservers to report auth failures to you (without blocking anything) so you learn if mail is being spoofed. After a week of clean reports, upgrade to `p=quarantine`.

### 2e · Create an API key

Resend → **API Keys → Create API Key** → name it `duitful-prod` → **Sending access** → scope to `duitful.app` only → copy the key (starts with `re_`). You won't see it again.

### 2f · Env vars in Vercel

`Project → Settings → Environment Variables` (add for **Production** and **Preview**):

```
RESEND_API_KEY          = re_...               (from 2e)
RESEND_FROM_EMAIL       = Duitful <receipts@duitful.app>
RESEND_REPLY_TO_EMAIL   = hello@duitful.app
OWNER_NOTIFY_EMAIL      = hello@duitful.app    (optional — defaults to Reply-To)
```

Redeploy (or push any commit to main). Next successful Billplz payment will:

- Email the buyer their license key from `receipts@duitful.app`.
- Email you a one-line sale notification at `hello@duitful.app` (which Cloudflare forwards to your personal inbox).

### 2g · Test without a real payment

Easiest: in sandbox mode, complete a fake FPX payment. Check:

- Vercel → **Functions → redirect → Logs** for `Resend email failed:` warnings.
- Resend → **Emails** for the send record (status `Delivered`, `Bounced`, etc.).
- Your personal inbox for the owner notification.

If Resend says `403 domain is not verified`, the DNS hasn't propagated yet or a TXT record is wrong.

---

## What lives where

| File | Role |
| --- | --- |
| `api/_lib/email.js` | `sendEmail({...})` — Resend wrapper, no-ops when `RESEND_API_KEY` is unset. |
| `api/billplz/redirect.js` | Calls `sendLicenseEmail` (buyer) and `sendOwnerSaleNotification` (you) on confirmed payment. |
| `contact/index.html` | Public `/contact/` page with prefilled `mailto:hello@duitful.app` options. |

---

## Troubleshooting

- **Resend verification stuck on pending** — check `dig TXT resend._domainkey.duitful.app` resolves to the value shown in Resend. Wait 10 minutes after editing DNS.
- **SPF failure on delivered mail** — you likely have two `v=spf1 @` records. Merge into one with both `include:` directives.
- **Cloudflare Email Routing says "verified" but mail never arrives** — check your personal inbox's spam folder and Cloudflare → Email Routing → **Activity** for rejected messages.
- **Owner notifications not arriving** — they send From: `receipts@duitful.app` to `hello@duitful.app`. If your personal inbox has aggressive filters on "own domain" mail, add a rule to trust `receipts@duitful.app`.
