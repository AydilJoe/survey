// Lifecycle test for remote announcements: shows once → seen → mute works.
// Stubs https://duitful.app/announcements.json via route interception.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const REPO_ROOT = 'C:/Users/Aydil Johari/StudioProjects/survey';
const PORT = 8896;
const BASE = `http://localhost:${PORT}`;

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO_ROOT, stdio: 'ignore' });
const deadline = Date.now() + 10000;
let up = false;
while (Date.now() < deadline && !up) {
  try { up = (await fetch(`${BASE}/app/index.html`)).ok; }
  catch { await new Promise(r => setTimeout(r, 200)); }
}
if (!up) { server.kill(); throw new Error('server did not come up'); }

const b = await chromium.launch();
const page = await b.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

let feed = { messages: [] };
await page.route('**/announcements.json*', route =>
  route.fulfill({ contentType: 'application/json', body: JSON.stringify(feed) }));

const log = (...a) => console.log(...a);

// Boot + unlock
await page.goto(`${BASE}/app/index.html`);
await page.waitForTimeout(500);
await page.fill('#lock-input', 'test1234');
if (await page.locator('#lock-confirm').isVisible()) await page.fill('#lock-confirm', 'test1234');
await page.click('#lock-submit');
await page.waitForTimeout(1200);
await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close()));
await page.waitForTimeout(300);

const openAnnounce = () => page.evaluate(() => checkAnnouncements());
const dialogOpen = () => page.locator('#announce-dialog[open]').count();

// 1. Message shows
feed = { messages: [{ id: 'test-1', enabled: true, title: 'Hello from test', body: ['Para one.', 'Para two.'], cta_label: 'Open site', cta_url: 'https://duitful.app/' }] };
await openAnnounce();
await page.waitForTimeout(400);
log('1. shows when enabled:', (await dialogOpen()) === 1);
log('   title:', await page.locator('#announce-title').textContent());
log('   paragraphs:', await page.locator('#announce-body p').count());
log('   CTA visible:', await page.locator('#announce-cta').isVisible());

// 2. Dismiss -> marked seen -> same id never re-shows
await page.locator('#announce-dialog button[value="ok"]').click();
await page.waitForTimeout(200);
await openAnnounce();
await page.waitForTimeout(400);
log('2. same id after dismiss does NOT re-show:', (await dialogOpen()) === 0);
log('   seen ids:', await page.evaluate(() => localStorage.getItem('duitful-announce-seen')));

// 3. NEW id -> shows again
feed = { messages: [{ id: 'test-2', enabled: true, title: 'Second message', body: ['New announcement.'] }] };
await openAnnounce();
await page.waitForTimeout(400);
log('3. new id shows:', (await dialogOpen()) === 1);
log('   CTA hidden when none given:', !(await page.locator('#announce-cta').isVisible()));

// 4. Tick "don't show again" -> mute
await page.locator('#announce-mute').check();
await page.locator('#announce-dialog button[value="ok"]').click();
await page.waitForTimeout(200);
log('4. muted flag set:', await page.evaluate(() => localStorage.getItem('duitful-announce-muted')));
log('   settings toggle unchecked:', !(await page.locator('#pref-announcements').isChecked()));

// 5. Third message must NOT show while muted
feed = { messages: [{ id: 'test-3', enabled: true, title: 'Should be muted', body: ['x'] }] };
await openAnnounce();
await page.waitForTimeout(400);
log('5. muted -> new message does NOT show:', (await dialogOpen()) === 0);

// 6. Re-enable via settings toggle -> message shows again
await page.evaluate(() => { document.getElementById('pref-announcements').checked = true; document.getElementById('pref-announcements').dispatchEvent(new Event('change')); });
await openAnnounce();
await page.waitForTimeout(400);
log('6. unmuted via Settings -> shows again:', (await dialogOpen()) === 1);

log('JS errors:', errors.length ? errors : '(none)');
await b.close();
server.kill();
