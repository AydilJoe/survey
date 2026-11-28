// Task: voice-entry (v2, text bucket) — Multi-item voice & natural-language entry (EN / BM / Manglish / ZH)
// Spec: docs/plans/voice-items-ai-plus.md
const { finiteAmount, amountInText, inList } = require("./helpers");

// Accepts spoken-number sentences only when no printed digits appear in the
// sentence (e.g. "dua belas ringgit nasi lemak" -> 12). When digits appear,
// every returned amount / split share MUST match a number in the sentence.
const HAS_DIGITS = /\d/;
const ALLOWED_KINDS = new Set(["spend", "income", "debt"]);
const MAX_ITEMS = 10;
const CLARIFY_FIELDS = new Set(["kind", "category", "wallet", "person"]);
const CLARIFY_QUESTION_MAX = 140;

// The optional follow-up about ONE kept item: a short question and 2-4
// replies, each from a closed list ("in" / "out", the categories, the wallets,
// the people sent or named in the sentence). `item` is re-pointed at the kept
// items; a question about a dropped item, or with a number the sentence never
// said, is dropped.
function checkClarify(raw, input, sentence, keptIndex) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const at = Number(raw.item);
  if (!Number.isInteger(at) || !keptIndex.has(at)) return null;
  const field = typeof raw.field === "string" ? raw.field.trim().toLowerCase() : "";
  if (!CLARIFY_FIELDS.has(field)) return null;
  const question = typeof raw.question === "string" ? raw.question.replace(/\s+/g, " ").trim() : "";
  if (!question || question.length > CLARIFY_QUESTION_MAX || /https?:|www\.|[<>]/i.test(question)) return null;
  const nums = question.match(/\d[\d,]*(?:\.\d{1,2})?/g) || [];
  if (nums.some((n) => !amountInText(Number(n.replace(/,/g, "")), sentence))) return null;
  if (!Array.isArray(raw.options)) return null;
  const options = [];
  for (const o of raw.options) {
    let v = null;
    if (field === "kind") {
      const k = typeof o === "string" ? o.trim().toLowerCase() : "";
      v = k === "in" || k === "income" ? "in" : (k === "out" || k === "spend" ? "out" : null);
    } else if (field === "category") {
      v = inList(o, input.categories || []);
    } else if (field === "wallet") {
      v = inList(o, input.wallets || []);
    } else {
      v = inList(o, input.people || [])
        || (typeof o === "string" && o.trim() && o.trim().length <= 40 && sentence.toLowerCase().includes(o.trim().toLowerCase()) ? o.trim() : null);
    }
    if (!v) return null;
    if (!options.includes(v)) options.push(v);
  }
  if (options.length < 2 || options.length > 4) return null;
  return { item: keptIndex.get(at), field, question, options };
}

// Every significant word of `note` must appear in `sentence` (case-insensitive
// for Latin/Malay words, direct inclusion for CJK characters) so the model
// never invents merchant/item names that were not spoken.
function noteWordsInSentence(rawNote, sentence) {
  if (typeof rawNote !== "string") return null;
  const clean = rawNote.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!clean) return null;
  const hayRaw = String(sentence || "").toLowerCase();
  const hayLatin = hayRaw.replace(/[^a-z0-9]/g, "");
  if (!hayRaw.trim()) return null;

  // Check CJK characters (if present in note) appear in sentence.
  const cjk = clean.match(/[\u4e00-\u9fff]/g) || [];
  if (cjk.length && !cjk.every((ch) => hayRaw.includes(ch))) return null;

  // Check Latin/alphanumeric words (>= 2 chars) appear in sentence.
  const latinWords = clean
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length >= 2);
  if (latinWords.length && !latinWords.every((w) => hayLatin.includes(w))) return null;

  if (!cjk.length && !latinWords.length) return null;
  return clean;
}

function checkSplit(rawSplit, input, sentence) {
  if (!rawSplit || typeof rawSplit !== "object" || !Array.isArray(rawSplit.people)) return null;
  const mode = rawSplit.mode === "exact" ? "exact" : "equal";
  const people = [];
  for (const p of rawSplit.people.slice(0, 10)) {
    if (!p || typeof p !== "object") continue;
    const name = inList(p.name, input.people || [])
      || (typeof p.name === "string" && p.name.trim() && sentence.toLowerCase().includes(p.name.trim().toLowerCase())
        ? p.name.trim().slice(0, 40)
        : null);
    if (!name) continue;
    const row = { name };
    if (p.share !== undefined && p.share !== null) {
      const sh = finiteAmount(p.share);
      if (sh !== null && (!HAS_DIGITS.test(sentence) || amountInText(sh, sentence))) {
        row.share = sh;
      }
    }
    people.push(row);
  }
  return people.length ? { mode, people } : null;
}

function checkItem(raw, input, sentence, allowMissingKind) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  let kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
  if (!kind && allowMissingKind) kind = "spend";
  if (!ALLOWED_KINDS.has(kind)) return null;

  const amt = raw.amount !== undefined && raw.amount !== null ? finiteAmount(raw.amount) : null;
  if (amt === null) return null;
  if (HAS_DIGITS.test(sentence) && !amountInText(amt, sentence)) return null;

  const item = { kind, amount: amt };
  const cat = inList(raw.category, input.categories || []);
  if (cat) item.category = cat;
  const wallet = inList(raw.wallet, input.wallets || []);
  if (wallet) item.wallet = wallet;
  const note = noteWordsInSentence(raw.note, sentence);
  if (note) item.note = note;
  const split = checkSplit(raw.split, input, sentence);
  if (split) item.split = split;
  return item;
}

const ITEM_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["spend", "income", "debt"] },
    amount: { type: "number" },
    category: { type: "string" },
    wallet: { type: "string" },
    note: { type: "string" },
    split: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["equal", "exact"] },
        people: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              share: { type: "number" },
            },
            required: ["name"],
          },
        },
      },
    },
  },
  required: ["kind", "amount"],
};

module.exports = {
  name: "voice-entry",
  model: "lite",
  bucket: "text",
  timeoutMs: 14000,
  input: {
    sentence: { type: "string", required: true, max: 400 },
    categories: { type: "string[]", maxItems: 60, maxItemLen: 48 },
    wallets: { type: "string[]", maxItems: 40, maxItemLen: 60 },
    people: { type: "string[]", maxItems: 30, maxItemLen: 40 },
  },
  prompt(input) {
    return [
      "Parse a Malaysian personal-finance voice/text sentence (English, Bahasa Melayu, Manglish, or Chinese) into JSON only: { items: [...] }.",
      "Rules:",
      "- Emit one item per money entry spoken by the user (at most 10 items). Never invent an item or amount.",
      "- kind: use \"income\" for money received (e.g. found, got, received, gaji, salary, bonus, freelance, freelancing, income, commission, allowance, elaun, jumpa duit, dapat duit); \"debt\" for paying a loan/card/PTPTN/hutang; \"spend\" for spending/buying/paying.",
      "- A split's own figure (e.g. \"split half with Ali\" or \"request RM 20 from Ali\") belongs inside that spend item's split object, NOT as a separate item.",
      "- Pick category and wallet ONLY from the allowed lists below. Pick split people from the list or a person's name explicitly spoken in the sentence.",
      "- note must contain ONLY short words spoken in the sentence (excluding the amount/currency).",
      "- clarify (optional): if exactly one thing about one item is unclear — money in or out, which category, which wallet, or which person — add clarify { item: <0-based index in items>, field: \"kind\" | \"category\" | \"wallet\" | \"person\", question: <one short question in the sentence's language>, options: 2 to 4 replies (\"in\" / \"out\" for kind; names from the lists for the others) }. Never ask about an amount. Omit clarify when nothing is unclear.",
      input.categories && input.categories.length ? `Categories: [${input.categories.join(", ")}]` : "",
      input.wallets && input.wallets.length ? `Wallets: [${input.wallets.join(", ")}]` : "",
      input.people && input.people.length ? `Open split people: [${input.people.join(", ")}]` : "",
      `Sentence: ${input.sentence}`,
    ].filter(Boolean).join("\n");
  },
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: ITEM_SCHEMA,
      },
      clarify: {
        type: "object",
        properties: {
          item: { type: "integer" },
          field: { type: "string", enum: ["kind", "category", "wallet", "person"] },
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["item", "field", "question", "options"],
      },
    },
    required: ["items"],
  },
  checkClarify,
  check(input, output) {
    if (!output || typeof output !== "object" || Array.isArray(output)) return null;
    const sentence = String(input.sentence || "");

    // v2 multi-item shape: { items: [...] }
    if (Array.isArray(output.items)) {
      const items = [];
      const keptIndex = new Map(); // raw index → kept index
      output.items.slice(0, MAX_ITEMS).forEach((raw, i) => {
        const clean = checkItem(raw, input, sentence, false);
        if (clean) { keptIndex.set(i, items.length); items.push(clean); }
      });
      if (!items.length) return null;
      const clarify = checkClarify(output.clarify, input, sentence, keptIndex);
      // Mirror single-item fields at top level for 1 release so older installed
      // phones reading res.amount/res.category/res.note/res.split keep working.
      const out = items.length === 1 ? { ...items[0], items } : { items };
      if (clarify) out.clarify = clarify;
      return out;
    }

    // Legacy v1 single-object shape (kept for 1 release).
    const out = {};
    if (output.kind !== undefined && output.kind !== null) {
      const k = typeof output.kind === "string" ? output.kind.trim().toLowerCase() : "";
      if (!ALLOWED_KINDS.has(k)) return null;
      out.kind = k;
    }
    if (output.amount !== undefined && output.amount !== null) {
      const amt = finiteAmount(output.amount);
      if (amt !== null && (!HAS_DIGITS.test(sentence) || amountInText(amt, sentence))) {
        out.amount = amt;
      }
    }
    const cat = inList(output.category, input.categories || []);
    if (cat) out.category = cat;
    const wallet = inList(output.wallet, input.wallets || []);
    if (wallet) out.wallet = wallet;
    const note = noteWordsInSentence(output.note, sentence);
    if (note) out.note = note;
    const split = checkSplit(output.split, input, sentence);
    if (split) out.split = split;

    if (!Object.keys(out).length) return null;
    if (out.amount !== undefined) {
      out.items = [{ kind: out.kind || "spend", amount: out.amount, ...(out.category ? { category: out.category } : {}), ...(out.wallet ? { wallet: out.wallet } : {}), ...(out.note ? { note: out.note } : {}), ...(out.split ? { split: out.split } : {}) }];
    }
    return out;
  },
};
