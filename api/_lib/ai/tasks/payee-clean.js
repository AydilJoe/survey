// Task: payee-clean (v1, lite, text bucket) — Clean raw bank/e-wallet payee string
const { wordsInText } = require("./helpers");

module.exports = {
  name: "payee-clean",
  model: "lite",
  bucket: "text",
  timeoutMs: 12000,
  input: {
    raw: { type: "string", required: true, max: 120 },
  },
  prompt(input) {
    return [
      "Clean this raw Malaysian bank or e-wallet payee description into a tidy merchant name as JSON only.",
      "Rules: Strip prefixes like PYMT*, DUITNOW QR *, FPX, card suffixes, and branch codes. Every word in `payee` must come from the input text.",
      `Raw: ${input.raw}`,
    ].join("\n");
  },
  schema: {
    type: "object",
    properties: {
      payee: { type: "string" },
    },
    required: ["payee"],
  },
  check(input, output) {
    if (!output || typeof output !== "object" || Array.isArray(output)) return null;
    const payee = wordsInText(output.payee, input.raw);
    if (!payee) return null;
    return { payee: payee.slice(0, 80) };
  },
};
