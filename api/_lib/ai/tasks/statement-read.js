// Task: statement-read (v1, vision, scan bucket)
const { IMAGE_MAX_B64, finiteAmount, amountInText, validIsoDate } = require("./helpers");

module.exports = {
  name: "statement-read",
  model: "vision",
  bucket: "scan",
  timeoutMs: 35000,
  input: {
    image: { type: "string", max: IMAGE_MAX_B64 },
    imageMime: { type: "string", max: 40 },
    text: { type: "string", max: 20000 },
    bankName: { type: "string", max: 80 },
  },
  prompt(input) {
    return [
      "Extract bank or e-wallet statement transactions as JSON only.",
      "Rules: Only return amounts printed on the page. Never invent rows or balances. Use the exact statement year printed on the page (for example 31/10/26 is 2026); never guess a past year.",
      input.bankName ? `Bank/wallet: ${input.bankName}` : "",
      input.text ? `Redacted page text:\n${input.text}` : "",
    ].filter(Boolean).join("\n");
  },
  schema: {
    type: "object",
    properties: {
      opening: { type: "number" },
      closing: { type: "number" },
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date: { type: "string" },
            desc: { type: "string" },
            amount: { type: "number" },
            dir: { type: "string", enum: ["in", "out"] },
            balance: { type: "number" },
          },
          required: ["date", "desc", "amount", "dir"],
        },
      },
    },
    required: ["rows"],
  },
  check(input, output) {
    if (!output || typeof output !== "object" || Array.isArray(output)) return null;
    const text = String(input.text || "");
    const hasText = text.length > 0;
    const out = {};

    const checkAmt = (v) => {
      const n = finiteAmount(v);
      if (n === null) return null;
      return (!hasText || amountInText(n, text)) ? n : null;
    };

    if (typeof output.opening === "number" && Number.isFinite(output.opening)) {
      if (!hasText || output.opening === 0 || amountInText(Math.abs(output.opening), text)) {
        out.opening = Math.round(output.opening * 100) / 100;
      }
    }
    if (typeof output.closing === "number" && Number.isFinite(output.closing)) {
      if (!hasText || output.closing === 0 || amountInText(Math.abs(output.closing), text)) {
        out.closing = Math.round(output.closing * 100) / 100;
      }
    }

    const rows = [];
    if (Array.isArray(output.rows)) {
      for (const r of output.rows.slice(0, 200)) {
        if (!r || typeof r !== "object") continue;
        const date = validIsoDate(r.date);
        const amt = checkAmt(r.amount);
        const dir = r.dir === "in" || r.dir === "out" ? r.dir : null;
        const desc = typeof r.desc === "string" ? r.desc.replace(/\s+/g, " ").trim().slice(0, 140) : "";
        if (!date || amt === null || !dir || !desc) continue;
        const row = { date, desc, amount: amt, dir };
        if (typeof r.balance === "number" && Number.isFinite(r.balance)) {
          if (!hasText || r.balance === 0 || amountInText(Math.abs(r.balance), text)) {
            row.balance = Math.round(r.balance * 100) / 100;
          }
        }
        rows.push(row);
      }
    }
    if (rows.length) out.rows = rows;
    return Object.keys(out).length ? out : null;
  },
};
