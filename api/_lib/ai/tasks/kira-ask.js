// Task: kira-ask (v1, lite, text bucket) — Kira session-only personal finance assistant
// Answers questions about spending, LHDN tax relief headroom, and Debt Strategy Library
// using ONLY the redacted summary numbers computed locally on the device.
// Never invents amounts; money-writing suggestions only prefill the Confirm card.

const ALLOWED_ACTIONS = new Set([
  "open_tax",
  "open_debts",
  "open_reports",
  "open_savings",
  "open_monthly",
  "open_scan",
  "open_statement",
  "prefill_spend",
]);

module.exports = {
  name: "kira-ask",
  model: "lite",
  bucket: "text",
  timeoutMs: 14000,
  input: {
    question: { type: "string", required: true, max: 300 },
    lang: { type: "string", max: 12 },
    summary: { type: "string", required: true, max: 2400 },
    history: { type: "string[]", maxItems: 6, maxItemLen: 260 },
  },
  prompt(input) {
    const langName = input.lang === "ms"
      ? "Bahasa Melayu (natural Malaysian Malay)"
      : input.lang === "zh"
        ? "Simplified Chinese"
        : "plain, friendly English";
    return [
      "You are Kira, the calm personal-finance assistant inside Duitful (Malaysia-focused ledger).",
      `Answer in ${langName} in 1 to 3 concise sentences.`,
      "STRICT RULES:",
      "- Use ONLY numbers present in the user's live local summary below. Never invent, extrapolate, or guess any figure not given.",
      "- Never claim you saved, edited, or deleted anything. If suggesting a spend or relief entry, emit a prefill_spend action so the user confirms with 1 tap.",
      "- Keep tone warm, clear, and non-judgmental. No markdown headers, no bullet spam.",
      input.history && input.history.length ? `Recent session turns:\n${input.history.join("\n")}` : "",
      `Live local summary (redacted):\n${input.summary}`,
      `User question: ${input.question}`,
    ].filter(Boolean).join("\n\n");
  },
  schema: {
    type: "object",
    properties: {
      reply: { type: "string" },
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: [
                "open_tax",
                "open_debts",
                "open_reports",
                "open_savings",
                "open_monthly",
                "open_scan",
                "open_statement",
                "prefill_spend",
              ],
            },
            label: { type: "string" },
            sentence: { type: "string" },
          },
          required: ["kind", "label"],
        },
      },
    },
    required: ["reply"],
  },
  check(_input, output) {
    if (!output || typeof output !== "object" || Array.isArray(output)) return null;
    if (typeof output.reply !== "string") return null;
    const reply = output.reply.replace(/\s+/g, " ").trim().slice(0, 600);
    if (!reply) return null;
    const actions = [];
    if (Array.isArray(output.actions)) {
      for (const a of output.actions.slice(0, 3)) {
        if (!a || typeof a !== "object") continue;
        if (!ALLOWED_ACTIONS.has(a.kind)) continue;
        const label = typeof a.label === "string" ? a.label.replace(/\s+/g, " ").trim().slice(0, 48) : "";
        if (!label) continue;
        const row = { kind: a.kind, label };
        if (a.kind === "prefill_spend" && typeof a.sentence === "string") {
          const sentence = a.sentence.replace(/\s+/g, " ").trim().slice(0, 140);
          if (sentence) row.sentence = sentence;
        }
        actions.push(row);
      }
    }
    return actions.length ? { reply, actions } : { reply };
  },
};
