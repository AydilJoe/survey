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

module.exports = { sendEmail, ownerNotifyAddress };
