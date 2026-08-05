#!/usr/bin/env node
/* Generates tools/marketing/sample-data.csv — a believable but entirely
 * invented month-by-month of a KL working adult, for screenshots.
 *
 * The point is "almost accurate": nobody should look at a Duitful screenshot
 * and think the numbers are made up, and nobody should be looking at the
 * owner's real spending either. So the figures are anchored to real 2026
 * Malaysian prices — RON95 at RM 1.99/L under Budi95, Unifi 100Mbps at
 * RM 139, a PTPTN minimum, a Myvi hire-purchase instalment — and the noise
 * around them is seeded, so re-running this produces the identical file.
 *
 * Two things are deliberate:
 *   - The period covers June, July and the start of August. Reports compares
 *     against the prior period, so a July screenshot has a real June behind
 *     it instead of "RM 0.00 · ▲ —", which reads as a broken app.
 *   - June is spent a little heavier than July. The comparison line then
 *     tells a small true story (spending came down) rather than being noise.
 *
 * Usage: node scripts/make-sample-data.mjs
 * Then:  import the CSV from Settings → Data → Import, in a browser profile
 *        that does NOT hold real data.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tools/marketing/sample-data.csv");

// Seeded so the committed CSV is reproducible — a diff on this file should
// mean somebody changed the profile, not that the dice landed differently.
let _seed = 20260805;
const rnd = () => {
  _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
  return _seed / 0x7fffffff;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => +(lo + rnd() * (hi - lo)).toFixed(2);
const chance = (p) => rnd() < p;

const HEADER = [
  "type", "name", "amount", "balance", "apr", "minPayment", "date", "category",
  "note", "debtName", "target", "current", "month", "day", "dueDay", "kind",
  "monthsLeft", "term_months", "brand",
];
const rows = [];
const add = (o) => rows.push(HEADER.map((h) => (o[h] ?? "")));

const MONTHS = ["2026-06", "2026-07", "2026-08"];
const LAST_DAY = { "2026-06": 30, "2026-07": 31, "2026-08": 5 }; // Aug is mid-month
const iso = (month, day) => `${month}-${String(day).padStart(2, "0")}`;

/* ---------- income ---------- */
// Net of EPF, SOCSO and PCB — the figure that actually lands in the account.
for (const month of MONTHS) {
  add({ type: "income", name: "Gaji", amount: 5100, month, day: 25 });
  // Side work doesn't arrive every month, and pretending it does is the kind
  // of detail that makes a screenshot feel synthetic.
  if (month !== "2026-08") {
    add({ type: "income", name: "Freelance design", amount: month === "2026-06" ? 850 : 600, month, day: 18 });
  }
}

/* ---------- fixed monthly bills ---------- */
// TNB and Air Selangor move month to month; the rest are contracts.
const FIXED = [
  { name: "Sewa bilik", amount: () => 1200, day: 1 },
  { name: "Netflix + Spotify", amount: () => 55, day: 3 },
  { name: "Insurans medical card", amount: () => 210, day: 5 },
  { name: "Unifi 100Mbps", amount: () => 139, day: 8 },
  { name: "Telefon postpaid", amount: () => 78, day: 12 },
  { name: "Utilities (TNB)", amount: () => between(132, 178), day: 12 },
  { name: "Air Selangor", amount: () => between(24, 33), day: 15 },
];
for (const month of MONTHS) {
  for (const f of FIXED) {
    // August is only 5 days in, so bills dated later haven't landed yet.
    if (f.day > LAST_DAY[month]) continue;
    add({ type: "expense", name: f.name, amount: f.amount(), month, day: f.day });
  }
}

/* ---------- debts ---------- */
// One card, one PTPTN, one hire purchase, two BNPL — which is roughly what a
// Malaysian in their late twenties is actually carrying, and it exercises the
// brand tiles: SPayLater ships artwork, Atome falls back to its colour,
// Maybank and PTPTN fall back to monograms.
// Names are kept to ~14 characters on purpose: a debt row puts the name and
// the balance on one line, so anything longer truncates with an ellipsis in
// a phone-width screenshot — which is the whole reason this file exists.
add({ type: "debt", name: "Maybank card", balance: 3240, apr: 18, minPayment: 162, dueDay: 15, kind: "standard", brand: "maybank" });
add({ type: "debt", name: "PTPTN", balance: 12400, apr: 1, minPayment: 150, dueDay: 28, kind: "standard" });
add({ type: "debt", name: "Kereta Myvi", balance: 25070, minPayment: 545, dueDay: 5, kind: "installment", monthsLeft: 46, term_months: 84 });
add({ type: "debt", name: "SPayLater", balance: 533.34, minPayment: 266.67, dueDay: 18, kind: "installment", monthsLeft: 2, term_months: 3, brand: "spaylater" });
add({ type: "debt", name: "Atome — Uniqlo", balance: 89.9, minPayment: 89.9, dueDay: 22, kind: "installment", monthsLeft: 1, term_months: 3, brand: "atome" });

/* ---------- savings ---------- */
add({ type: "saving", name: "Simpanan kecemasan", target: 15000, current: 4200 });
add({ type: "saving", name: "Umrah 2027", target: 8000, current: 1150 });

/* ---------- daily spending ---------- */
// Prices are the boring kind of accurate: nasi lemak bungkus, economy rice
// with two dishes, a Grab across PJ, a RON95 tank at RM 1.99/L.
const BREAKFAST = [
  ["Nasi lemak + kopi O", 7.5, 9.5],
  ["Roti canai + teh tarik", 6.5, 8.5],
  ["Kopitiam breakfast set", 11, 14],
];
const LUNCH = [
  ["Nasi campur 2 lauk", 10.5, 14],
  ["Economy rice", 9.5, 13],
  ["Chicken rice", 11, 14.5],
  ["Lunch food court KLCC", 15, 19],
];
const DINNER = [
  ["Mamak dinner", 12, 18],
  ["Tapau dinner", 13, 17],
  ["Dinner dengan geng", 28, 45],
];
const TREATS = [
  ["Tealive", 11.9, 15.9],
  ["Starbucks", 17, 22],
  ["Kuih pasar malam", 5, 9],
];

const cat = (category, month, day, amount, note) =>
  add({ type: "daily", amount: +amount.toFixed(2), date: iso(month, day), category, note });

for (const month of MONTHS) {
  const last = LAST_DAY[month];
  // June ran hot (school holidays, a wedding), July was tighter. The Reports
  // comparison line then says something true instead of nothing.
  const heavy = month === "2026-06";

  for (let day = 1; day <= last; day++) {
    const dow = new Date(`${iso(month, day)}T00:00:00Z`).getUTCDay();
    const weekend = dow === 0 || dow === 6;

    // Breakfast on most workdays, rarely on a weekend lie-in.
    if (chance(weekend ? 0.3 : 0.55)) {
      const [note, lo, hi] = pick(BREAKFAST);
      cat("Food", month, day, between(lo, hi), note);
    }
    // Lunch is bought at work; weekends are leftovers or a late brunch.
    if (!weekend && chance(0.85)) {
      const [note, lo, hi] = pick(LUNCH);
      cat("Food", month, day, between(lo, hi), note);
    }
    // Dinner out two or three nights a week, more of them in June.
    if (chance(heavy ? 0.46 : 0.22)) {
      const [note, lo, hi] = pick(DINNER);
      cat("Food", month, day, between(lo, hi), note);
    }
    if (chance(heavy ? 0.28 : 0.1)) {
      const [note, lo, hi] = pick(TREATS);
      cat("Food", month, day, between(lo, hi), note);
    }

    // Petrol roughly weekly — a 35L fill of RON95 at RM 1.99 under Budi95.
    if (day % 7 === 3) cat("Transport", month, day, between(62, 74), "RON95 full tank");
    // Touch 'n Go reload for tolls, and the odd Grab when the car stays home.
    if (day % 16 === 5) cat("Transport", month, day, 50, "Touch 'n Go reload");
    if (chance(weekend ? 0.12 : 0.08)) cat("Transport", month, day, between(12, 26), "Grab");
    if (day % 12 === 2) cat("Transport", month, day, between(4, 8), "Parking");

    // One proper grocery run most weekends, plus the odd 99 Speedmart top-up.
    if (weekend && chance(0.4)) cat("Groceries", month, day, between(62, 128), pick(["Lotus's", "Jaya Grocer", "Mydin"]));
    else if (chance(0.1)) cat("Groceries", month, day, between(18, 42), "99 Speedmart");

    if (chance(heavy ? 0.15 : 0.05)) cat("Shopping", month, day, between(30, 140), pick(["Shopee", "Uniqlo", "Decathlon", "Watsons"]));
    if (chance(0.05)) cat("Health", month, day, between(26, 72), pick(["Klinik", "Guardian", "Supplement"]));
    if (chance(heavy ? 0.18 : 0.06)) cat("Entertainment", month, day, between(18, 58), pick(["GSC", "Bowling", "Board game cafe"]));
    if (chance(0.05)) cat("Others", month, day, between(10, 55), pick(["Hadiah kahwin", "Barber", "Laundry", "Topup parents"]));
  }

  // The one-offs a real month always has, both landed in June — which is
  // what makes June the heavy month July gets compared against.
  if (heavy) {
    cat("Others", "2026-06", 14, 250, "Angpow kahwin sepupu");
    cat("Health", "2026-06", 9, 120, "Scaling gigi");
  }
}

/* ---------- debt payments made ---------- */
// Reports tracks these separately from spending, which is exactly the point
// worth showing: the category pie is not the whole outflow.
for (const month of MONTHS) {
  const pays = [
    ["Kereta Myvi", 545, 5],
    ["Maybank card", 300, 15],
    ["SPayLater", 266.67, 18],
    ["Atome — Uniqlo", 89.9, 22],
    ["PTPTN", 150, 28],
  ];
  for (const [debtName, amount, day] of pays) {
    if (day > LAST_DAY[month]) continue;
    add({ type: "daily-debt", amount, date: iso(month, day), debtName });
  }
}

/* ---------- savings deposits ---------- */
// June was a deficit month, so the emergency fund got skipped and only the
// Umrah standing instruction went through. Saving the same amount in a month
// you overspent is the detail that gives synthetic data away.
for (const month of MONTHS) {
  if (26 > LAST_DAY[month]) continue;
  if (month !== "2026-06") add({ type: "daily-saving", name: "Simpanan kecemasan", amount: 400, date: iso(month, 26) });
  add({ type: "daily-saving", name: "Umrah 2027", amount: 150, date: iso(month, 26) });
}

/* ---------- write ---------- */
const esc = (v) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = [HEADER, ...rows].map((r) => r.map(esc).join(",")).join("\n") + "\n";
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, csv);

// Print the totals so a change to the profile is visible without importing.
const daily = rows.filter((r) => r[0] === "daily");
const sum = (rs) => rs.reduce((a, r) => a + Number(r[2]), 0);
const byMonth = (m) => daily.filter((r) => r[6].startsWith(m));
const byCat = (rs) => {
  const t = {};
  for (const r of rs) t[r[7]] = (t[r[7]] || 0) + Number(r[2]);
  return Object.entries(t).sort((a, b) => b[1] - a[1]);
};
console.log(`wrote ${path.relative(ROOT, OUT)} — ${rows.length} rows\n`);
for (const m of MONTHS) {
  const rs = byMonth(m);
  console.log(`${m}  daily RM ${sum(rs).toFixed(2)} across ${rs.length} entries`);
  for (const [c, v] of byCat(rs)) {
    console.log(`         ${c.padEnd(14)} RM ${v.toFixed(2).padStart(9)}  ${(v / sum(rs) * 100).toFixed(0)}%`);
  }
}
const jun = sum(byMonth("2026-06")), jul = sum(byMonth("2026-07"));
console.log(`\nJul vs Jun: ${jul > jun ? "+" : ""}${((jul - jun) / jun * 100).toFixed(1)}%`);
