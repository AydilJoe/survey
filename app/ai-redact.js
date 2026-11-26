/* ---------- On-device redaction for Duitful AI+ (cloud) ----------
   Strips personally identifying data on the device before anything leaves for
   /api/ai?op=run. Reuses and extends redactAlertSample() from app/capture.js
   (never forks it).

   What is stripped:
     - 12-digit Malaysian NRIC / MyKad numbers (YYMMDD-PB-#### or 12 digits)
     - 10-19 digit bank account and card numbers (PANs), plus masked ****1234
     - Email addresses
     - Malaysian & international phone numbers
     - Malaysian street addresses (No./Lot + Jalan/Lorong/Taman/Persiaran/Lebuh
       and 5-digit postcodes)

   What is preserved so structured extraction & amount guards still work:
     - Printed currency amounts and decimal figures (e.g. RM 45.90, 1,200.00)
     - Dates (YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY)
     - Merchant / item names and closed enum lists (categories, wallets) */

// Malaysian NRIC: 6-digit DOB (YYMMDD) + 2-digit state code + 4 digits,
// with optional hyphens or spaces.
const AI_NRIC_RE = /\b\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[-\s]?\d{2}[-\s]?\d{4}\b/g;

// Bank account / card PAN: 10 to 19 digits, optionally grouped by spaces or hyphens.
const AI_PAN_RE = /\b(?:\d[ -]?){10,19}\b/g;

// Email addresses.
const AI_EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

// Malaysian mobile (+601x / 01x) and landline (+603..09 / 03..09) numbers.
const AI_PHONE_MY_RE = /(?:\+?6?0)(?:1\d[\s-]?\d{3,4}[\s-]?\d{4}|[3-9][\s-]?\d{3,4}[\s-]?\d{4})\b/g;

// Masked account/card numbers like ****1234, XXXX 5678, ••••9012.
const AI_MASKED_ACCT_RE = /[*xX•·]{2,}\s?\d{2,6}\b/g;

// Malaysian street address line fragments (e.g. "No. 12, Jalan Bukit Bintang, 55100 Kuala Lumpur").
const AI_ADDRESS_RE = /\b(?:No\.?\s*\d+[A-Za-z]?(?:-\d+)?,?\s*|Lot\s+\d+[A-Za-z]?,?\s*)?(?:Jalan|Jln\.?|Lorong|Lrg\.?|Persiaran|Lebuh|Lebuhraya|Taman|Tmn\.?|Bandar|Kampung|Kg\.?|Apt\.?|Blok|Block)\s+[A-Za-z0-9\s,./-]{3,80}(?:,?\s*\d{5}\s+[A-Za-z\s]{2,30})?/gi;

// Standalone 5-digit Malaysian postcode followed by a state/city word.
const AI_POSTCODE_RE = /\b\d{5}\s+(?:Kuala\s+Lumpur|Selangor|Penang|Pulau\s+Pinang|Johor|Johor\s+Bahru|Perak|Ipoh|Sabah|Kota\s+Kinabalu|Sarawak|Kuching|Melaka|Negeri\s+Sembilan|Seremban|Pahang|Kuantan|Kedah|Alor\s+Setar|Kelantan|Kota\s+Bharu|Terengganu|Perlis|Putrajaya|Labuan|Petaling\s+Jaya|Subang\s+Jaya|Shah\s+Alam|Cyberjaya|Puchong|Kajang|Ampang|Cheras|Klang)\b/gi;

function redactPiiText(text, opts) {
  const o = opts || {};
  let t = String(text || "");
  if (!t) return "";

  // Alert-sample mode reuses redactAlertSample() directly, then applies our
  // extra NRIC / PAN / street-address passes on top.
  if (o.mode === "alert" && typeof redactAlertSample === "function") {
    t = redactAlertSample(t);
  }

  // Protect currency amounts and ISO / slash dates while redacting long digit runs.
  const keep = [];
  const hold = (m) => { keep.push(m); return `\u0001${keep.length - 1}\u0001`; };

  t = t.replace(AI_EMAIL_RE, "[email]");
  t = t.replace(/(?:\bRM|\bMYR|S\$|\bSGD|\bUSD|\$|\bRp|\bIDR|฿|\bTHB|₱|\bPHP)\s?\d[\d,]*(?:\.\d{1,2})?/gi, hold);
  t = t.replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, hold);

  t = t.replace(AI_NRIC_RE, "[nric]");
  t = t.replace(AI_PHONE_MY_RE, "[phone]");
  t = t.replace(AI_MASKED_ACCT_RE, "[account]");
  t = t.replace(AI_PAN_RE, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 19 ? "[account]" : m;
  });
  t = t.replace(AI_ADDRESS_RE, "[address]");
  t = t.replace(AI_POSTCODE_RE, "[address]");

  return t.replace(/\u0001(\d+)\u0001/g, (_, i) => keep[Number(i)]);
}

// Redacts a task input payload on-device before calling /api/ai?op=run.
// Never mutates the caller's object.
function redactForCloudAi(input, task) {
  if (!input || typeof input !== "object") return input;
  const mode = task === "alert-read" ? "alert" : "cloud";
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === "image" || k === "imageMime") {
      out[k] = v;
    } else if (typeof v === "string") {
      out[k] = redactPiiText(v, { mode });
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) => {
        if (typeof item === "string") return redactPiiText(item, { mode });
        if (item && typeof item === "object") {
          const copy = {};
          for (const [ik, iv] of Object.entries(item)) {
            copy[ik] = typeof iv === "string" ? redactPiiText(iv, { mode }) : iv;
          }
          return copy;
        }
        return item;
      });
    } else {
      out[k] = v;
    }
  }
  return out;
}

if (typeof window !== "undefined") {
  window.redactPiiText = redactPiiText;
  window.redactForCloudAi = redactForCloudAi;
}
