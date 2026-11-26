// Shared input-schema validation and output verification helpers for AI+ tasks.
// Every task check enforces Duitful's non-hallucination rules:
//   1. Amounts must appear in the input text / OCR text (or spoken words).
//   2. Closed-list values (category, wallet, kind, contract, etc.) must come
//      from the list sent in input.
//   3. Vendor/payee names must have their words appear in the input text.

const IMAGE_MAX_B64 = 1200000; // ~900 KB base64 (~<=1280px JPEG)

function validateInput(spec, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "input must be an object";
  }
  const allowed = new Set(Object.keys(spec));
  for (const k of Object.keys(input)) {
    if (!allowed.has(k)) return `unknown field: ${k}`;
  }
  for (const [k, rule] of Object.entries(spec)) {
    const v = input[k];
    if (v === undefined || v === null || v === "") {
      if (rule.required) return `missing required field: ${k}`;
      continue;
    }
    if (rule.type === "string") {
      if (typeof v !== "string") return `${k} must be a string`;
      if (rule.max && v.length > rule.max) return `${k} exceeds max length ${rule.max}`;
    } else if (rule.type === "number") {
      if (typeof v !== "number" || !Number.isFinite(v)) return `${k} must be a finite number`;
      if (rule.min !== undefined && v < rule.min) return `${k} below minimum`;
      if (rule.max !== undefined && v > rule.max) return `${k} above maximum`;
    } else if (rule.type === "string[]") {
      if (!Array.isArray(v)) return `${k} must be an array`;
      if (rule.maxItems && v.length > rule.maxItems) return `${k} exceeds max items ${rule.maxItems}`;
      for (const item of v) {
        if (typeof item !== "string" || (rule.maxItemLen && item.length > rule.maxItemLen)) {
          return `${k} contains invalid string item`;
        }
      }
    } else if (rule.type === "object[]") {
      if (!Array.isArray(v)) return `${k} must be an array`;
      if (rule.maxItems && v.length > rule.maxItems) return `${k} exceeds max items ${rule.maxItems}`;
      for (const item of v) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return `${k} contains invalid object item`;
        }
      }
    }
  }
  return null;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function finiteAmount(v) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) return null;
  return round2(n);
}

// Extracts all numeric values present in text (handles commas like 1,234.50 and
// Malaysian / decimal formats) and checks whether `amount` appears in `text`.
function amountInText(amount, text) {
  const target = finiteAmount(amount);
  if (target === null) return false;
  const raw = String(text || "");
  if (!raw) return false;
  const matches = raw.match(/\d[\d,]*(?:\.\d{1,2})?/g);
  if (!matches) return false;
  for (const m of matches) {
    const n = Number(m.replace(/,/g, ""));
    if (Number.isFinite(n) && Math.abs(n - target) < 0.005) return true;
  }
  return false;
}

function inList(value, list) {
  if (typeof value !== "string" || !Array.isArray(list)) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const exact = list.find((x) => x === trimmed);
  if (exact) return exact;
  const lower = trimmed.toLowerCase();
  return list.find((x) => String(x).toLowerCase() === lower) || null;
}

// Every significant word of `name` (alphanumeric >= 2 chars) must appear in `text`
// (case- and space-insensitive).
function wordsInText(name, text) {
  if (typeof name !== "string") return null;
  const clean = name.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const hay = String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!hay) return null;
  const words = clean.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, "")).filter((w) => w.length >= 2);
  if (!words.length) return null;
  return words.every((w) => hay.includes(w)) ? clean : null;
}

function validIsoDate(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : s;
}

module.exports = {
  IMAGE_MAX_B64,
  validateInput,
  round2,
  finiteAmount,
  amountInText,
  inList,
  wordsInText,
  validIsoDate,
};
