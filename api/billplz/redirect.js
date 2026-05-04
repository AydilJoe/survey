// Post-payment landing page. Billplz redirects buyers here with their
// bill id in the query string. We:
//   1. Verify the X-Signature Billplz signed the redirect with.
//   2. Re-fetch the bill from Billplz server-side (can't trust query params).
//   3. If paid, sign a license token and render it on an HTML page with
//      a copy button and a link back into the app.
//
// No DB; the license itself is the proof of purchase.

const { getBill, verifyXSignature, flattenBillplzParams } = require("../_lib/billplz");
const { signLicense } = require("../_lib/license");
const { refCodeFor } = require("../_lib/referral");
const { sendLicenseEmail, sendOwnerSaleNotification, escapeHtml } = require("../_lib/email");

// Safe JSON for embedding inside a <script> tag. JSON.stringify alone
// doesn't escape '<' (so a value containing "</script>" could break
// out of script context) or U+2028 / U+2029 (which are valid in JSON
// strings but illegal in JS string literals). Belt-and-suspenders for
// our license token (which is base64url-only, but defence in depth
// doesn't hurt). Built via RegExp(string) to avoid putting raw U+2028
// in the source (which would terminate the regex literal).
const UNSAFE_SCRIPT_CHARS = new RegExp("[<>&\\u2028\\u2029]", "g");
function jsonForScript(value) {
  return JSON.stringify(value).replace(UNSAFE_SCRIPT_CHARS, function (c) {
    return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

function renderPage({ status, title, body, license, email, emailSent }) {
  const appBase = process.env.APP_BASE_URL || "https://duitful.app";
  const emailLine = emailSent
    ? `<p class="hint">We also emailed a copy to <strong>${escapeHtml(email || "your email")}</strong>.</p>`
    : `<p class="hint">Save this key somewhere safe — close this tab and you'll need to recover it from your Billplz bill receipt.</p>`;
  // When we have a license, we hand it to /app via sessionStorage and
  // auto-redirect — the app activates Pro on load. The license is still
  // shown as a backup for activating Pro on other devices.
  const autoOpenBlock = license
    ? `<div class="card">
         <h2>Pro unlocked — opening Duitful…</h2>
         <p class="hint">Opening in <span id="cd">3</span>s and Pro will activate automatically. <button id="stay" class="link">Stay on this page</button></p>
       </div>`
    : "";
  const licenseBlock = license
    ? `<div class="card">
         <h2>Your Duitful Pro license <span class="badge">backup</span></h2>
         <p class="hint">Save this key to activate Pro on other devices. Treat it like a password.</p>
         <textarea readonly id="lic">${escapeHtml(license)}</textarea>
         <div class="actions">
           <button onclick="copyLic()" class="primary">Copy license</button>
           <a href="${escapeHtml(appBase)}/app" class="btn-ghost">Open Duitful now</a>
         </div>
         ${emailLine}
       </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} — Duitful</title>
<style>
  :root { --bg:#efe6d6; --ink:#2a2420; --muted:#6b5e52; --primary:#c8704b; --card:#fffaf2; --line:rgba(42,36,32,0.08); }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--ink); min-height:100dvh; padding:1.2rem; }
  .wrap { max-width:640px; margin:0 auto; }
  h1 { font:500 1.8rem/1.2 "Fraunces", "Georgia", serif; margin:0.4rem 0 0.2rem; }
  .hint { color:var(--muted); font-size:0.92rem; }
  .card { background:var(--card); border:0.5px solid var(--line); border-radius:16px; padding:1rem 1.1rem; margin:1rem 0; }
  .card h2 { margin:0 0 0.4rem; font:500 1.05rem/1.25 "Fraunces", serif; }
  textarea { width:100%; min-height:110px; font:12px/1.45 ui-monospace, SFMono-Regular, monospace; border:0.5px solid var(--line); border-radius:10px; padding:0.6rem 0.7rem; background:#fbf5ea; color:var(--ink); resize:vertical; }
  .actions { display:flex; gap:0.5rem; margin-top:0.7rem; flex-wrap:wrap; }
  .actions .primary, .actions a.btn-ghost { padding:0.7rem 1.1rem; border-radius:12px; font:500 0.95rem/1 inherit; border:0.5px solid transparent; cursor:pointer; text-decoration:none; text-align:center; display:inline-flex; align-items:center; justify-content:center; }
  .primary { background:var(--primary); color:#fffaf2; border-color:var(--primary); }
  .btn-ghost { background:transparent; color:var(--ink); border-color:var(--line); }
  .link { background:none; border:0; padding:0; color:var(--primary); text-decoration:underline; cursor:pointer; font:inherit; }
  .badge { display:inline-block; background:#fbf5ea; color:var(--muted); font:500 0.7rem/1 inherit; border:0.5px solid var(--line); border-radius:999px; padding:3px 8px; vertical-align:middle; margin-left:0.4rem; text-transform:uppercase; letter-spacing:0.04em; }
  .${status} { border-left:3px solid ${status === "ok" ? "#5c986e" : "#b35a39"}; padding-left:0.8rem; }
</style>
</head>
<body>
<div class="wrap">
  <div class="${status}">
    <h1>${escapeHtml(title)}</h1>
    <p class="hint">${body}</p>
  </div>
  ${autoOpenBlock}
  ${licenseBlock}
</div>
<script>
function copyLic() {
  var ta = document.getElementById("lic");
  ta.select();
  navigator.clipboard?.writeText(ta.value).catch(() => document.execCommand("copy"));
  var b = document.querySelector(".primary");
  var t = b.textContent;
  b.textContent = "Copied ✓";
  setTimeout(function(){ b.textContent = t; }, 1500);
}
${license ? `(function(){
  // Hand the license to /app via sessionStorage (same origin) so the
  // app self-activates Pro on load. Backup paste flow stays available
  // for activating Pro on other devices.
  try {
    sessionStorage.setItem("__pendingLicense__", ${jsonForScript(license)});
  } catch (e) { /* private mode etc — backup paste still works */ }
  var APP_URL = ${jsonForScript(appBase + "/app")};
  var seconds = 3;
  var cdEl = document.getElementById("cd");
  var stayBtn = document.getElementById("stay");
  var cancelled = false;
  var timer = setInterval(function () {
    if (cancelled) return;
    seconds -= 1;
    if (seconds <= 0) {
      clearInterval(timer);
      window.location.href = APP_URL;
      return;
    }
    if (cdEl) cdEl.textContent = String(seconds);
  }, 1000);
  if (stayBtn) {
    stayBtn.addEventListener("click", function () {
      cancelled = true;
      clearInterval(timer);
      var card = stayBtn.closest(".card");
      if (card) card.querySelector(".hint").textContent = "Auto-open cancelled. Use the buttons below when you're ready.";
    });
  }
})();` : ""}
</script>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  try {
    // Vercel provides parsed query at req.query.
    const raw = flattenBillplzParams(req.query);
    // Log the params we received so we can compare against what Billplz
    // sent (visible in Vercel -> Functions -> redirect -> Logs).
    console.log("billplz redirect params:", raw);

    if (!verifyXSignature(raw, { keyPrefix: "billplz" })) {
      res.status(400).setHeader("Content-Type", "text/html; charset=utf-8").end(
        renderPage({
          status: "err",
          title: "Signature mismatch",
          body: "We couldn't verify this payment redirect came from Billplz. No license issued. If you just paid, please contact support with your bill reference.",
        })
      );
      return;
    }

    const bill = await getBill(raw.id);
    if (!bill || bill.state !== "paid") {
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").end(
        renderPage({
          status: "err",
          title: "Payment not confirmed yet",
          body: "Billplz hasn't marked this bill as paid. If you completed the payment, please refresh in a minute or contact support.",
        })
      );
      return;
    }

    const license = signLicense({
      sub: bill.id,
      email: bill.email,
      product: "duitful_pro",
      ref: refCodeFor(bill.email),
      iat: Math.floor(Date.now() / 1000),
    });

    const [mail] = await Promise.all([
      bill.email ? sendLicenseEmail({ to: bill.email, license, billId: bill.id }) : Promise.resolve({ sent: false }),
      sendOwnerSaleNotification({ bill }).catch((e) => {
        console.warn("owner notification threw:", e);
        return { sent: false };
      }),
    ]);

    res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").end(
      renderPage({
        status: "ok",
        title: "Payment received — thank you!",
        body: "Duitful Pro is yours forever. Copy your license key below and paste it into the app to unlock.",
        license,
        email: bill.email,
        emailSent: mail.sent,
      })
    );
  } catch (err) {
    console.error("redirect handler failed:", err);
    res.status(500).setHeader("Content-Type", "text/html; charset=utf-8").end(
      renderPage({
        status: "err",
        title: "Something went wrong",
        body: "Your payment may still be successful — please contact support with your bill reference if Pro isn't unlocked within 10 minutes.",
      })
    );
  }
};
