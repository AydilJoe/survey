/* Duitful — reading a Borang EA (C.P.8A), the yearly statement of
 * remuneration a Malaysian employer gives each employee.
 *
 * Pure functions over text lines (a PDF's text layer, or OCR of a photo, both
 * already turned into lines by statement.js). Nothing here guesses: a figure
 * is filled only when the form prints it on a labelled line, and the
 * Section B total is only CHECKED against the items, never adjusted. Labels
 * are matched in Malay and English, since employers use either form.
 *
 * eaExtract(lines) → {
 *   year,                       // year of remuneration, or 0
 *   fields: { id: { value, line } },   // only figures the form prints
 *   sumB,                       // the B (and C) items that were found, added
 *   totalCheck: "ok" | "mismatch" | "none",
 * }
 */

// One money figure: 1,234.56 / 1234.56 / RM1,234.56. Two decimals required,
// so dates (31/12/2025), IC numbers and counts never read as money.
const EA_MONEY = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?![\d.])/g;

function eaMoneyIn(text) {
  const out = [];
  for (const m of String(text || "").matchAll(EA_MONEY)) out.push(Math.round(Number(m[1].replace(/,/g, "") + "." + m[2]) * 100) / 100);
  return out;
}

/* The figures, in form order. `sec` limits where a label is looked for (the
   letters of the form's sections); `re` is the label, Malay or English. */
const EA_FIELDS = [
  { id: "b1a", sec: "B", code: "B1(a)", label: "Salary", re: /gaji kasar|gross salary|salary,? wages|upah atau gaji cuti/i },
  { id: "b1b", sec: "B", code: "B1(b)", label: "Fees, commission, bonus", re: /\bfi\b.*(komisen|bonus)|fees?\b.*(commission|bonus)/i },
  { id: "b1c", sec: "B", code: "B1(c)", label: "Tips, perquisites, allowances", re: /tip kasar|gross tips|perkuisit|perquisite/i },
  { id: "b1d", sec: "B", code: "B1(d)", label: "Income tax paid by employer", re: /cukai pendapatan yang dibayar oleh majikan|income tax borne by (the )?employer/i },
  { id: "b1e", sec: "B", code: "B1(e)", label: "ESOS benefit", re: /\besos\b|opsyen saham|share option/i },
  { id: "b1f", sec: "B", code: "B1(f)", label: "Gratuity", re: /ganjaran|gratuity/i },
  { id: "arrears", sec: "B", code: "", label: "Arrears for earlier years", re: /tunggakan|arrears/i },
  { id: "b2", sec: "B", code: "B2", label: "Benefits in kind", re: /manfaat berupa barangan|benefits?[- ]in[- ]kind/i },
  { id: "b3", sec: "B", code: "B3", label: "Living accommodation", re: /tempat kediaman|living accommodation/i, not: /^\s*B\b|pendapatan penggajian|employment income/i },
  { id: "b4", sec: "B", code: "B4", label: "Refund from unapproved fund", re: /tidak diluluskan|unapproved/i },
  { id: "b5", sec: "B", code: "B5", label: "Compensation for loss of employment", re: /pampasan|compensation for loss/i },
  { id: "c1", sec: "C", code: "C1", label: "Pension", re: /^\W*(?:1\.?\s*)?(pencen|pension)\b/i },
  { id: "c2", sec: "C", code: "C2", label: "Annuities", re: /anuiti|annuit/i },
  { id: "bTotal", sec: "BC", code: "", label: "Total income", re: /^\W*(jumlah|total)(\s+(pendapatan|income|kasar|gross))?\W*(rm)?\s*[\d,]+\.\d{2}\s*$/i, sameLine: true },
  { id: "d1", sec: "D", code: "D1", label: "PCB", re: /potongan cukai bulanan|\bpcb\b|\bmtd\b|monthly tax deduction/i },
  { id: "d2", sec: "D", code: "D2", label: "CP38", re: /cp\s?38/i },
  { id: "d3", sec: "D", code: "D3", label: "Zakat via salary", re: /zakat.*(potongan gaji|salary deduction)/i, not: /selain|other than/i },
  { id: "d4", sec: "D", code: "D4", label: "TP1 relief claims", re: /\btp\s?1\b/i },
  { id: "d5", sec: "D", code: "D5", label: "TP3 claims", re: /\btp\s?3\b|anak yang layak|qualifying child/i },
  { id: "e1", sec: "E", code: "E1", label: "EPF", re: /\bkwsp\b|\bepf\b|employees provident/i },
  { id: "e2", sec: "E", code: "E2", label: "SOCSO", re: /perkeso|socso/i },
  { id: "eis", sec: "E", code: "E2", label: "EIS", re: /\bsip\b|\beis\b|insurans pekerjaan|employment insurance/i },
];
const EA_INCOME_PARTS = ["b1a", "b1b", "b1c", "b1d", "b1e", "b1f", "arrears", "b2", "b3", "b4", "b5", "c1", "c2"];

// Section headings: "B. PENDAPATAN PENGGAJIAN…", "D JUMLAH POTONGAN", "E. CARUMAN…".
const EA_SECTIONS = {
  B: /^\W*B\s*[.:)]?\s+(pendapatan penggajian|employment income)/i,
  C: /^\W*C\s*[.:)]?\s+(pencen|pension)/i,
  D: /^\W*D\s*[.:)]?\s+(jumlah potongan|total deduction|potongan)/i,
  E: /^\W*E\s*[.:)]?\s+(caruman|contribution)/i,
  F: /^\W*F\s*[.:)]?\s+(jumlah elaun|total tax[- ]exempt|elaun|allowance)/i,
};

function eaLineText(l) { return typeof l === "string" ? l : String((l && l.text) || ""); }

// The year of remuneration: "TAHUN BERAKHIR 31 DISEMBER 2025" / "YEAR ENDED
// 31 DECEMBER 2025", else a labelled year field.
function eaFindYear(texts) {
  const all = texts.join("\n");
  const m = /(?:tahun berakhir|year ended)\s*31\s*(?:disember|december)\s*(20\d{2})/i.exec(all)
    || /(?:tahun|year)\s*(?:saraan|of remuneration)?\s*[:.]?\s*(20\d{2})\b/i.exec(all);
  return m ? Number(m[1]) : 0;
}

/* Where each section's lines are: [start, end) indexes. A form whose headings
   OCR couldn't read is searched whole, which is still safe: every label is
   specific enough on its own. */
function eaSectionRanges(texts) {
  const at = {};
  texts.forEach((t, i) => { for (const [k, re] of Object.entries(EA_SECTIONS)) if (at[k] == null && re.test(t)) at[k] = i; });
  const order = ["B", "C", "D", "E", "F"].filter((k) => at[k] != null).sort((a, b) => at[a] - at[b]);
  const ranges = {};
  order.forEach((k, i) => { ranges[k] = [at[k], i + 1 < order.length ? at[order[i + 1]] : texts.length]; });
  return ranges;
}

function eaExtract(lines) {
  const texts = (lines || []).map(eaLineText);
  const ranges = eaSectionRanges(texts);
  const span = (sec) => {
    const parts = sec.split("").map((k) => ranges[k]).filter(Boolean);
    if (!parts.length) return [0, texts.length];
    return [Math.min(...parts.map((p) => p[0])), Math.max(...parts.map((p) => p[1]))];
  };
  const isLabel = (t, self) => EA_FIELDS.some((f) => f !== self && f.re.test(t) && !(f.not && f.not.test(t)));
  const fields = {};
  const used = new Set();
  for (const f of EA_FIELDS) {
    let [from, to] = span(f.sec);
    // The total sits under Section B/C, before D.
    if (f.id === "bTotal" && ranges.D) to = Math.min(to, ranges.D[0]);
    for (let i = from; i < to && !fields[f.id]; i++) {
      const t = texts[i];
      if (!f.re.test(t) || (f.not && f.not.test(t)) || used.has(i)) continue;
      // A heading line ("E. CARUMAN … KWSP …") names the section, not a figure.
      if (f.id !== "bTotal" && Object.values(EA_SECTIONS).some((re) => re.test(t)) && !eaMoneyIn(t).length) continue;
      let money = eaMoneyIn(t), at = i;
      // The figure on the next line or two ("Amaun caruman … RM 5,280.00"),
      // as long as that line isn't another item's label.
      for (let j = i + 1; !money.length && !f.sameLine && j <= i + 2 && j < to; j++) {
        if (isLabel(texts[j], f)) break;
        money = eaMoneyIn(texts[j]); at = j;
      }
      if (!money.length) continue;
      used.add(at);
      fields[f.id] = { value: money[money.length - 1], line: texts[at].trim() };
    }
  }
  const parts = EA_INCOME_PARTS.filter((id) => fields[id]);
  const sumB = Math.round(parts.reduce((s, id) => s + fields[id].value * 100, 0)) / 100;
  const totalCheck = !fields.bTotal || !parts.length ? "none"
    : Math.abs(fields.bTotal.value - sumB) < 0.005 ? "ok" : "mismatch";
  return { year: eaFindYear(texts), fields, sumB, parts, totalCheck };
}

// Exposed for tests and tax.js.
if (typeof window !== "undefined") Object.assign(window, { eaExtract, eaMoneyIn, EA_FIELDS, EA_INCOME_PARTS });
