// Case notes on a phone with no signal, end to end in a real browser
// (Chromium through Playwright, at a phone's size): a staff member opens
// Vault from Cockpit, loses the signal, writes a note from a client's page
// and another from Case Notes, reloads the app with no signal (the cached
// shell opens it and the notes are still listed), and comes back online.
// Both notes reach the server once each, and nothing waits on the phone.
//
// Runs where Playwright and its Chromium are installed (CI job "mobile",
// .github/workflows/ci.yml); elsewhere it is skipped, unless REQUIRE_BROWSER
// is set, when a missing browser fails it. SCREENSHOT_DIR keeps a phone
// screenshot of each step.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';
delete process.env.DATABASE_URL;

const require = createRequire(import.meta.url);
let pw = null; try { pw = require('playwright'); } catch { pw = null; }
if (!pw && process.env.REQUIRE_BROWSER) throw new Error('REQUIRE_BROWSER is set and Playwright is not installed');
const SHOTS = process.env.SCREENSHOT_DIR || null;

const { createApp } = await import('../server.js');
const { MemoryStore } = await import('../lib/store-memory.js');
const { fakeCockpit } = await import('./cockpit-fixture.mjs');

const store = new MemoryStore();
const cockpit = fakeCockpit('vault');
let server; let base; let browser;
before(async () => {
  if (!pw) return;
  server = await new Promise((r) => { const s = createApp({ store, verifyTicket: cockpit.verifyTicket }).listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

// Polls a check in the page. Not page.waitForFunction: older Playwright runs that through eval, which the app's Content-Security-Policy refuses.
async function waitUntil(page, fn, _arg = null, { timeout = 15000 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn).catch(() => false)) return;
    if (Date.now() > end) throw new Error(`waitUntil: timed out after ${timeout} ms: ${fn}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `vault-${name}.png`) }); } };
const api = async (method, p, body, token) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};

test('a phone with no signal: case notes wait on the phone, survive a reload, and reach the server once each', { skip: !pw && 'Playwright is not installed' }, async () => {
  const manager = (await api('POST', '/api/auth/cockpit', { ticket: cockpit.ticket({ permissions: ['use', 'manage'] }) })).token;
  const ana = await api('POST', '/api/clients', { first_name: 'Ana', last_name: 'Reyes', program: 'Youth mentoring', assigned_to: 'Ray' }, manager);
  const ben = await api('POST', '/api/clients', { first_name: 'Ben', last_name: 'Ito', program: 'Reentry' }, manager);

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));

  // Opened from Cockpit, with signal: the home page, and the app shell installs.
  await page.goto(`${base}/#tss_launch=${encodeURIComponent(cockpit.ticket({ sub: 'u-ray', name: 'Ray', permissions: ['use'] }))}`);
  await page.waitForSelector('.door');
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) { await page.reload(); await page.waitForSelector('.door'); }
  assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'the page is under the app shell worker');
  assert.equal(await page.$eval('.nav', (n) => getComputedStyle(n).position), 'fixed', 'the menu is a bar along the bottom on a phone');
  await shot(page, '1-home');

  await page.goto(`${base}/#/directory`); await page.waitForSelector('tr[data-href]');
  await shot(page, '2-directory');
  await page.goto(`${base}/#/directory/${ana.id}`); await page.waitForSelector('#note');

  // The signal goes. A note from Ana's page.
  await context.setOffline(true);
  await page.click('#note');
  await page.fill('#f textarea[name="body"]', 'Met at the bus stop. Calm, ready for Thursday.');
  await shot(page, '3-note-offline');
  await page.click('#f button.primary, #f button[type="submit"]');
  await waitUntil(page, () => /saved on this phone/.test(document.querySelector('#toast')?.textContent || ''));
  await page.waitForSelector('#pending');
  assert.equal(await page.textContent('.nav [data-pending]'), '1');

  // A second from Case Notes, picking Ben from the clients the phone already loaded.
  await page.goto(`${base}/#/notes`); await page.waitForSelector('.no-signal #add');
  await page.click('#add');
  await page.fill('#f input[name="client_search"]', 'Ben');
  await page.click('#client-hits button');
  await page.fill('#f textarea[name="body"]', 'Phone call. Has the job interview Monday.');
  await page.click('#f button.primary, #f button[type="submit"]');
  await waitUntil(page, () => document.querySelector('.nav [data-pending]')?.textContent === '2');
  await shot(page, '4-waiting-offline');

  // The app reloads with no signal: the cached shell opens it, and the notes are still listed.
  await page.reload();
  await page.waitForSelector('#pending');
  assert.equal(await page.locator('#pending .timeline li').count(), 2);
  await shot(page, '5-reload-offline');
  assert.equal((await store.listNotes('org-a')).length, 0, 'nothing reached the server yet');

  // The signal comes back: both go out, once each.
  // The browser says it is online a moment before the server answers, as on a slow signal: the app keeps trying by itself.
  let slow = true; await context.route('**/api/**', (r) => (slow ? r.abort('internetdisconnected') : r.continue()));
  await context.setOffline(false);
  setTimeout(() => { slow = false; }, 1500);
  await waitUntil(page, () => !document.querySelector('#pending') && !document.querySelector('.no-signal') && document.querySelectorAll('#view .timeline li').length === 2, null, { timeout: 20000 });
  await context.unroute('**/api/**');
  const notes = await store.listNotes('org-a');
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((n) => n.client_id).sort(), [ana.id, ben.id].sort());
  assert.ok(notes.every((n) => n.created_by === 'Ray'));
  assert.equal(await page.evaluate(() => document.querySelector('.nav [data-pending]').hidden), true);
  await page.goto(`${base}/#/notes`); await page.waitForSelector('.timeline li');
  await shot(page, '6-synced');
  assert.deepEqual(errors, [], 'no script errors on the page');
  await context.close();
});
