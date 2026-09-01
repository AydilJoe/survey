# Verifying the privacy claims

Duitful's landing page makes four claims. Each one is a promise you should not
have to take on trust, so this page is the map: which file carries each claim,
and what to run to check it.

Everything below is a read of *this repository*, which is also the code the
live app serves — `app/script.js` is shipped unminified, so you can diff what
runs at `duitful.app` against what is here.

Budget about ten minutes.

```sh
git clone https://github.com/AydilJoe/survey.git duitful && cd duitful
```

---

## 1. "Your data is encrypted on your device"

**Where:** `app/script.js` — `deriveKey`, `encryptRecord`, `decryptRecord`, `save`

```sh
grep -n "PBKDF2\|AES-GCM\|iterations:" app/script.js | head
```

You should see a key derived with **PBKDF2, 250,000 iterations, SHA-256**,
producing a **256-bit AES-GCM** key, and a fresh 12-byte IV per write.

The important property is that the passcode is the *only* input to the key.
There is no second copy of it, no escrow, no recovery path — which is also why
losing the passcode loses the data, permanently.

**Then check where the vault is written:**

```sh
grep -n "localStorage.setItem(ENC_KEY" app/script.js
```

Every hit is a local write. There is no counterpart that sends `ENC_KEY`
anywhere; the next section is how you prove that rather than assert it.

---

## 2. "It never leaves your device"

This is the claim that matters most, and it is enforced by the browser rather
than by our good intentions.

**Where:** the `Content-Security-Policy` meta tag at the top of `app/index.html`

```sh
grep -o "connect-src [^;]*" app/index.html
```

`connect-src` is an allowlist of every host the app is *able* to reach. A
request to anything else fails at the browser, whatever the JavaScript says —
including any JavaScript a future contributor might add, and including
anything an attacker managed to inject. That is what makes it worth reading:

| Host | Why |
| --- | --- |
| `'self'`, `duitful.app` | the app's own files and the Pro-checkout endpoints |
| `googleapis.com`, `oauth2.googleapis.com`, `accounts.google.com` | Google Drive backup — **only** if you switch it on, and the file is encrypted before it is uploaded |
| `open.er-api.com` | exchange rates for multi-currency entries. Rates come *in*; nothing goes out |
| `va.vercel-scripts.com` | the install counter in section 4 |

There is no analytics host, no error-reporting host, and no server of ours
that could receive a vault even if the code tried to send one.

**Now read the policy itself, one directive per line:**

```sh
grep -o 'content="default-src[^"]*"' app/index.html \
  | sed 's/content="//; s/"$//' | tr ';' '\n' | sed 's/^ *//'
```

Two directives carry an `unsafe-*` value, and both deserve a straight answer
rather than silence:

- **`script-src` has `'wasm-unsafe-eval'`.** WebAssembly cannot be compiled
  without it, and the on-device OCR engine in section 3 is WebAssembly. It
  permits compiling wasm. It does not restore `eval()` and it does not permit
  inline scripts.
- **`style-src` has `'unsafe-inline'`.** That is stylesheets, not code. A style
  cannot make a network request or read your vault.

What `script-src` does **not** have is `'unsafe-inline'`. Inline `<script>`
blocks are refused outright — which is why the theme switch and the install
counter each live in their own file, and which is what stops a script smuggled
in through imported data from ever executing.

A word on grepping honestly: a naive count

```sh
grep -c "unsafe-inline\|unsafe-eval" app/index.html    # 3 lines
grep -o "unsafe-inline\|unsafe-eval" app/index.html | wc -l    # 4 matches
```

reports more than the policy actually contains. **Two** of those four are in
source comments that say the CSP has *no* `'unsafe-inline'`. Only two are real
policy values, and they are the two named above. Read the directives, not the
file.

---

## 3. "Receipt scanning happens on your device"

**Where:** `app/script.js` — `runReceiptOcr`, `pickOcrEngine`, `runMlKitOcr`

Two engines, both local:

- **Android and iOS:** Google's ML Kit text recogniser, running against an
  on-device model. Google receives nothing.
- **Web:** Tesseract.js, compiled to WebAssembly and **served from this repo**,
  not a CDN.

```sh
grep -n "vendor/tesseract" app/script.js | head -3
```

The path is relative. Nothing about a receipt — not the image, not the text —
is uploaded, and `connect-src` above means it could not be even if the code
wanted to.

**A related guarantee worth knowing about:** a debt's logo can be a picture you
attach, and an attached remote URL would phone home on every render. It is
rejected:

```sh
grep -n "remote image url is never accepted" tests/e2e.mjs
```

---

## 4. "No analytics on your financial data"

**Where:** `app/analytics.js` — the whole file is about 60 lines, so read it.

```sh
cat app/analytics.js
```

It counts one thing: that the app was opened from a home screen. It reports
nothing when running in a browser tab, nothing at all inside the Android and
iOS builds, exactly once per launch, and it carries no page path, no tap, and
no figure from your data.

Opt out for a browser entirely by visiting any Duitful page once with
`?noanalytics=1` on the end of the URL.

The full description, including what the marketing site records, is in
[section 4.7 of the privacy policy](https://duitful.app/privacy/#counting).

---

## 5. Don't take the walkthrough's word for it either

Some of the above is checked automatically on every change. The suite includes
a privacy audit that walks every screen and fails if a single ringgit figure is
still readable with amounts hidden, and a check that the brand catalogue makes
no network calls at all.

```sh
npm install
npm run test:e2e
```

539 checks at the time of writing, headless Chromium, starting from a blank
profile. The suite prints its own count, so trust that over this number.

---

## When you find something wrong

That is the point of publishing this. [`SECURITY.md`](SECURITY.md) has the
reporting route, what is in scope, and what is deliberately not defended.

And if a claim on the site cannot be traced to a file here, treat that as the
bug — tell us, and either the code or the claim will change.
