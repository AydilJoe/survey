// Task: receipt-read (v1, vision, scan bucket)
const { IMAGE_MAX_B64, finiteAmount, amountInText, inList, wordsInText, validIsoDate, round2 } = require("./helpers");

module.exports = {
  name: "receipt-read",
  model: "vision",
  bucket: "scan",
  timeoutMs: 35000,
  input: {
    image: { type: "string", max: IMAGE_MAX_B64 },
    imageMime: { type: "string", max: 40 },
    ocrText: { type: "string", required: true, max: 12000 },
    categories: { type: "string[]", maxItems: 60, maxItemLen: 48 },
  },
  prompt(input) {
    const cats = (input.categories || []).join(", ");
    return [
      "Extract structured receipt fields as JSON only.",
      "Rules: Only return amounts that are literally printed on the receipt. Never invent or guess numbers.",
      cats ? `Allowed categories: [${cats}]. Pick one only if clearly applicable, otherwise omit.` : "",
      "OCR text from device:",
      input.ocrText,
    ].filter(Boolean).join("\n");
  },
  schema: {
    type: "object",
    properties: {
      total: { type: "number" },
      date: { type: "string" },
      vendor: { type: "string" },
      category: { type: "string" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            qty: { type: "number" },
            amount: { type: "number" },
          },
          required: ["name", "amount"],
        },
      },
    },
  },
  check(input, output) {
    if (!output || typeof output !== "object" || Array.isArray(output)) return null;
    const out = {};
    const text = String(input.ocrText || "");

    // Total kept ONLY if printed in OCR text (same rule as mergeReceiptOpinion).
    if (output.total !== undefined && amountInText(output.total, text)) {
      out.total = finiteAmount(output.total);
    }
    const date = validIsoDate(output.date);
    if (date) out.date = date;

    const vendor = wordsInText(output.vendor, text);
    if (vendor) out.vendor = vendor.slice(0, 80);

    const cat = inList(output.category, input.categories || []);
    if (cat) out.category = cat;

    if (Array.isArray(output.items)) {
      const items = [];
      for (const it of output.items.slice(0, 80)) {
        if (!it || typeof it !== "object") continue;
        const amt = finiteAmount(it.amount);
        const name = typeof it.name === "string" ? it.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
        if (!name || amt === null || !amountInText(amt, text)) continue;
        const row = { name, amount: amt };
        if (typeof it.qty === "number" && Number.isFinite(it.qty) && it.qty > 0 && it.qty <= 999) {
          row.qty = round2(it.qty);
        }
        items.push(row);
      }
      if (items.length) {
        out.items = items;
        if (out.total !== undefined) {
          const sum = round2(items.reduce((s, r) => s + r.amount, 0));
          if (Math.abs(sum - out.total) > 0.05) out.itemsCheck = "Check";
        }
      }
    }

    return Object.keys(out).length ? out : null;
  },
};
