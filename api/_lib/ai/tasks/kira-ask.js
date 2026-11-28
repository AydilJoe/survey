// Task: kira-ask (v2, text bucket) — Kira's session-only chat inside Duitful.
// Answers questions about the person's own money in Duitful (spending, debts and
// the Debt Strategy Library, savings, the active tax pack) and how to use
// Duitful's features, using ONLY the redacted summary numbers computed on the
// device. Anything else gets one friendly line steering back. May ask ONE
// follow-up question with up to 4 quick replies (`ask`) when the question is
// unclear. Never invents amounts; money-writing suggestions only prefill the
// Confirm card.

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

const ASK_QUESTION_MAX = 160;
const ASK_OPTION_MAX = 40;
const ASK_OPTIONS_MAX = 4;

// Every number written in `text` must be one of the numbers in `allowed`
// (the summary, the question and the session's earlier turns).
function numbersIn(text) {
  return (String(text || "").match(/\d[\d,]*(?:\.\d+)?/g) || [])
    .map((x) => Number(x.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
}
function numbersAllowed(text, sources) {
  const want = numbersIn(text);
  if (!want.length) return true;
  const have = numbersIn(sources.join(" "));
  return want.every((n) => have.some((h) => Math.abs(h - n) < 0.005));
}
function cleanLine(v, max) {
  if (typeof v !== "string") return "";
  const s = v.replace(/\s+/g, " ").trim();
  if (!s || s.length > max) return "";
  if (/https?:|www\.|<|>|```/i.test(s)) return "";
  return s;
}

// The optional follow-up: a short question and 2–4 short, distinct replies.
// Numbers only from what the phone sent. Anything off → no `ask`.
function checkAsk(raw, input) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const question = cleanLine(raw.question, ASK_QUESTION_MAX);
  if (!question) return null;
  const sources = [input.summary || "", input.question || "", ...(Array.isArray(input.history) ? input.history : [])];
  if (!numbersAllowed(question, sources)) return null;
  if (!Array.isArray(raw.options)) return null;
  const seen = new Set();
  const options = [];
  for (const o of raw.options) {
    const opt = cleanLine(o, ASK_OPTION_MAX);
    if (!opt || !numbersAllowed(opt, sources)) return null;
    const key = opt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(opt);
  }
  if (options.length < 2 || options.length > ASK_OPTIONS_MAX) return null;
  return { question, options };
}

module.exports = {
  name: "kira-ask",
  model: "lite",
  bucket: "text",
  timeoutMs: 14000,
  input: {
    question: { type: "string", required: true, max: 300 },
    lang: { type: "string", max: 12 },
    summary: { type: "string", required: true, max: 2400 },
    history: { type: "string[]", maxItems: 10, maxItemLen: 260 },
  },
  prompt(input) {
    const langName = input.lang === "ms"
      ? "Bahasa Melayu (natural Malaysian Malay)"
      : input.lang === "zh"
        ? "Simplified Chinese"
        : "plain, friendly English";
    return [
      "You are Kira, the calm personal-finance assistant inside the Duitful app.",
      `Answer in ${langName} in 1 to 3 concise sentences.`,
      "SCOPE: talk only about (a) the user's own money in Duitful, using the summary below, and (b) how to use Duitful's features: logging spends and income by voice or typing, receipt scans, bank statement import, wallets, budget pools, Monthly bills, debts and payoff strategies (avalanche, snowball and the Debt Strategy Library), savings goals, split bills and recurring splits, tax relief tracking, reports, CSV export and iCloud / Google Drive backup.",
      "- If the question is about anything else (news, weather, coding, general knowledge, other apps), reply with ONE friendly line steering back, e.g. \"I can help with your money in Duitful — like what you spent this month, your debts or your tax relief.\" Do not answer the off-topic part.",
      "STRICT RULES:",
      "- Use ONLY numbers present in the user's live local summary below. Never invent, extrapolate, or guess any figure not given.",
      "- For tax questions, follow ONLY the active country tax pack shown in the summary (e.g. LHDN Malaysia, IRAS Singapore, IRD Hong Kong). If the summary says Global Tax Receipt Vault mode, help only with tagging, organizing, and exporting receipts — never cite Malaysian LHDN or other country caps.",
      "- Describe, don't advise: no financial, investment, insurance or loan product recommendations, and no picks of funds, shares or providers. Explaining how Duitful's payoff strategies order the user's own debts is fine.",
      "- Never claim you saved, edited, or deleted anything. If suggesting a spend or relief entry, emit a prefill_spend action so the user confirms with 1 tap.",
      "- FOLLOW-UP: if the question is unclear (which month, which debt, which feature), give your best short reply and add `ask` with one short question and 2 to 4 short quick replies the user can tap (each under 40 characters). Ask at most one question. Omit `ask` when the question is clear.",
      "- Short replies like \"yes\", \"the second one\" or a single word answer your last question in the session turns; read them in that light.",
      "- Keep tone warm, clear, and non-judgmental. No markdown headers, no bullet spam.",
      input.history && input.history.length ? `Recent session turns (oldest first):\n${input.history.join("\n")}` : "",
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
      ask: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["question", "options"],
      },
    },
    required: ["reply"],
  },
  checkAsk,
  check(input, output) {
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
    const out = { reply };
    if (actions.length) out.actions = actions;
    const ask = checkAsk(output.ask, input || {});
    if (ask) out.ask = ask;
    return out;
  },
};
