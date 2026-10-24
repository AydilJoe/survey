const { chromium } = require('playwright');
const fs = require('fs');
const S = process.argv[2];
const d = JSON.parse(fs.readFileSync(S + '/work2/frames.json'));
const meta = d.meta.map(m => ({ i: m.i, a: m.ts - d.base }));
const frameAt = a => { let r = 0; for (const m of meta) { if (m.a <= a) r = m.i; else break; } return r; };
const only = process.argv[3] ? process.argv[3].split(',').map(Number) : null;
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.goto('http://localhost:8912/comp/comp2.html');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  const out = S + '/work2/out'; fs.mkdirSync(out, { recursive: true });
  const N = 600;
  const list = only || [...Array(N).keys()];
  for (const f of list) {
    const t = f === 0 ? 19.6 : f / 30;
    const a = Math.max(0, Math.min(t - 4, 12.2));
    const src = `http://localhost:8912/work2/frames/f${String(frameAt(a)).padStart(5, '0')}.jpg`;
    await page.evaluate(async ({ t, src }) => { renderAt(t, src); const im = document.getElementById('app'); if (im.src) { try { await im.decode(); } catch (e) {} } }, { t, src });
    await page.screenshot({ path: `${out}/c${String(f).padStart(4, '0')}.jpg`, type: 'jpeg', quality: 93 });
  }
  await b.close();
})();
