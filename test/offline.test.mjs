// Case notes written with no signal: the phone's rules (public/offline.js),
// the app shell worker's rules (public/sw.js), the manifest, and the server
// taking a note with the phone's id once, however often it is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';

const { createApp } = await import('../server.js');
const { MemoryStore } = await import('../lib/store-memory.js');
const { fakeCockpit } = await import('./cockpit-fixture.mjs');
const rules = await import('../public/offline.js');

const TODAY = '2026-11-03';
const pub = (f) => new URL(`../public/${f}`, import.meta.url);

test('the phone keeps a note with its own id and sends only the note', () => {
  const e = rules.newEntry({ userId: 'u-ray', client: { id: 'c1', name: 'Ana Reyes' }, note: { date: TODAY, kind: 'progress', body: 'Met at school', extra: 'x' }, now: Date.parse('2026-11-03T10:00:00Z'), id: 'n1' });
  assert.equal(e.status, 'waiting');
  assert.deepEqual(rules.toSend(e), { id: 'n1', date: TODAY, kind: 'progress', body: 'Met at school' });
  assert.equal(rules.isNetworkError(new TypeError('Failed to fetch')), true, 'no answer at all is no signal');
  assert.equal(rules.isNetworkError(Object.assign(new Error('Client is archived'), { status: 409 })), false, 'an answer is never retried as no signal');
  assert.equal(rules.settle(e, { ok: true }), null, 'written: it leaves the phone');
  const r = rules.settle(e, { ok: false, reason: 'Client not found' });
  assert.equal(r.status, 'refused'); assert.equal(r.reason, 'Client not found'); assert.equal(r.note.body, 'Met at school', 'what was typed is kept');
  const old = { ...e, createdAt: '2026-10-20T10:00:00Z' };
  assert.equal(rules.expired(old, Date.parse('2026-11-03T10:00:00Z')), true, 'dropped after 7 days');
  assert.equal(rules.expired(e, Date.parse('2026-11-03T10:00:00Z')), false);
  const later = { ...e, id: 'n2', createdAt: '2026-11-03T11:00:00Z' };
  assert.deepEqual(rules.waitingOf([later, r, e]).map((x) => x.id), ['n1', 'n2'], 'refused notes wait on the person, in order');
});

test('the app shell worker caches the shell only, never /api/, and keys the cache by release', () => {
  const sandbox = { self: { location: { href: 'https://vault.example/sw.js?v=abc123', origin: 'https://vault.example' }, addEventListener() {} }, URL };
  vm.runInNewContext(fs.readFileSync(pub('sw.js'), 'utf8'), sandbox);
  const s = sandbox.self.shellRules;
  assert.equal(s.CACHE, 'tss-vault-shell-abc123');
  for (const f of s.SHELL) assert.ok(f === '/' || fs.existsSync(pub(f.slice(1))), `${f} exists`);
  assert.equal(s.shouldCache('https://vault.example/app.js'), true);
  assert.equal(s.shouldCache('https://vault.example/api/clients'), false);
  assert.equal(s.shouldCache('https://vault.example/sw.js'), false);
  assert.equal(s.shouldCache('https://elsewhere.example/app.js'), false);
  assert.equal(s.fallbackKey({ mode: 'navigate', url: 'https://vault.example/#/notes' }), '/');
  assert.equal(s.fallbackKey({ mode: 'navigate', url: 'https://vault.example/api/export' }), null);
  assert.equal(s.fallbackKey({ mode: 'cors', url: 'https://vault.example/api/notes' }), null);
});

test('Vault installs as an app: manifest, icons and the page links', () => {
  const m = JSON.parse(fs.readFileSync(pub('manifest.webmanifest'), 'utf8'));
  assert.equal(m.name, 'Vault'); assert.equal(m.display, 'standalone'); assert.match(m.start_url, /#\/notes$/);
  for (const i of m.icons) assert.ok(fs.existsSync(pub(i.src.replace(/^\//, ''))), i.src);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  const html = fs.readFileSync(pub('index.html'), 'utf8');
  assert.match(html, /rel="manifest"/); assert.match(html, /apple-touch-icon/); assert.match(html, /viewport-fit=cover/);
  assert.match(html, /data-pending/, 'Case Notes shows how many notes wait');
  assert.doesNotMatch(fs.readFileSync(pub('styles.css'), 'utf8').match(/@media \(max-width: ?760px\)[\s\S]*/)?.[0] || '', /^$/, 'a phone layout exists');
});

test('a note sent with the phone\'s id is written once, however often it is sent', async () => {
  const store = new MemoryStore();
  const cockpit = fakeCockpit('vault');
  const app = createApp({ store, verifyTicket: cockpit.verifyTicket, clock: () => TODAY });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const signIn = async (claims) => (await call('POST', '/api/auth/cockpit', { ticket: cockpit.ticket(claims) })).body.token;
  try {
    const manager = await signIn({ permissions: ['use', 'manage'] });
    const ray = await signIn({ sub: 'u-ray', name: 'Ray', permissions: ['use'] });
    const kim = await signIn({ sub: 'u-kim', name: 'Kim', permissions: ['use'] });
    const other = await signIn({ sub: 'u-b', name: 'Bea', org: { id: 'org-b', name: 'Org B' }, permissions: ['use', 'manage'] });
    const ana = (await call('POST', '/api/clients', { first_name: 'Ana', last_name: 'Reyes' }, manager)).body;
    const ben = (await call('POST', '/api/clients', { first_name: 'Ben', last_name: 'Ito' }, manager)).body;
    const id = crypto.randomUUID();
    const note = { id, date: TODAY, kind: 'progress', body: 'Met at the bus stop.' };

    const first = await call('POST', `/api/clients/${ana.id}/notes`, note, ray);
    assert.equal(first.status, 201); assert.equal(first.body.id, id, 'the phone\'s id is the note\'s id');
    const again = await call('POST', `/api/clients/${ana.id}/notes`, note, ray);
    assert.equal(again.status, 200); assert.equal(again.body.duplicate, true, 'a resend is the same note');
    assert.equal((await call('GET', `/api/clients/${ana.id}`, null, ray)).body.notes.length, 1, 'written once');

    assert.equal((await call('POST', `/api/clients/${ana.id}/notes`, note, kim)).status, 409, 'someone else cannot reuse the id');
    assert.equal((await call('POST', `/api/clients/${ben.id}/notes`, note, ray)).status, 409, 'nor on another client');
    assert.equal((await call('POST', `/api/clients/${ana.id}/notes`, { ...note, id: 'not-a-uuid' }, ray)).status, 400);
    assert.equal((await call('POST', `/api/clients/${ana.id}/notes`, note, other)).status, 404, 'another organization never sees the client');

    const activity = (await call('GET', '/api/activity', null, manager)).body.activity;
    assert.equal(activity.filter((a) => a.action === 'note.add').length, 1);
    assert.match(activity.find((a) => a.action === 'note.add').detail || JSON.stringify(activity[0]), /written offline/);

    const late = await call('POST', `/api/clients/${ana.id}/notes`, { ...note, id: crypto.randomUUID(), date: '2026-11-04' }, ray);
    assert.equal(late.status, 400, 'a refused note gets an answer, so the phone keeps it with the reason');
    assert.match(late.body.error, /future/);
    const me = (await call('GET', '/api/me', null, ray)).body;
    assert.ok(me.release, 'the release keys the phone\'s shell cache');
  } finally { server.close(); }
});
