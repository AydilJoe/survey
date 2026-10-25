const { boot } = require('./setup3.cjs');
const fs = require('fs');
const S = process.argv[2], NAME = process.argv[3];
const FR = `${S}/work3/${NAME}/frames`;
fs.rmSync(`${S}/work3/${NAME}`, { recursive: true, force: true }); fs.mkdirSync(FR, { recursive: true });
const END = { A: 19.2, B: 19.2, C: 19.2 }[NAME];
(async () => {
  const { b, page } = await boot(S);
  if (NAME === 'C') { await page.reload(); await page.waitForTimeout(1200); }
  if (NAME === 'B') { await page.click('#tabbtn-debts'); await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(600); }
  const cdp = await page.context().newCDPSession(page);
  const meta = []; let n = 0;
  cdp.on('Page.screencastFrame', async f => {
    const i = n++;
    fs.writeFileSync(`${FR}/f${String(i).padStart(5, '0')}.jpg`, Buffer.from(f.data, 'base64'));
    meta.push({ i, ts: f.metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await page.evaluate(() => {
    const f = document.createElement('div'); f.id = 'finger';
    f.style.cssText = 'position:fixed;left:0;top:0;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;background:rgba(36,31,26,.28);border:2px solid rgba(255,255,255,.85);box-shadow:0 2px 10px rgba(0,0,0,.2);z-index:99999;pointer-events:none;opacity:0;transform:translate(220px,600px);transition:transform .32s cubic-bezier(.3,.1,.2,1),opacity .2s;';
    document.body.appendChild(f);
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: 886, maxHeight: 1600, everyNthFrame: 1 });
  const base = Date.now() / 1000;
  const wait = a => { const d = (base + a - Date.now() / 1000) * 1000; return d > 0 ? page.waitForTimeout(d) : null; };
  const log = [];
  const center = async sel => { const bb = await page.locator(sel).first().boundingBox(); return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }; };
  const tap = async (a, sel) => {
    await wait(a - 0.34);
    const c = await center(sel);
    await page.evaluate(({ x, y }) => { const f = document.getElementById('finger'); f.style.opacity = '1'; f.style.transform = `translate(${x}px,${y}px)`; }, c);
    await wait(a);
    await page.evaluate(() => { const f = document.getElementById('finger'); const t = f.style.transform; f.style.transform = t + ' scale(.78)'; setTimeout(() => f.style.transform = t, 140); });
    await page.touchscreen.tap(c.x, c.y);
    log.push({ a, sel });
  };
  const hide = () => page.evaluate(() => document.getElementById('finger').style.opacity = '0');
  const type = async (a, text) => { await wait(a); await page.keyboard.type(text, { delay: 140 }); await page.evaluate(() => document.activeElement && document.activeElement.blur()); };
  const scroll = async (a, top) => { await wait(a); await page.evaluate(t => window.scrollTo({ top: t, behavior: 'smooth' }), top); };
  const scrollTo = async (a, sel, off = 230) => { await wait(a); const bb = await page.locator(sel).first().boundingBox(); await page.evaluate(t => window.scrollTo({ top: t, behavior: 'smooth' }), Math.max(0, await page.evaluate(() => scrollY) + bb.y - off)); };
  const reset = async () => { await page.waitForTimeout(80); await page.evaluate(() => window.scrollTo(0, 0)); };
  const SAV = '#tab-savings input[placeholder="Amount"]:visible', SAVB = '#tab-savings .saving-actions button.primary';

  if (NAME === 'A') {
    await scroll(0.75, 9999);
    await tap(1.5, '#form-daily input[name="amount"]'); await type(1.8, '12');
    await tap(2.6, '#form-daily button[type="submit"]'); await hide();
    await scroll(3.0, 0);
    await tap(4.0, '#tabbtn-flow'); await reset();
    await tap(5.5, 'text=842'); await hide();
    await tap(8.0, '#tabbtn-debts'); await reset();
    await scrollTo(8.9, '#extra-monthly');
    await tap(10.0, '#extra-monthly'); await type(10.3, '300'); await hide();
    await tap(12.0, '#tabbtn-savings'); await reset();
    await tap(12.75, SAV); await type(13.05, '500');
    await tap(14.0, SAVB); await hide();
    await tap(16.0, '#tabbtn-dashboard'); await reset();
    await tap(16.75, '#btn-privacy'); await hide();
  } else if (NAME === 'B') {
    await scrollTo(2.0, '#extra-monthly');
    await tap(3.5, '#extra-monthly'); await type(3.8, '100');
    await tap(6.0, '#extra-monthly'); await page.evaluate(() => document.activeElement && document.activeElement.select && document.activeElement.select()); await type(6.3, '300'); await hide();
    await scrollTo(9.0, 'text=When each debt is cleared', 120);
    await scrollTo(13.0, '#extra-monthly');
  } else if (NAME === 'C') {
    await tap(1.5, '#lock-input'); await type(1.8, '4821');
    await tap(3.0, '#lock-submit'); await hide();
    await wait(4.2); await page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach(d => d.close()); document.querySelectorAll('#tab-data h2, #tab-data h3').forEach(h => { if (/Cloud backup|Duitful Pro|Currency rates|Reminders|Danger zone/.test(h.textContent)) (h.closest('section, .card') || h.parentElement).style.display = 'none'; }); });
    await tap(8.0, '#btn-privacy');
    await tap(10.4, '#btn-privacy');
    await tap(11.0, '#tabbtn-data'); await reset();
    await scroll(12.2, 140); await scroll(14.0, 0);
    await tap(15.5, 'text=Dark'); await hide();
    await tap(17.5, '#tabbtn-dashboard'); await reset(); await hide();
  }
  await wait(END);
  await cdp.send('Page.stopScreencast');
  fs.writeFileSync(`${S}/work3/${NAME}/frames.json`, JSON.stringify({ base, meta, log }));
  console.log(NAME, 'frames', n, 'span', (meta.at(-1).ts - base).toFixed(2));
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
