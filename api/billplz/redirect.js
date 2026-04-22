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
const { sendEmail, ownerNotifyAddress } = require("../_lib/email");

// Email the buyer their license. Resend sends From: receipts@duitful.app
// with Reply-To: hello@duitful.app so replies land in the main inbox.
// Falls back to { sent: false } when RESEND_API_KEY is unset so the
// post-payment page can stay honest about what actually went out.
async function sendLicenseEmail({ to, license, billId }) {
  const appBase = process.env.APP_BASE_URL || "https://duitful.app";
  return sendEmail({
    to,
    subject: "Your Duitful Pro license",
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#2a2420;background:#fffaf2;">
  <h2 style="font-family:Georgia,serif;font-weight:500;margin:0 0 12px;">Thanks for buying Duitful Pro</h2>
  <p style="line-height:1.55;">Here's your license key. Copy it and paste it into Duitful under <strong>Settings &rarr; Activate license</strong>.</p>
  <pre style="background:#fbf5ea;border:0.5px solid rgba(42,36,32,0.08);border-radius:10px;padding:12px;font:12px/1.5 ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap;word-break:break-all;">${license}</pre>
  <p style="line-height:1.55;">Open the app: <a href="${appBase}/app" style="color:#c8704b;">${appBase}/app</a></p>
  <p style="line-height:1.55;color:#6b5e52;font-size:13px;">Bill reference: <code>${billId}</code><br>Treat this key like a password — it activates Pro on any device.</p>
</div>`,
  });
}

// Notify the Duitful owner of a new paid sale. Best-effort — a failure
// here must never break the buyer-facing flow, so the caller awaits it
// but ignores a { sent: false } result.
async function sendOwnerSaleNotification({ bill }) {
  const to = ownerNotifyAddress();
  const amountRm = bill.amount != null ? (Number(bill.amount) / 100).toFixed(2) : "?";
  const ref = bill.reference_1 || bill.reference_2 || "—";
  const whenIso = new Date().toISOString();
  const subject = `Duitful Pro sale — RM ${amountRm} (${bill.email || "no email"})`;
  return sendEmail({
    to,
    subject,
    text: [
      "New Duitful Pro sale confirmed.",
      "",
      `Buyer:     ${bill.email || "(no email)"}`,
      `Name:      ${bill.name || "(no name)"}`,
      `Bill id:   ${bill.id}`,
      `Amount:    RM ${amountRm}`,
      `Reference: ${ref}`,
      `When:      ${whenIso}`,
    ].join("\n"),
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;color:#2a2420;">
  <h2 style="font:500 18px/1.2 Georgia,serif;margin:0 0 12px;">New Duitful Pro sale</h2>
  <table style="font-size:14px;line-height:1.5;border-collapse:collapse;">
    <tr><td style="color:#6b5e52;padding:2px 14px 2px 0;">Buyer</td><td>${escapeHtml(bill.email || "(no email)")}</td></tr>
    <tr><td style="color:#6b5e52;padding:2px 14px 2px 0;">Name</td><td>${escapeHtml(bill.name || "(no name)")}</td></tr>
    <tr><td style="color:#6b5e52;padding:2px 14px 2px 0;">Bill id</td><td><code>${escapeHtml(bill.id)}</code></td></tr>
    <tr><td style="color:#6b5e52;padding:2px 14px 2px 0;">Amount</td><td>RM ${escapeHtml(amountRm)}</td></tr>
    <tr><td style="color:#6b5e52;padding:2px 14px 2px 0;">Reference</td><td>${escapeHtml(String(ref))}</td></tr>
    <tr><td style="color:#6b5e52;padding:2px 14px 2px 0;">When</td><td>${escapeHtml(whenIso)}</td></tr>
  </table>
</div>`,
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderPage({ status, title, body, license, email, emailSent }) {
  const appBase = process.env.APP_BASE_URL || "https://duitful.app";
  const emailLine = emailSent
    ? `<p class="hint">We also emailed a copy to <strong>${escapeHtml(email || "your email")}</strong>.</p>`
    : `<p class="hint">Save this key somewhere safe — close this tab and you'll need to recover it from your Billplz bill receipt.</p>`;
  const licenseBlock = license
    ? `<div class="card">
         <h2>Your Duitful Pro license</h2>
         <p class="hint">Copy this key and paste it into Duitful under <strong>Settings → Activate license</strong>. Keep it safe — treat it like a password.</p>
         <textarea readonly id="lic">${escapeHtml(license)}</textarea>
         <div class="actions">
           <button onclick="copyLic()" class="primary">Copy license</button>
           <a href="${escapeHtml(appBase)}/app" class="btn-ghost">Open Duitful</a>
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
