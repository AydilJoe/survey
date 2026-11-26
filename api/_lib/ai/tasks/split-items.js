// Task: split-items (v1, lite, text bucket) — Tidy messy receipt lines for Split-by-item
const { finiteAmount, amountInText, round2 } = require("./helpers");

module.exports = {
  name: "split-items",
  model: "lite",
  bucket: "text",
  timeoutMs: 12000,
  input: {
    lines: { type: "string", required: true, max: 6000 },
    subtotal: { type: "number", required: true, min: 0.01, max: 1e9 },
  },
  prompt(input) {
    return [
      "Tidy these receipt item lines into clean split-by-item rows as JSON only.",
      "Rules: Group add-ons with their parent dish and split multi-quantity lines cleanly. Every item amount must come from the receipt lines and the items must sum to the printed subtotal.",
      `Printed subtotal: ${input.subtotal}`,
      "Receipt lines:",
      input.lines,
    ].join("\n");
  },
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            qty: { type: "number" },
            amount: { type: "number" },
          },
          required: ["name", "qty", "amount"],
        },
      },
    },
    required: ["items"],
  },
  check(input, output) {
    if (!output || typeof output !== "object" || !Array.isArray(output.items)) return null;
    const subtotal = finiteAmount(input.subtotal);
    if (subtotal === null) return null;
    const lines = String(input.lines || "");
    const items = [];
    for (const it of output.items.slice(0, 80)) {
      if (!it || typeof it !== "object") continue;
      const name = typeof it.name === "string" ? it.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
      const qty = typeof it.qty === "number" && Number.isFinite(it.qty) && it.qty > 0 && it.qty <= 99 ? round2(it.qty) : 1;
      const amt = finiteAmount(it.amount);
      if (!name || amt === null) continue;
      items.push({ name, qty, amount: amt });
    }
    if (!items.length) return null;
    const sum = round2(items.reduce((s, r) => s + r.amount, 0));
    if (Math.abs(sum - subtotal) > 0.05) {
      return { items, status: "Check" };
    }
    // Also verify at least one amount matches printed text (prevents pure fabrication).
    if (!items.some((r) => amountInText(r.amount, lines)) && !amountInText(subtotal, lines)) {
      return { items, status: "Check" };
    }
    return { items };
  },
};
