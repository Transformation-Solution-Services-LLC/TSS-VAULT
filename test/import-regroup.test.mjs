// Moving from Regroup: the directory, progress notes and activity notes come
// in from Regroup's exported files (Excel, CSV or JSON), each note to its
// client, never twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';
process.env.VAULT_SERVICE_TOKEN = 'vault-svc';

const { createApp } = await import('../server.js');
const { MemoryStore } = await import('../lib/store-memory.js');
const { readTableFile } = await import('../lib/sheet-file.js');
const { fakeCockpit } = await import('./cockpit-fixture.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const XLSX = fs.readFileSync(path.join(here, 'fixtures', 'regroup-export.xlsx'));
const TODAY = '2026-11-03';

async function setup() {
  const store = new MemoryStore();
  const cockpit = fakeCockpit('vault');
  const app = createApp({ store, verifyTicket: cockpit.verifyTicket, clock: () => TODAY });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const signIn = async (claims) => (await call('POST', '/api/auth/cockpit', { ticket: cockpit.ticket(claims) })).body.token;
  const manager = await signIn({ sub: 'u-mgr', name: 'Morgan', permissions: ['use', 'manage'] });
  const reader = await signIn({ sub: 'u-ray', name: 'Ray', permissions: ['use'] });
  const other = await signIn({ sub: 'u-b', name: 'Bea', org: { id: 'org-b', name: 'Org B' }, permissions: ['use', 'manage'] });
  const ok = async (method, p, body, token = manager, expect = 200) => {
    const r = await call(method, p, body, token);
    assert.equal(r.status, expect, `${method} ${p}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  return { store, call, manager, reader, other, ok, close: () => server.close() };
}

const read = (t, sheet) => t.ok('POST', '/api/import/read', { name: 'regroup-export.xlsx', data: XLSX.toString('base64'), sheet });
const importAll = async (t, route, csv, token) => {
  const p = await t.ok('POST', `/api/import/${route}/preview`, { csv }, token);
  return { p, run: (extra = {}) => t.ok('POST', `/api/import/${route}`, { csv, mapping: p.mapping, ...extra }, token) };
};

test('an Excel file is read sheet by sheet, with dates as dates', () => {
  const r = readTableFile({ name: 'export.XLSX', data: XLSX });
  assert.deepEqual(r.sheets, ['Directory', 'Progress Notes', 'Activity Notes']);
  assert.equal(r.sheet, 'Directory');
  assert.match(r.csv, /^Client ID,Client Name,DOB,Email,Case Manager\r\nR-1,"Reyes, Ana",2010-05-04,ana@example.org,Dana\r\n/);
  const notes = readTableFile({ name: 'export.xlsx', data: XLSX, sheet: 'Progress Notes' });
  assert.match(notes.csv, /11,R-1,Ana Reyes,2026-10-01 14:30,"Met at school.\nGood week.",Dana/);
  assert.throws(() => readTableFile({ name: 'old.xls', data: Buffer.from('x') }), /old Excel file/);
  assert.throws(() => readTableFile({ name: 'broken.xlsx', data: Buffer.from('not a zip') }), /could not be read/);
});

test('JSON and tab-separated files are read as tables', () => {
  const json = readTableFile({ name: 'export.json', data: Buffer.from(JSON.stringify({ data: { clients: [{ id: 'R-1', name: 'Ana', contact: { phone: '541' }, tags: ['a', 'b'] }, { id: 'R-2', name: 'Ben', email: 'b@x.org' }] } })) });
  assert.deepEqual(json.sheets, ['data.clients']);
  assert.equal(json.csv, 'id,name,contact.phone,tags,email\r\nR-1,Ana,541,a; b,\r\nR-2,Ben,,,b@x.org\r\n');
  const tsv = readTableFile({ name: 'export.tsv', data: Buffer.from('Name\tDate\nAna, R\t2026-10-01\n') });
  assert.equal(tsv.csv, 'Name,Date\r\n"Ana, R",2026-10-01\r\n');
  assert.throws(() => readTableFile({ name: 'x.json', data: Buffer.from('{oops') }), /could not be read/);
});

test('Regroup directory, progress notes and activity notes import, each note to its client, never twice', async () => {
  const t = await setup();
  try {
    assert.equal((await t.call('POST', '/api/import/read', { name: 'a.xlsx', data: XLSX.toString('base64') }, t.reader)).status, 403, 'managers only');
    assert.equal((await t.call('POST', '/api/import/progress-notes', { csv: 'a\n1' }, t.reader)).status, 403);

    // 1. The directory, keeping the Regroup id.
    const dir = await read(t, 'Directory');
    const d = await importAll(t, 'clients', dir.csv);
    assert.equal(d.p.mapping.external_id, 0, '"Client ID" is the id in the old system');
    assert.equal((await d.run()).added, 3);

    // 2. Progress notes.
    const prog = await read(t, 'Progress Notes');
    const pn = await importAll(t, 'progress-notes', prog.csv);
    assert.deepEqual(pn.p.need_one[0].ids.includes('client_ref'), true);
    assert.deepEqual([pn.p.mapping.note_ref, pn.p.mapping.client_ref, pn.p.mapping.client_name, pn.p.mapping.date, pn.p.mapping.body, pn.p.mapping.author], [0, 1, 2, 3, 4, 5]);
    const dry = await pn.run({ dry_run: true });
    assert.deepEqual(dry.plan.map((x) => x.action), ['add', 'add', 'skip', 'skip', 'skip']);
    assert.match(dry.plan[2].reason, /2 clients are named Ana Reyes/);
    assert.match(dry.plan[3].reason, /import the directory first/);
    assert.match(dry.plan[4].reason, /future/);
    assert.equal((await t.ok('GET', '/api/notes')).notes.length, 0, 'a dry run writes nothing');
    const run = await pn.run();
    assert.deepEqual([run.added, run.unchanged, run.skipped.length], [2, 0, 3]);
    const notes = (await t.ok('GET', '/api/notes')).notes;
    const ana = notes.find((n) => n.client_name.startsWith('Ana'));
    assert.equal(ana.date, '2026-10-01');
    assert.equal(ana.kind, 'progress');
    assert.equal(ana.body, 'Met at school.\nGood week.');
    assert.equal(ana.created_by, 'Dana', 'the author from Regroup');
    assert.equal(ana.imported_from, 'Regroup');
    assert.equal(ana.can_strike, true, 'an imported note can be struck, never edited');
    const again = await pn.run();
    assert.deepEqual([again.added, again.unchanged], [0, 2], 'the same file twice adds nothing');

    // 3. Activity notes: their own kind; the type sets the kind where it can and is kept in the note.
    const act = await read(t, 'Activity Notes');
    const an = await importAll(t, 'activity-notes', act.csv);
    assert.deepEqual([an.p.mapping.note_ref, an.p.mapping.client_ref, an.p.mapping.date, an.p.mapping.type, an.p.mapping.title, an.p.mapping.body, an.p.mapping.duration, an.p.mapping.author], [0, 1, 2, 3, 4, 5, 6, 7]);
    const ar = await an.run();
    assert.equal(ar.added, 2);
    const acts = (await t.ok('GET', '/api/notes')).notes.filter((n) => n.body.includes('Bowling') || n.body.includes('mom'));
    const call = acts.find((n) => n.body.includes('mom'));
    assert.equal(call.kind, 'contact', 'a phone call is a contact');
    assert.equal(call.body, 'Check-in\nType: Phone Call\nDuration: 15\nTalked with mom.');
    const outing = acts.find((n) => n.body.includes('Bowling'));
    assert.equal(outing.kind, 'activity');
    assert.equal(outing.body, 'Bowling\nType: Group outing\nDuration: 120\nCame along.');
    assert.equal(outing.created_by, 'Morgan', 'no author in the file: the person importing');
    assert.equal(outing.date, '2026-10-06');

    // The log says what came in; another organization sees none of it.
    assert.ok((await t.store.activity('org-a')).some((a) => a.action === 'import.notes' && /from Regroup/.test(a.detail)));
    assert.equal((await t.ok('GET', '/api/notes', null, t.other)).notes.length, 0);
  } finally { t.close(); }
});

test('a notes import needs a date, the note and the client, and refuses without them', async () => {
  const t = await setup();
  try {
    assert.equal((await t.call('POST', '/api/import/progress-notes', { csv: 'Foo,Bar\n1,2\n', mapping: {} }, t.manager)).status, 400);
    assert.equal((await t.call('POST', '/api/import/progress-notes', { csv: 'Date,Note\n2026-10-01,x\n' }, t.manager)).body.code, 'mapping_needed');
    await t.ok('POST', '/api/clients', { first_name: 'Cy', last_name: 'Day', email: 'cy@example.org' }, t.manager, 201);
    const r = await t.ok('POST', '/api/import/progress-notes', { csv: 'Email,Date,Note\nCY@example.org,3/31/2026,Hello\nCY@example.org,,No date\nCY@example.org,soon,Bad date\nCY@example.org,2026-04-01,\n' });
    assert.equal(r.added, 1);
    assert.deepEqual(r.skipped.map((s) => s.reason), ['No date', 'The date "soon" could not be read', 'No note text']);
  } finally { t.close(); }
});
