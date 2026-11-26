// Task: ea-read (v1, vision, scan bucket) — Borang EA extraction
const { IMAGE_MAX_B64, finiteAmount, amountInText, round2 } = require("./helpers");

const EA_NUM_FIELDS = ["b1a", "b1b", "b1c", "b1d", "b1e", "b2", "b3", "b4", "b5", "c", "sectionB", "d1", "d2", "d3", "d4", "d5", "e1", "e2"];

module.exports = {
  name: "ea-read",
  model: "vision",
  bucket: "scan",
  timeoutMs: 35000,
  input: {
    image: { type: "string", max: IMAGE_MAX_B64 },
    imageMime: { type: "string", max: 40 },
    text: { type: "string", max: 16000 },
  },
  prompt(input) {
    return [
      "Extract Malaysian Borang EA printed figures as JSON only.",
      "Rules: Only return figures literally printed on the Borang EA. Never estimate or calculate missing lines.",
      input.text ? `Redacted text:\n${input.text}` : "",
    ].filter(Boolean).join("\n");
  },
  schema: {
    type: "object",
    properties: {
      year: { type: "number" },
      b1a: { type: "number" },
      b1b: { type: "number" },
      b1c: { type: "number" },
      b2: { type: "number" },
      b3: { type: "number" },
      b4: { type: "number" },
      b5: { type: "number" },
      c: { type: "number" },
      sectionB: { type: "number" },
      d1: { type: "number" },
      d2: { type: "number" },
      d3: { type: "number" },
      d4: { type: "number" },
      d5: { type: "number" },
      e1: { type: "number" },
      e2: { type: "number" },
    },
  },
  check(input, output) {
    if (!output || typeof output !== "object" || Array.isArray(output)) return null;
    const text = String(input.text || "");
    const hasText = text.length > 0;
    const out = {};

    if (typeof output.year === "number" && Number.isInteger(output.year) && output.year >= 2015 && output.year <= 2035) {
      if (!hasText || text.includes(String(output.year))) out.year = output.year;
    }

    for (const k of EA_NUM_FIELDS) {
      if (output[k] === undefined || output[k] === null) continue;
      const n = finiteAmount(output[k]);
      if (n !== null && (!hasText || amountInText(n, text))) {
        out[k] = n;
      }
    }

    // Same total-check rule as app/ea-extract.js: if sectionB is present and
    // doesn't match the sum of printed B lines, tag "Check".
    if (out.sectionB !== undefined) {
      const bLines = ["b1a", "b1b", "b1c", "b1d", "b1e", "b2", "b3", "b4", "b5"]
        .filter((k) => out[k] !== undefined)
        .reduce((s, k) => s + out[k], 0);
      if (bLines > 0 && Math.abs(round2(bLines) - out.sectionB) > 0.05) {
        out.totalCheck = "Check";
      }
    }

    return Object.keys(out).length ? out : null;
  },
};
