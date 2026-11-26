// Task: voice-entry (v1, lite, text bucket) — Voice & natural-language entry (EN / BM / Manglish / ZH)
const { finiteAmount, amountInText, inList } = require("./helpers");

// Also accepts spoken-number sentences where the digits aren't literally written
// (e.g. "dua belas ringgit nasi lemak" -> 12). When digits appear in the
// sentence, the amount MUST match a printed digit in the sentence.
const HAS_DIGITS = /\d/;

module.exports = {
  name: "voice-entry",
  model: "lite",
  bucket: "text",
  timeoutMs: 12000,
  input: {
    sentence: { type: "string", required: true, max: 200 },
    categories: { type: "string[]", maxItems: 60, maxItemLen: 48 },
    wallets: { type: "string[]", maxItems: 40, maxItemLen: 60 },
    people: { type: "string[]", maxItems: 30, maxItemLen: 40 },
  },
  prompt(input) {
    return [
      "Parse a short Malaysian personal-expense voice/text sentence (English, Bahasa Melayu, Manglish, or Chinese) into JSON only.",
      "Rules: Only return an amount spoken by the user. Pick category/wallet/people ONLY from the allowed lists.",
      input.categories && input.categories.length ? `Categories: [${input.categories.join(", ")}]` : "",
      input.wallets && input.wallets.length ? `Wallets: [${input.wallets.join(", ")}]` : "",
      input.people && input.people.length ? `Open split people: [${input.people.join(", ")}]` : "",
      `Sentence: ${input.sentence}`,
    ].filter(Boolean).join("\n");
  },
  schema: {
    type: "object",
    properties: {
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
  },
  check(input, output) {
    if (!output || typeof output !== "object" || Array.isArray(output)) return null;
    const sentence = String(input.sentence || "");
    const out = {};

    if (output.amount !== undefined && output.amount !== null) {
      const amt = finiteAmount(output.amount);
      if (amt !== null) {
        if (!HAS_DIGITS.test(sentence) || amountInText(amt, sentence)) {
          out.amount = amt;
        }
      }
    }

    const cat = inList(output.category, input.categories || []);
    if (cat) out.category = cat;

    const wallet = inList(output.wallet, input.wallets || []);
    if (wallet) out.wallet = wallet;

    if (typeof output.note === "string") {
      const note = output.note.replace(/\s+/g, " ").trim().slice(0, 120);
      if (note) out.note = note;
    }

    if (output.split && typeof output.split === "object" && Array.isArray(output.split.people)) {
      const mode = output.split.mode === "exact" ? "exact" : "equal";
      const people = [];
      for (const p of output.split.people.slice(0, 10)) {
        if (!p || typeof p !== "object") continue;
        const name = inList(p.name, input.people || [])
          || (typeof p.name === "string" && sentence.toLowerCase().includes(p.name.trim().toLowerCase()) ? p.name.trim().slice(0, 40) : null);
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
      if (people.length) out.split = { mode, people };
    }

    return Object.keys(out).length ? out : null;
  },
};
