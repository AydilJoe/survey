// Task: split-match (v1, lite, text bucket) — Match bank-alert sender name to an open split person
const { finiteAmount } = require("./helpers");

module.exports = {
  name: "split-match",
  model: "lite",
  bucket: "text",
  timeoutMs: 12000,
  input: {
    sender: { type: "string", required: true, max: 120 },
    amount: { type: "number", required: true, min: 0.01, max: 1e9 },
    openSplits: { type: "object[]", required: true, maxItems: 30 },
  },
  prompt(input) {
    const list = (input.openSplits || [])
      .map((s) => `- id:${s.id} name:${s.name} amount:${s.amount}`)
      .join("\n");
    return [
      "Match a Malaysian bank-alert sender name to one of the open split people below, or return null if unsure.",
      "Rules: Only return a splitId whose amount equals the alert amount exactly.",
      `Sender: ${input.sender}`,
      `Alert amount: ${input.amount}`,
      "Open splits:",
      list,
    ].join("\n");
  },
  schema: {
    type: "object",
    properties: {
      splitId: { type: "string", nullable: true },
    },
    required: ["splitId"],
  },
  check(input, output) {
    if (!output || typeof output !== "object" || Array.isArray(output)) return null;
    if (output.splitId === null || output.splitId === "") return { splitId: null };
    if (typeof output.splitId !== "string") return null;
    const alertAmt = finiteAmount(input.amount);
    if (alertAmt === null) return null;
    const match = (input.openSplits || []).find((s) => {
      if (!s || typeof s !== "object") return false;
      const amt = finiteAmount(s.amount);
      return String(s.id) === output.splitId && amt !== null && Math.abs(amt - alertAmt) < 0.005;
    });
    return match ? { splitId: String(match.id) } : { splitId: null };
  },
};
