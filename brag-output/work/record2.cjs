const { boot } = require('./setup.cjs');
const fs = require('fs');
const S = process.argv[2];
const FR = S + '/work2/frames';
fs.rmSync(FR, { recursive: true, force: true }); fs.mkdirSync(FR, { recursive: true });
(async () => {
  const { b, page } = await boot();
  const cdp = await page.context().newCDPSession(page);
  const meta = []; let n = 0;
  cdp.on('Page.screencastFrame', async f => {
    const i = n++;
    fs.writeFileSync(`${FR}/f${String(i).padStart(5, '0')}.jpg`, Buffer.from(f.data, 'base64'));
    meta.push({ i, ts: f.metadata.timestamp, w: f.metadata.deviceWidth });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  // touch indicator
  await page.evaluate(() => {
    const f = document.createElement('div');
    f.id = 'finger';
    f.style.cssText = 'position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;background:rgba(36,31,26,.28);border:2px solid rgba(255,255,255,.85);box-shadow:0 2px 10px rgba(0,0,0,.2);z-index:99999;pointer-events:none;opacity:0;transform:translate(270px,700px) scale(1);transition:transform .32s cubic-bezier(.3,.1,.2,1),opacity .2s;';
    document.body.appendChild(f);
  });
  await page.click('#tabbtn-debts'); await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(600);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: 1080, maxHeight: 1920, everyNthFrame: 1 });
  const base = Date.now() / 1000;
  const wait = a => { const d = (base + a - Date.now() / 1000) * 1000; return d > 0 ? page.waitForTimeout(d) : null; };
  const log = [];
  const center = async sel => { const bb = await page.locator(sel).first().boundingBox(); return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }; };
  const tap = async (a, sel, opts = {}) => {
    await wait(a - 0.34);
    const c = await center(sel);
    await page.evaluate(({ x, y }) => { const f = document.getElementById('finger'); f.style.opacity = '1'; f.style.transform = `translate(${x}px,${y}px) scale(1)`; }, c);
    await wait(a);
    await page.evaluate(() => { const f = document.getElementById('finger'); f.style.transform += ' scale(.78)'; setTimeout(() => f.style.transform = f.style.transform.replace(' scale(.78)', ''), 140); });
    await page.touchscreen.tap(c.x, c.y);
    log.push({ a, sel });
  };
  const hideFinger = () => page.evaluate(() => document.getElementById('finger').style.opacity = '0');
  const type = async (a, text) => { await wait(a); await page.keyboard.type(text, { delay: 140 }); await page.evaluate(() => document.activeElement && document.activeElement.blur()); };
  const scroll = async (a, top) => { await wait(a); await page.evaluate(t => window.scrollTo({ top: t, behavior: 'smooth' }), top); };
  const reset = async () => { await page.waitForTimeout(80); await page.evaluate(() => window.scrollTo(0, 0)); };

  // --- Debts: avalanche
  await scroll(1.5, 9999);
  await tap(3.0, '#extra-monthly');
  await type(3.3, '100');
  await tap(4.9, '#extra-monthly');
  await page.keyboard.press('Control+a');
  await type(5.15, '300');
  await hideFinger();
  await scroll(7.0, 9999);
  await scroll(7.1, 9999);
  await scroll(10.0, 330);
  await wait(12.4);
  await cdp.send('Page.stopScreencast');
  fs.writeFileSync(S + '/work2/frames.json', JSON.stringify({ base, meta, log }));
  console.log('frames', n, 'span', meta.at(-1).ts - base, 'w', meta[0].w);
  await page.screenshot({ path: S + '/work2/final-state.png' });
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
