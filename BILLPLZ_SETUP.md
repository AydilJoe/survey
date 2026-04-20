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
```

### Generating the license signing keypair

Run once, locally (any laptop / Replit / web tool):

```bash
openssl ecparam -name prime256v1 -genkey -noout -out license-private.pem
openssl ec -in license-private.pem -pubout -out license-public.pem
```

- Paste `license-private.pem` contents into `LICENSE_SIGNING_PRIVATE_KEY` env var (Vercel)
- Embed `license-public.pem` contents into `app/script.js` as a constant
  (it's safe to be public — it can only verify, not sign)

## Cost per sale

| Method | Billplz fee | Net on RM 19.90 |
|---|---|---|
| FPX (online banking) | RM 0.60 + 0% | RM 19.30 |
| TNG / GrabPay / Boost | ~1.5% | RM ~19.60 |
| Credit card (Visa/MC) | 2.5% + RM 0.50 | RM ~18.90 |

You'll typically also get monthly settlement fee waived if you meet
the volume threshold — confirm in your dashboard.

## What I'll build once you have credentials

- `api/billplz/create-bill.js` — Vercel serverless function
- `api/billplz/redirect.js` — Vercel serverless function (post-payment landing)
- `api/billplz/webhook.js` — optional, for X-Signature verification
- `app/script.js` — Pro activation UI: license key paste field, ECDSA verify, store in encrypted state
- `app/index.html` — "Activate license" button in Data tab, MY payment button on the paywall
- `package.json` — pinned deps for the Vercel functions (just `node:crypto` natives, no extras needed)

## What you do this week

1. Sign up for Billplz Personal account on iPhone Safari (~10 min + ID docs)
2. Create the "Duitful Pro" collection
3. Generate the ECDSA keypair (or ask me to do it via a one-shot script)
4. Tell me when you have the API key + collection ID and I'll scaffold the code in one PR

Once it's wired and tested in sandbox, flipping to production is a single
env-var change.
