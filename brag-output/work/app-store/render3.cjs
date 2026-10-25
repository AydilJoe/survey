const { chromium } = require('playwright');
const fs = require('fs');
const S = process.argv[2], NAME = process.argv[3];
const CFGS = {
  A: { out: 19.0, caps: [[0,4,"See what's left<br>this month."],[4,8,"Every day,<br>at a glance."],[8,12,"Pay off debt in the<br>smartest order."],[12,16,"Watch your goals<br><em>fill up.</em>"],[16,19,"Hide every ringgit<br>in one tap."]] },
  B: { out: 19.0, caps: [[0,3,"Three debts.<br>One smart order."],[3,9,"Add extra.<br><em>Watch it move.</em>"],[9,13,"See when each<br>debt clears."],[13,19,"Less interest.<br><em>Debt-free sooner.</em>"]] },
  C: { out: 19.0, caps: [[0,4,"Locked with<br>your passcode."],[4,8,"Encrypted on<br>this phone."],[8,11,"Hide every ringgit<br>in one tap."],[11,15,"Back up or move<br>your data anytime."],[15,19,"Light or dark.<br><em>Your call.</em>"]] },
};
const d = JSON.parse(fs.readFileSync(`${S}/work3/${NAME}/frames.json`));
const meta = d.meta.map(m => ({ i: m.i, a: m.ts - d.base }));
const frameAt = a => { let r = 0; for (const m of meta) { if (m.a <= a) r = m.i; else break; } return r; };
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 886, height: 1920 } });
  await page.goto('http://localhost:8912/comp/comp3.html');
  await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400);
  await page.evaluate(c => setup(c), CFGS[NAME]);
  const out = `${S}/work3/${NAME}/out`; fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const N = 22 * 30;
  for (let f = 0; f < N; f++) {
    const t = f / 30;
    const src = `http://localhost:8912/work3/${NAME}/frames/f${String(frameAt(Math.min(t, 19.0))).padStart(5, '0')}.jpg`;
    await page.evaluate(async ({ t, src }) => { renderAt(t, src); const im = document.getElementById('app'); try { await im.decode(); } catch (e) {} }, { t, src });
    await page.screenshot({ path: `${out}/c${String(f).padStart(4, '0')}.jpg`, type: 'jpeg', quality: 93 });
  }
  await b.close();
})();
