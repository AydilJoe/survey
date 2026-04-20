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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderPage({ status, title, body, license, email }) {
  const appBase = process.env.APP_BASE_URL || "https://duitful.app";
  const licenseBlock = license
    ? `<div class="card">
         <h2>Your Duitful Pro license</h2>
         <p class="hint">Copy this key and paste it into Duitful under <strong>Data → Activate license</strong>. Keep it safe — treat it like a password.</p>
         <textarea readonly id="lic">${escapeHtml(license)}</textarea>
         <div class="actions">
           <button onclick="copyLic()" class="primary">Copy license</button>
           <a href="${escapeHtml(appBase)}/app" class="btn-ghost">Open Duitful</a>
         </div>
         <p class="hint">We also sent a copy to <strong>${escapeHtml(email || "your email")}</strong>.</p>
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
  .${status} { border-left:3px solid ${status === "ok" ? "#5c986e" : "#b35a39"}; padding-left:0.8rem; }
</style>
</head>
<body>
<div class="wrap">
  <div class="${status}">
    <h1>${escapeHtml(title)}</h1>
    <p class="hint">${body}</p>
  </div>
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
</script>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  try {
    // Vercel provides parsed query at req.query.
    const raw = flattenBillplzParams(req.query);

    if (!verifyXSignature(raw)) {
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
      iat: Math.floor(Date.now() / 1000),
    });

    res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").end(
      renderPage({
        status: "ok",
        title: "Payment received — thank you!",
        body: "Duitful Pro is yours forever. Copy your license key below and paste it into the app to unlock.",
        license,
        email: bill.email,
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
