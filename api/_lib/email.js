// Resend transactional email helper.
//
// No-ops cleanly when RESEND_API_KEY is unset — callers get { sent: false }
// back and can render an honest "we didn't email you" UI rather than
// claiming delivery that never happened.
//
// Env vars:
//   RESEND_API_KEY          required to actually send
//   RESEND_FROM_EMAIL       default "Duitful <receipts@duitful.app>"
//   RESEND_REPLY_TO_EMAIL   default "hello@duitful.app"
//   OWNER_NOTIFY_EMAIL      where internal sale/ops notifications land;
//                           defaults to the Reply-To address

const DEFAULT_FROM = "Duitful <receipts@duitful.app>";
const DEFAULT_REPLY_TO = "hello@duitful.app";

async function sendEmail({ to, subject, html, text, from, replyTo, bcc }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: "RESEND_API_KEY not configured" };

  const body = {
    from: from || process.env.RESEND_FROM_EMAIL || DEFAULT_FROM,
    to: Array.isArray(to) ? to : [to],
    reply_to: replyTo || process.env.RESEND_REPLY_TO_EMAIL || DEFAULT_REPLY_TO,
    subject,
  };
  if (html) body.html = html;
  if (text) body.text = text;
  if (bcc) body.bcc = Array.isArray(bcc) ? bcc : [bcc];

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const detail = await r.text();
      console.warn("Resend send failed:", r.status, detail);
      return { sent: false, reason: `Resend ${r.status}` };
    }
    const json = await r.json().catch(() => ({}));
    return { sent: true, id: json.id };
  } catch (e) {
    console.warn("Resend send threw:", e);
    return { sent: false, reason: String(e.message || e) };
  }
}

function ownerNotifyAddress() {
  return (
    process.env.OWNER_NOTIFY_EMAIL ||
    process.env.RESEND_REPLY_TO_EMAIL ||
    DEFAULT_REPLY_TO
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Buyer receipt. `billId` is whatever identifies the purchase — the real
// Billplz bill id for a paid sale, or `comp-<CODE>-<uuid>` for a 100%-off
// comp issued without going through Billplz.
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

// Owner notify for a paid Billplz sale. Reads the discount code from
// reference_1 when its label is "Discount" so partial-discount sales
// surface which code was used.
async function sendOwnerSaleNotification({ bill }) {
  const to = ownerNotifyAddress();
  const amountRm = bill.amount != null ? (Number(bill.amount) / 100).toFixed(2) : "?";
  const ref1Label = bill.reference_1_label || "";
  const ref1 = bill.reference_1 || "";
  const ref2Label = bill.reference_2_label || "";
  const ref2 = bill.reference_2 || "";
  const discountCode = ref1Label === "Discount" ? ref1 : "";
  const referrer = ref2Label === "Referrer" ? ref2 : "";
  const whenIso = new Date().toISOString();
  const subject = discountCode
    ? `Duitful Pro sale — RM ${amountRm} via ${discountCode} (${bill.email || "no email"})`
    : `Duitful Pro sale — RM ${amountRm} (${bill.email || "no email"})`;

  const lines = [
    "New Duitful Pro sale confirmed.",
    "",
    `Buyer:     ${bill.email || "(no email)"}`,
    `Name:      ${bill.name || "(no name)"}`,
    `Bill id:   ${bill.id}`,
    `Amount:    RM ${amountRm}`,
  ];
  if (discountCode) lines.push(`Discount:  ${discountCode}`);
  else if (ref1) lines.push(`Product:   ${ref1}`);
  if (referrer) lines.push(`Referrer:  ${referrer}`);
  lines.push(`When:      ${whenIso}`);

  const rows = [
    ["Buyer", bill.email || "(no email)"],
    ["Name", bill.name || "(no name)"],
    ["Bill id", bill.id],
    ["Amount", `RM ${amountRm}`],
  ];
  if (discountCode) rows.push(["Discount", discountCode]);
  else if (ref1) rows.push(["Product", ref1]);
  if (referrer) rows.push(["Referrer", referrer]);
  rows.push(["When", whenIso]);

  return sendEmail({
    to,
    subject,
    text: lines.join("\n"),
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;color:#2a2420;">
  <h2 style="font:500 18px/1.2 Georgia,serif;margin:0 0 12px;">New Duitful Pro sale</h2>
  <table style="font-size:14px;line-height:1.5;border-collapse:collapse;">
    ${rows.map(([k, v]) => `<tr><td style="color:#6b5e52;padding:2px 14px 2px 0;">${escapeHtml(k)}</td><td>${k === "Bill id" || k === "Discount" || k === "Referrer" ? `<code>${escapeHtml(String(v))}</code>` : escapeHtml(String(v))}</td></tr>`).join("")}
  </table>
</div>`,
  });
}

// Owner notify for a 100%-off comp (no Billplz bill exists). Surfaces
// the coupon code in the subject so it's visible in the inbox preview.
async function sendOwnerCompNotification({ email, name, code, description, sub }) {
  const to = ownerNotifyAddress();
  const whenIso = new Date().toISOString();
  const subject = `Duitful Pro comp — ${code} (${email || "no email"})`;

  const lines = [
    "New Duitful Pro comp issued (100% off, no payment).",
    "",
    `Buyer:       ${email || "(no email)"}`,
    `Name:        ${name || "(no name)"}`,
    `Discount:    ${code}`,
    `Description: ${description || "(none)"}`,
    `License sub: ${sub}`,
    `When:        ${whenIso}`,
  ];

  const rows = [
    ["Buyer", email || "(no email)"],
    ["Name", name || "(no name)"],
    ["Discount", code],
    ["Description", description || "(none)"],
    ["License sub", sub],
    ["When", whenIso],
  ];

  return sendEmail({
    to,
    subject,
    text: lines.join("\n"),
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;color:#2a2420;">
  <h2 style="font:500 18px/1.2 Georgia,serif;margin:0 0 12px;">New Duitful Pro comp</h2>
  <p style="font-size:13px;color:#6b5e52;margin:0 0 12px;">100% off — no payment processed.</p>
  <table style="font-size:14px;line-height:1.5;border-collapse:collapse;">
    ${rows.map(([k, v]) => `<tr><td style="color:#6b5e52;padding:2px 14px 2px 0;">${escapeHtml(k)}</td><td>${k === "Discount" || k === "License sub" ? `<code>${escapeHtml(String(v))}</code>` : escapeHtml(String(v))}</td></tr>`).join("")}
  </table>
</div>`,
  });
}

module.exports = {
  sendEmail,
  ownerNotifyAddress,
  escapeHtml,
  sendLicenseEmail,
  sendOwnerSaleNotification,
  sendOwnerCompNotification,
};
