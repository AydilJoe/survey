# Billplz setup for Duitful Pro

End-to-end plan for accepting Malaysian FPX / TNG / GrabPay / Boost payments
for the RM 19.90 lifetime Pro tier.

## Architecture

```
1. User taps "Pay with FPX / TNG / GrabPay" inside Duitful
2. App POSTs to /api/billplz/create-bill  (Vercel function)
3. Function creates a Billplz bill, returns the hosted checkout URL
4. User opens the checkout URL, pays via FPX / e-wallet
5. Billplz redirects user to /api/billplz/redirect?billplz[id]=...
6. Function validates the bill is paid (server-side hit to Billplz API),
   then signs a license key (ECDSA P-256) and shows it on screen
7. User copies key -> opens Duitful -> Pro tab -> "Activate license" -> paste
8. App verifies the signature with the embedded public key -> isPro = true
   (stored in encrypted localStorage; no recurring server check)
```

No database needed. The license key itself proves payment because it's
cryptographically signed.

## What you need to sign up for

### 1. Billplz account
- Site: <https://www.billplz.com>
- iPhone path: Safari -> billplz.com -> Sign Up
- Two account types:
  - **Personal** — free, no SSM needed, can receive up to ~RM 10,000/yr (great for launch)
  - **Business** — needs SSM (sole prop ~RM 60 from `ezbiz.ssm.com.my`), no annual cap, lower fees on volume

Start with **Personal** — you can switch later without losing your collection.

You'll need to upload:
- IC (front + back, photo from Files app)
- Selfie holding IC (Billplz prompts you in-app)
- Bank account details (where settlements land — Maybank/CIMB/etc.)

Approval is usually 1–2 business days.

### 2. Create a Collection
- Dashboard -> Collections -> Create
- Name: `Duitful Pro`
- Description: `One-time lifetime unlock for Duitful — privacy-first money & debt tracker.`
- Logo: upload `app/icon.svg` exported as PNG (or skip — you can add later)

After creation you get a **Collection ID** like `inbmmepb`. Save it.

### 3. Grab API credentials
- Dashboard -> Settings -> Account Settings -> API Keys
- Copy:
  - **API Secret Key** (starts with a long base64-ish string)
  - **X-Signature key** (for verifying webhook callbacks)

### 4. Sandbox vs Production
Billplz gives you both. Use **sandbox** while we wire the code:
- Sandbox dashboard: <https://www.billplz-sandbox.com>
- Same signup, no real payments, fake bank login on FPX
- Once it works end-to-end, swap the API URLs from `billplz-sandbox.com` -> `billplz.com` and update env vars

## Env vars to set in Vercel

After Billplz signup, add these in Vercel -> Project -> Settings -> Environment Variables:

```
BILLPLZ_API_KEY            = <secret API key>
BILLPLZ_COLLECTION_ID      = <e.g. inbmmepb>
BILLPLZ_X_SIGNATURE        = <X-signature key>
BILLPLZ_BASE_URL           = https://www.billplz-sandbox.com/api/v3   (or billplz.com when live)
LICENSE_SIGNING_PRIVATE_KEY = <ECDSA P-256 PEM, generated below>
LICENSE_SIGNING_PUBLIC_KEY  = <matching public key, also embedded in app/script.js>
APP_BASE_URL                = https://duitful.app
ADMIN_KEY                   = <random hex from /tools/issue/ keygen>

# Optional — if set, the redirect handler emails the license to the buyer
# and pings you of every sale. See EMAIL_SETUP.md for the DNS + Cloudflare
# Email Routing walkthrough. Without these the page just shows the key for
# the user to copy.
RESEND_API_KEY              = <from resend.com (free tier: 3000/mo)>
RESEND_FROM_EMAIL           = "Duitful <receipts@duitful.app>"
RESEND_REPLY_TO_EMAIL       = hello@duitful.app
OWNER_NOTIFY_EMAIL          = hello@duitful.app
```

### Email delivery

See [`EMAIL_SETUP.md`](./EMAIL_SETUP.md) for the full Resend + Cloudflare
Email Routing setup. Short version: sign up at resend.com, paste the DKIM
records into Cloudflare DNS, set the env vars above, redeploy.

Without `RESEND_API_KEY`, the redirect page is honest about it — shows
"Save this key somewhere safe — close this tab and you'll need to recover
it" instead of claiming an email was sent.

### Generating the license signing keypair

**Browser-based keygen** — no terminal needed. Once this branch is merged:

1. Open `https://duitful.app/tools/keygen/` on any device
2. Tap **Generate new keypair**
3. Copy the **private key** (the scary one) → Vercel → Project → Settings → Environment Variables → add `LICENSE_SIGNING_PRIVATE_KEY`
4. Copy the **public key** → paste into chat, I'll commit it to `app/script.js` so the app can verify licenses offline
5. Close the tab (nothing is saved server-side; regenerating would invalidate every license already issued)

Alternative if you're on a laptop and prefer CLI:
```bash
openssl ecparam -name prime256v1 -genkey -noout -out license-private.pem
openssl ec -in license-private.pem -pubout -out license-public.pem
```

## Cost per sale

| Method | Billplz fee | Net on RM 19.90 |
|---|---|---|
| FPX (online banking) | RM 0.60 + 0% | RM 19.30 |
| TNG / GrabPay / Boost | ~1.5% | RM ~19.60 |
| Credit card (Visa/MC) | 2.5% + RM 0.50 | RM ~18.90 |

You'll typically also get monthly settlement fee waived if you meet
the volume threshold — confirm in your dashboard.

## What's scaffolded already

| File | Purpose |
|---|---|
| `tools/keygen/index.html` | In-browser ECDSA keypair generator. Visit once, paste keys into Vercel + chat, close tab. |
| `api/_lib/billplz.js` | Thin v3 wrapper: createBill, getBill, X-Signature verification, param flattener. |
| `api/_lib/license.js` | `signLicense(payload)` — ECDSA-signs a compact `payload.sig` token using Node's builtin `crypto`. |
| `api/billplz/create-bill.js` | POST with `{ email }` → returns `{ url, id }` to redirect the buyer to. |
| `api/billplz/redirect.js` | GET — post-payment landing: verifies signature, re-checks bill status, issues + displays license key. |
| `api/billplz/webhook.js` | POST — Billplz s2s callback, verifies signature, logs the payment. |

All functions use **only Node builtins** (`fetch`, `crypto`, `Buffer`) so Vercel
doesn't need `npm install` (installCommand stays `null`).

## Still to build

- `app/script.js` — license verify helper (Web Crypto ECDSA), activation dialog, `isPro()` flip based on a verified license
- `app/index.html` — "Activate license" button in the Data tab, "Pay with FPX" button next to the existing paywall-buy button

Both of those need the real **public key** before they're useful, so I'll commit
them once you've run the keygen.

## What you do once SSM is verified

1. Confirm Billplz Business account is live
2. Create the "Duitful Pro" collection, copy the **Collection ID**
3. Settings → Account Settings → copy **API Secret Key** and **X-Signature**
4. On iPhone, open `https://duitful.app/tools/keygen/` → generate → copy both keys
5. Vercel → Project → Settings → Environment Variables → add:
   - `BILLPLZ_API_KEY`
   - `BILLPLZ_COLLECTION_ID`
   - `BILLPLZ_X_SIGNATURE`
   - `BILLPLZ_BASE_URL` = `https://www.billplz-sandbox.com/api/v3` (start with sandbox)
   - `LICENSE_SIGNING_PRIVATE_KEY` = (the PEM private key from keygen)
   - `APP_BASE_URL` = `https://duitful.app`
6. Paste the **public key** back to me → I commit it to `app/script.js` and finish the activation UI
7. Test in sandbox with a fake FPX payment → once working, flip `BILLPLZ_BASE_URL` to `https://www.billplz.com/api/v3` and you're live
