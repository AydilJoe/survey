// 13" iPad App Store screenshots (2064 x 2752, portrait), from the real app.
//
// The page runs as the iOS app would: a Capacitor stub reporting "ios", with
// the phone's AI on (the header badge) and ML Kit / Apple's model answering
// the receipt read, so the scan sheet below is the app's own flow from OCR
// text to "Add RM …". Sample data only: invented names and amounts.
//
//   python3 -m http.server 8765 &        # from the repo root
//   node marketing/app-store/scripts/capture-ipad.mjs
//
// Writes marketing/app-store/ipad/0*.png (RGB, no alpha) and, with
// LANDSCAPE=1, an extra ipad/landscape-home.png for reference (not uploaded).
// Fonts come from Google Fonts as in the app; set CHROMIUM_PATH if
// Playwright's own Chromium isn't installed.
import { chromium } from 'playwright';
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:8765';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ipad');
mkdirSync(OUT, { recursive: true });
// 13" iPad (M4) in points; DPR 2 gives Apple's 2064 x 2752.
const W = 1032, H = 1376;

const RECEIPT_TEXT = [
  '99 SPEED MART',
  'NO. 12, JALAN SS2/24, PJ',
  'SAB 21/11  18:42',
  'MILO 3IN1 18S 12.90',
  'GARDENIA ORIGINAL 4.50',
  'TELUR GRED A 10S 6.00',
  'JUMLAH RM 23.40',
  'TUNAI 50.00',
  'BAKI 26.60',
  'TERIMA KASIH',
].join('\n');

const iosShell = (receiptText) => {
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    Plugins: {
      DuitfulKit: {
        aiStatus: async () => ({ available: true }),
        // Apple's on-device model reading the receipt text: it may only fill
        // what the receipt prints (mergeReceiptOpinion checks).
        aiReadReceipt: async () => {
          await new Promise((r) => setTimeout(r, 300));
          return { total: 23.4, merchant: '99 Speed Mart', date: iso, currency: 'MYR' };
        },
      },
      CapacitorPluginMlKitTextRecognition: { detectText: async () => ({ text: receiptText, blocks: [] }) },
    },
  };
};

const b = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--lang=en-GB'], env: { ...process.env, LANG: 'en_GB.UTF-8', LANGUAGE: 'en_GB' } });
const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'en-MY', timezoneId: 'Asia/Kuala_Lumpur', hasTouch: true });
await ctx.addInitScript(iosShell, RECEIPT_TEXT);
await ctx.addInitScript(() => { try { localStorage.setItem('duitful.lang', 'en'); localStorage.setItem('duit-tracker.theme', 'light'); } catch {} });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
const hideCss = `#trial-banner,#update-banner,#reminder-ask,.save-error,#toast,.app-toast,.install-banner,.guide-spotlight,#ai-intro,#tax-intro{display:none!important} *{caret-color:transparent!important}`;

await p.goto(BASE + '/app/index.html'); await p.waitForTimeout(1200);
await p.click('#btn-start-open'); await p.waitForTimeout(1500);
await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
await p.addStyleTag({ content: hideCss });
await p.mouse.move(-10, -10);

await p.evaluate(() => {
  const m = currentMonthISO(); const t = todayISO(); const dd = Number(t.slice(8, 10));
  const d = (n) => `${m}-${String(Math.max(1, Math.min(dd, n))).padStart(2, '0')}`;
  state.aiIntroSeen = true; state.guideSeen = true;
  state.income = [{ id: 'i1', name: 'Salary', amount: 5200, month: m, day: 25 }, { id: 'i2', name: 'Freelance design', amount: 800, month: m, day: 10 }];
  state.expenses = [
    { id: 'x1', name: 'Rent', amount: 1300, month: m, day: 1 }, { id: 'x2', name: 'Unifi', amount: 129, month: m, day: 15 },
    { id: 'x3', name: 'Phone plan', amount: 58, month: m, day: 18 }, { id: 'x4', name: 'Netflix', amount: 55, month: m, day: 20 },
    { id: 'x5', name: 'TNB', amount: 142.6, month: m, day: 24 }];
  state.debts.push(
    { id: 'd1', name: 'Maybank Visa', balance: 4310.5, apr: 18, minPayment: 220, dueDay: 12, kind: 'standard' },
    { id: 'd4', name: 'CIMB personal loan', balance: 9600, apr: 7.5, minPayment: 400, dueDay: 5, kind: 'standard' },
    { id: 'd2', name: 'PTPTN', balance: 18240, apr: 1, minPayment: 190, dueDay: 28, kind: 'standard' },
    { id: 'd3', name: 'Atome', balance: 360, apr: 0, minPayment: 120, dueDay: 18, kind: 'installment', installment: 120, monthsLeft: 3, termMonths: 6 });
  state.savings = [{ id: 's1', name: 'Emergency fund', target: 15000, current: 6200 }, { id: 's2', name: 'Raya balik kampung', target: 2500, current: 1450 }];
  const items = [['Nasi lemak + teh tarik', 'Food', 9.5], ['Grab to KLCC', 'Transport', 16.4], ['Petron fuel', 'Transport', 80], ['Mydin groceries', 'Groceries', 142.3], ['Kopi', 'Food', 6.5], ['Shopee', 'Shopping', 89], ['Tealive', 'Food', 11.9], ['Touch n Go reload', 'Transport', 50], ['Watsons', 'Health', 38.7], ['Mamak dinner', 'Food', 27]];
  state.dailyExpenses = items.map(([note, category, amount], i) => ({ id: 'e' + i, createdAt: Date.now() - i * 1e6, kind: 'expense', date: d(dd - i * 2), amount, note, category }));
  // A few of today's, so Today shows a real day.
  [['Kopi O + roti bakar', 'Food', 7.2], ['LRT to KL Sentral', 'Transport', 3.4], ['Tealive', 'Food', 11.9]]
    .forEach(([note, category, amount], i) => state.dailyExpenses.push({ id: 't' + i, createdAt: Date.now() - 5e5 - i * 1e5, kind: 'expense', date: t, amount, note, category }));
  const s = splitState(); s.me = 'Aisyah';
  s.out.push({ id: 'r1', kind: 'split', title: 'Nasi Kandar Pelita', date: t, total: 126, people: [
    { id: 'p1', name: 'Hafiz', amount: 31.5, status: 'open', repayments: [] },
    { id: 'p2', name: 'Mei Ling', amount: 31.5, status: 'open', repayments: [] },
    { id: 'p3', name: 'Kumar', amount: 31.5, status: 'open', repayments: [] }] });
  s.payToEnabled = true; s.payTo = [{ label: 'DuitNow', value: '012-345 6789' }];
  state.extraMonthly = 300;
  const y = new Date().getFullYear();
  const tx = taxState();
  tx.enabled = true; tx.introSeen = true; tx.deltaSince = Date.now() + 1e9;
  // Check-ins already done this season, so no review sheet opens over Home.
  for (const k of [`${y}-nov`, `${y}-final`, `${y - 1}-final`, `${y - 1}-nov`]) tx.nudges[k] = Date.now();
  tx.figures[String(y)] = { income: 68400, pcb: 2940, epf: 7524 };
  tx.figures[String(y - 1)] = { income: 64800, pcb: 2700, epf: 7128 };
  tx.claims.push(coerceTaxClaim({ relief: 'lifestyle', amount: 1299, date: d(3), note: 'Laptop for work' }));
  tx.claims.push(coerceTaxClaim({ relief: 'medical', amount: 350, date: d(6), note: 'Dental scaling' }));
  save(); renderAll();
});
await p.waitForTimeout(600);

const shot = async (name, keepDialog) => {
  if (!keepDialog) await p.evaluate(() => { if (typeof taxCloseAll === 'function') taxCloseAll(); document.querySelectorAll('dialog[open]').forEach((d) => d.close()); });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  const png = await p.screenshot({ type: 'png' });
  await sharp(png).removeAlpha().png().toFile(`${OUT}/${name}.png`);
  const meta = await sharp(`${OUT}/${name}.png`).metadata();
  console.log(name, `${meta.width}x${meta.height}`, meta.channels, 'channels');
};
const tab = async (t) => { await p.evaluate((x) => { document.getElementById('tabbtn-' + x).click(); scrollTo(0, 0); }, t); await p.waitForTimeout(700); };

// 1. Home: the AI badge beside the wordmark, balance, Add entry.
await tab('dashboard');
await p.evaluate(() => { const b = [...document.querySelectorAll('#tab-dashboard .hero-card summary, #tab-dashboard .hero-card button')].find((x) => /breakdown/i.test(x.textContent)); if (b) b.click(); });
await p.waitForTimeout(800);
await shot('01-home');

// 2. Debts: the payoff plan and when each debt is cleared.
await tab('debts');
await shot('02-payoff');

// 3. Receipt scan: the app's own read (OCR text → checks → the phone's AI
//    fills the date the receipt prints without a year).
const receipt = await ctx.newPage();
await receipt.setViewportSize({ width: 360, height: 600 });
await receipt.setContent(`<body style="margin:0;background:#cfc6b8;display:flex;justify-content:center;padding:20px 0;font:14px/1.45 'Courier New',monospace">
<div style="width:300px;background:#fbfaf6;padding:22px 20px;box-shadow:0 6px 18px rgba(0,0,0,.18);color:#222">
<div style="text-align:center;font-weight:700;font-size:17px">99 SPEED MART</div><div style="text-align:center;font-size:12px">NO. 12, JALAN SS2/24, PJ</div><div style="text-align:center;font-size:12px">SAB 21/11  18:42</div><hr style="border:0;border-top:1px dashed #999">
<div style="display:flex;justify-content:space-between"><span>MILO 3IN1 18S</span><span>12.90</span></div>
<div style="display:flex;justify-content:space-between"><span>GARDENIA ORIGINAL</span><span>4.50</span></div>
<div style="display:flex;justify-content:space-between"><span>TELUR GRED A 10S</span><span>6.00</span></div>
<hr style="border:0;border-top:1px dashed #999">
<div style="display:flex;justify-content:space-between;font-weight:700"><span>JUMLAH RM</span><span>23.40</span></div>
<div style="display:flex;justify-content:space-between"><span>TUNAI</span><span>50.00</span></div>
<div style="display:flex;justify-content:space-between"><span>BAKI</span><span>26.60</span></div>
<div style="text-align:center;margin-top:10px;font-size:12px">TERIMA KASIH</div></div></body>`);
const receiptPng = 'data:image/png;base64,' + (await receipt.screenshot({ type: 'png' })).toString('base64');
await receipt.close();
await tab('dashboard');
await p.evaluate(async (img) => {
  openScanDialog();
  scanPreview.src = img;
  await runReceiptOcr(img, img);
}, receiptPng);
await p.waitForTimeout(1600);
await shot('03-scan', true);
await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));

// 4. Tax: the EA form's figures, each with its line, over the Tax page.
// Last year's page: the EA form a person has in hand is for the year just ended.
await tab('tax');
await p.click('#tax-year-prev');
await p.waitForTimeout(400);
await p.evaluate(() => {
  const y = new Date().getFullYear() - 1;
  taxOpenEa();
  eaShow({ lines: [`PENYATA SARAAN DARIPADA PENGGAJIAN BAGI TAHUN BERAKHIR 31 DISEMBER ${y}`, 'B  PENDAPATAN PENGGAJIAN, MANFAAT DAN TEMPAT KEDIAMAN',
    '1. (a) Gaji kasar, upah atau gaji cuti (termasuk gaji lebih masa)   62,400.00', '(b) Fi (termasuk fi pengarah), komisen atau bonus   5,200.00',
    '(c) Tip kasar, perkuisit, penerimaan sagu hati atau elaun-elaun lain   1,800.00', 'JUMLAH   69,400.00', 'D  JUMLAH POTONGAN',
    '1. Potongan Cukai Bulanan (PCB) yang dibayar kepada LHDNM   2,940.00',
    'E  CARUMAN YANG DIBAYAR OLEH PEKERJA KEPADA KUMPULAN WANG SIMPANAN / PENCEN YANG DILULUSKAN DAN PERKESO',
    '1. Nama Kumpulan Wang: KWSP   7,524.00', '2. PERKESO: Amaun caruman yang wajib dibayar (nyatakan bahagian pekerja sahaja)   296.25', 'SIP   59.40'] });
});
await p.waitForTimeout(700);
await shot('04-tax', true);
await p.evaluate(() => { if (typeof taxCloseAll === 'function') taxCloseAll(); document.querySelectorAll('dialog[open]').forEach((d) => d.close()); });

// 5. Split a bill: one message for all three.
await tab('debts');
await p.evaluate(async () => { await splitOpenShare('r1', 0); });
await p.waitForTimeout(900);
await shot('05-split', true);
await p.evaluate(() => splitCloseDialog(splitShareDialogEl()));

if (process.env.LANDSCAPE) {
  await p.setViewportSize({ width: H, height: W });
  await tab('dashboard');
  await shot('landscape-home');
}
console.log('errors', errs);
await b.close();
