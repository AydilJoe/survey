// Task: loan-read (v1, vision, scan bucket) — Loan / PTPTN / Card statement pre-fill
const { IMAGE_MAX_B64, finiteAmount, amountInText, inList, wordsInText, validIsoDate } = require("./helpers");

module.exports = {
  name: "loan-read",
  model: "vision",
  bucket: "scan",
  timeoutMs: 35000,
  input: {
    image: { type: "string", max: IMAGE_MAX_B64 },
    imageMime: { type: "string", max: 40 },
    text: { type: "string", max: 16000 },
    kinds: { type: "string[]", maxItems: 20, maxItemLen: 32 },
    contracts: { type: "string[]", maxItems: 20, maxItemLen: 48 },
  },
  prompt(input) {
    return [
      "Extract loan, PTPTN, or credit-card statement fields for pre-filling an Add Debt form as JSON only.",
      "Rules: Only return figures literally printed on the document. Never guess rates or balances.",
      input.kinds && input.kinds.length ? `Allowed kinds: [${input.kinds.join(", ")}]` : "",
      input.contracts && input.contracts.length ? `Allowed Islamic contracts: [${input.contracts.join(", ")}]` : "",
      input.text ? `Redacted text:\n${input.text}` : "",
    ].filter(Boolean).join("\n");
  },
  schema: {
    type: "object",
    properties: {
      lender: { type: "string" },
      kind: { type: "string" },
      islamic: { type: "boolean" },
      contract: { type: "string" },
      balance: { type: "number" },
      monthly: { type: "number" },
      rate: { type: "number" },
      endDate: { type: "string" },
    },
  },
  check(input, output) {
    if (!output || typeof output !== "object" || Array.isArray(output)) return null;
    const text = String(input.text || "");
    const hasText = text.length > 0;
    const out = {};

    const lender = hasText ? wordsInText(output.lender, text) : (typeof output.lender === "string" ? output.lender.trim() : null);
    if (lender) out.lender = lender.slice(0, 80);

    const kind = inList(output.kind, input.kinds || []);
    if (kind) out.kind = kind;

    if (typeof output.islamic === "boolean") out.islamic = output.islamic;

    const contract = inList(output.contract, input.contracts || []);
    if (contract) out.contract = contract;

    for (const k of ["balance", "monthly", "rate"]) {
      if (output[k] === undefined || output[k] === null) continue;
      const n = finiteAmount(output[k]);
      if (n !== null && (!hasText || amountInText(n, text))) {
        if (k === "rate" && n > 100) continue;
        out[k] = n;
      }
    }

    const endDate = validIsoDate(output.endDate);
    if (endDate) out.endDate = endDate;

    return Object.keys(out).length ? out : null;
  },
};
