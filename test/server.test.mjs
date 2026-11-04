import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';
process.env.VAULT_SERVICE_TOKEN = 'vault-svc';
process.env.EXPORT_TOKEN = 'vault-export';

const { createApp } = await import('../server.js');
const { MemoryStore } = await import('../lib/store-memory.js');
const { fakeCockpit } = await import('./cockpit-fixture.mjs');

const TODAY = '2026-11-03';

async function setup() {
  const store = new MemoryStore();
  const cockpit = fakeCockpit('vault');
  const app = createApp({ store, verifyTicket: cockpit.verifyTicket, clock: () => TODAY });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, token, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const type = r.headers.get('content-type') || '';
    const text = await r.text();
    return { status: r.status, type, headers: r.headers, text, body: type.includes('json') && text ? JSON.parse(text) : text };
  };
  const signIn = async (claims) => (await call('POST', '/api/auth/cockpit', { ticket: cockpit.ticket(claims) })).body.token;
  const manager = await signIn({ permissions: ['use', 'manage'] });
  const reader = await signIn({ sub: 'u-ray', name: 'Ray', permissions: ['use'] });
  const reader2 = await signIn({ sub: 'u-kim', name: 'Kim', permissions: ['use'] });
  const other = await signIn({ sub: 'u-b', name: 'Bea', org: { id: 'org-b', name: 'Org B' }, permissions: ['use', 'manage'] });
  const ok = async (method, p, body, token = manager, expect = method === 'POST' ? 201 : 200) => {
    const r = await call(method, p, body, token);
    assert.equal(r.status, expect, `${method} ${p}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  return { store, cockpit, call, signIn, manager, reader, reader2, other, ok, close: () => server.close() };
}

test('sign-in comes only from a Cockpit launch ticket for Vault, used once', async () => {
  const t = await setup();
  try {
    assert.equal((await t.call('GET', '/api/clients')).status, 401);
    assert.equal((await t.call('POST', '/api/auth/dev')).status, 404, 'no developer sign-in unless switched on');
    const ticket = t.cockpit.ticket();
    const ok = await t.call('POST', '/api/auth/cockpit', { ticket });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.org, { id: 'org-a', name: 'Org A' });
    assert.equal(ok.body.can_manage, false);
    assert.equal((await t.call('POST', '/api/auth/cockpit', { ticket })).status, 401, 'a ticket works once');
    assert.equal((await t.call('POST', '/api/auth/cockpit', { ticket: t.cockpit.ticket({ aud: 'rollodex' }) })).status, 401);
    const none = await t.call('POST', '/api/auth/cockpit', { ticket: t.cockpit.ticket({ permissions: [] }) });
    assert.equal(none.status, 403);
    assert.match(none.body.error, /does not include Vault/);
    const me = await t.call('GET', '/api/me', null, t.manager);
    assert.equal(me.body.can_manage, true);
    assert.equal(me.body.today, TODAY);
    assert.deepEqual(me.body.options.statuses, ['active', 'waitlist', 'inactive']);
    const h = await t.call('GET', '/api/health');
    assert.equal(h.body.app, 'Vault');
    assert.equal(h.body.store, 'memory');
    assert.match(h.headers.get('content-security-policy'), /frame-ancestors/);
    assert.equal((await t.call('GET', '/api/me', null, t.manager)).headers.get('cache-control'), 'no-store', 'client records are never cached');
  } finally { t.close(); }
});

test('the directory: managers add and change clients, everyone reads, nothing crosses organizations', async () => {
  const t = await setup();
  try {
    const ana = await t.ok('POST', '/api/clients', { first_name: 'Ana', last_name: 'Reyes', preferred_name: 'Annie', email: 'ANA@example.org', program: 'Youth mentoring', assigned_to: 'Dana', tags: 'school, housing', date_of_birth: '2010-05-04' });
    assert.equal(ana.email, 'ana@example.org');
    assert.deepEqual(ana.tags, ['school', 'housing']);
    assert.equal(ana.status, 'active');
    assert.equal(ana.intake_on, TODAY, 'intake defaults to today');
    assert.equal((await t.call('POST', '/api/clients', { first_name: 'X' }, t.reader)).status, 403, 'readers do not add clients');
    assert.equal((await t.call('POST', '/api/clients', { email: 'x@example.org' }, t.manager)).status, 400, 'a client needs a name');
    assert.equal((await t.call('POST', '/api/clients', { first_name: 'X', status: 'gone' }, t.manager)).status, 400);
    assert.equal((await t.call('POST', '/api/clients', { first_name: 'X', date_of_birth: '2030-01-01' }, t.manager)).status, 400, 'no birthdays in the future');

    const list = await t.ok('GET', '/api/clients', null, t.reader);
    assert.equal(list.clients.length, 1);
    assert.equal(list.clients[0].name, 'Annie Reyes', 'the name a client goes by');
    assert.equal((await t.ok('GET', '/api/clients?q=housing', null, t.reader)).clients.length, 1, 'search covers tags');
    assert.equal((await t.ok('GET', '/api/clients?q=mentoring', null, t.reader)).clients.length, 1, 'search covers the program');

    // Another organization cannot see, change, note or post about the client.
    assert.equal((await t.call('GET', `/api/clients/${ana.id}`, null, t.other)).status, 404);
    assert.equal((await t.call('PATCH', `/api/clients/${ana.id}`, { phone: '1' }, t.other)).status, 404);
    assert.equal((await t.call('POST', `/api/clients/${ana.id}/notes`, { date: TODAY, body: 'x' }, t.other)).status, 404);
    assert.equal((await t.call('POST', '/api/posts', { body: 'x', client_id: ana.id }, t.other)).status, 404);
    assert.deepEqual((await t.ok('GET', '/api/clients', null, t.other)).clients, []);

    const edited = await t.ok('PATCH', `/api/clients/${ana.id}`, { phone: '541 555 0100' });
    assert.equal(edited.email, 'ana@example.org', 'edit keeps what was not sent');
    assert.equal(edited.phone, '541 555 0100');
    assert.equal((await t.call('PATCH', `/api/clients/${ana.id}`, { phone: '2' }, t.reader)).status, 403);

    await t.ok('POST', `/api/clients/${ana.id}/archive`, null, t.manager, 200);
    assert.equal((await t.ok('GET', '/api/clients')).clients.length, 0);
    assert.equal((await t.ok('GET', '/api/clients?archived=1')).clients.length, 1);
    await t.ok('POST', `/api/clients/${ana.id}/unarchive`, null, t.manager, 200);

    const activity = (await t.ok('GET', '/api/activity')).activity;
    assert.deepEqual(activity.slice(0, 3).map((e) => e.action), ['client.unarchive', 'client.archive', 'client.update']);
    assert.equal((await t.call('GET', '/api/activity', null, t.reader)).status, 403);
  } finally { t.close(); }
});

test('case notes: dated and signed, never edited, struck with a reason by the author or a manager', async () => {
  const t = await setup();
  try {
    const ana = await t.ok('POST', '/api/clients', { first_name: 'Ana', last_name: 'Reyes', intake_on: '2026-08-01' });
    const ben = await t.ok('POST', '/api/clients', { first_name: 'Ben', last_name: 'Ito', intake_on: '2026-11-01' });
    let page = await t.ok('GET', `/api/clients/${ana.id}`, null, t.reader);
    assert.equal(page.needs_checkin, true, 'taken in in August, never noted');
    assert.equal((await t.ok('GET', `/api/clients/${ben.id}`)).needs_checkin, false, 'taken in two days ago');

    const note = await t.ok('POST', `/api/clients/${ana.id}/notes`, { date: '2026-10-30', kind: 'progress', body: 'Met at school. Attendance is up.' }, t.reader);
    assert.equal(note.created_by, 'Ray');
    assert.equal((await t.call('POST', `/api/clients/${ana.id}/notes`, { date: '2026-12-01', body: 'x' }, t.reader)).status, 400, 'no notes in the future');
    assert.equal((await t.call('POST', `/api/clients/${ana.id}/notes`, { date: TODAY, body: '  ' }, t.reader)).status, 400, 'a note has words');
    assert.equal((await t.call('POST', `/api/clients/${ana.id}/notes`, { date: TODAY, kind: 'gossip', body: 'x' }, t.reader)).status, 400);
    await t.ok('POST', `/api/clients/${ben.id}/notes`, { date: TODAY, kind: 'event', body: 'Intake meeting held.' }, t.reader2);

    page = await t.ok('GET', `/api/clients/${ana.id}`, null, t.reader);
    assert.equal(page.needs_checkin, false);
    assert.equal(page.last_note, '2026-10-30');
    assert.equal(page.notes.length, 1, 'only this client\'s notes');
    assert.equal(page.notes[0].can_strike, true, 'the author may strike');
    assert.equal((await t.ok('GET', `/api/clients/${ana.id}`, null, t.reader2)).notes[0].can_strike, false, 'another reader may not');

    const all = (await t.ok('GET', '/api/notes', null, t.reader)).notes;
    assert.deepEqual(all.map((n) => n.client_name), ['Ben Ito', 'Ana Reyes'], 'newest first, with the client');
    assert.equal((await t.ok('GET', '/api/notes?q=attendance')).notes.length, 1);
    assert.equal((await t.ok('GET', '/api/notes?kind=event')).notes.length, 1);
    assert.equal((await t.ok('GET', `/api/notes?client_id=${ben.id}`)).notes.length, 1);
    assert.equal((await t.call('GET', `/api/notes?client_id=${ana.id}`, null, t.other)).status, 404);
    assert.deepEqual((await t.ok('GET', '/api/notes', null, t.other)).notes, []);

    // Striking: needs a reason, only the author or a manager, kept on the record.
    assert.equal((await t.call('POST', `/api/notes/${note.id}/strike`, { reason: 'x' }, t.reader2)).status, 403);
    assert.equal((await t.call('POST', `/api/notes/${note.id}/strike`, {}, t.reader)).status, 400);
    assert.equal((await t.call('POST', `/api/notes/${note.id}/strike`, { reason: 'x' }, t.other)).status, 404);
    const struck = await t.ok('POST', `/api/notes/${note.id}/strike`, { reason: 'Wrong client' }, t.reader, 200);
    assert.equal(struck.struck_by, 'Ray');
    assert.equal(struck.body, 'Met at school. Attendance is up.', 'the text stays');
    page = await t.ok('GET', `/api/clients/${ana.id}`);
    assert.equal(page.notes.length, 1, 'still on the record');
    assert.equal(page.note_count, 0, 'but counts for nothing');
    assert.equal(page.needs_checkin, true);
    assert.equal((await t.call('PATCH', `/api/notes/${note.id}`, { body: 'changed' }, t.manager)).status, 404, 'no editing route exists');
    assert.equal((await t.call('DELETE', `/api/notes/${note.id}`, null, t.manager)).status, 404, 'no deleting route exists');
  } finally { t.close(); }
});

test('the message board: posts, replies, pins, a client link, and removal by the author or a manager', async () => {
  const t = await setup();
  try {
    const ana = await t.ok('POST', '/api/clients', { first_name: 'Ana', last_name: 'Reyes' });
    const first = await t.ok('POST', '/api/posts', { body: 'Staff meeting moved to 3pm.' }, t.reader);
    const about = await t.ok('POST', '/api/posts', { body: 'Who can drive Ana Thursday?', client_id: ana.id }, t.reader2);
    assert.equal((await t.call('POST', '/api/posts', { body: '' }, t.reader)).status, 400);
    const reply = await t.ok('POST', `/api/posts/${about.id}/replies`, { body: 'I can.' }, t.reader);
    assert.equal((await t.call('POST', `/api/posts/${reply.id}/replies`, { body: 'nested' }, t.reader)).status, 400, 'one level of replies');
    assert.equal((await t.call('POST', `/api/posts/${about.id}/replies`, { body: 'x' }, t.other)).status, 404);

    assert.equal((await t.call('POST', `/api/posts/${first.id}/pin`, {}, t.reader)).status, 403, 'only managers pin');
    await t.ok('POST', `/api/posts/${first.id}/pin`, {}, t.manager, 200);
    let posts = (await t.ok('GET', '/api/posts', null, t.reader)).posts;
    assert.deepEqual(posts.map((p) => p.body), ['Staff meeting moved to 3pm.', 'Who can drive Ana Thursday?'], 'pinned first');
    assert.equal(posts[1].client_name, 'Ana Reyes');
    assert.deepEqual(posts[1].replies.map((r) => r.body), ['I can.']);
    assert.equal(posts[0].can_remove, true, 'Ray wrote it');
    assert.equal(posts[1].can_remove, false, 'Kim wrote it');

    const page = await t.ok('GET', `/api/clients/${ana.id}`);
    assert.deepEqual(page.posts.map((p) => p.body), ['Who can drive Ana Thursday?'], 'the client page shows posts about them');

    assert.equal((await t.call('DELETE', `/api/posts/${about.id}`, null, t.reader)).status, 403);
    assert.equal((await t.call('DELETE', `/api/posts/${about.id}`, null, t.reader2)).status, 204);
    assert.equal((await t.call('DELETE', `/api/posts/${first.id}`, null, t.manager)).status, 204);
    posts = (await t.ok('GET', '/api/posts')).posts;
    assert.deepEqual(posts, []);
    assert.equal((await t.store.getPost('org-a', first.id)).removed_by, 'Dana', 'removed, not deleted');
    assert.deepEqual((await t.ok('GET', '/api/posts', null, t.other)).posts, []);
  } finally { t.close(); }
});

test('home shows the three buttons\' counts and who is due for a check-in', async () => {
  const t = await setup();
  try {
    const ana = await t.ok('POST', '/api/clients', { first_name: 'Ana', last_name: 'Reyes', intake_on: '2026-08-01' });
    await t.ok('POST', '/api/clients', { first_name: 'Ben', last_name: 'Ito', status: 'waitlist', intake_on: '2026-01-01' });
    await t.ok('POST', '/api/posts', { body: 'Hello team' }, t.reader);
    const h = await t.ok('GET', '/api/home', null, t.reader);
    assert.deepEqual(h.directory, { clients: 2, active: 1, checkins_due: 1 });
    assert.deepEqual(h.checkins.map((c) => c.name), ['Ana Reyes'], 'a waitlisted client is not due');
    assert.equal(h.board.recent[0].body, 'Hello team');
    await t.ok('POST', `/api/clients/${ana.id}/notes`, { date: '2026-11-02', body: 'Called.' }, t.reader);
    const after = await t.ok('GET', '/api/home', null, t.reader);
    assert.equal(after.notes.this_week, 1);
    assert.equal(after.directory.checkins_due, 0);
  } finally { t.close(); }
});

test('Cockpit reads counts with the service token, never a name or a note', async () => {
  const t = await setup();
  try {
    const svc = { Authorization: 'Bearer vault-svc', 'X-TSS-Org': 'org-a' };
    const ana = await t.ok('POST', '/api/clients', { first_name: 'Ana', last_name: 'Secretname', intake_on: '2026-02-10' });
    const ben = await t.ok('POST', '/api/clients', { first_name: 'Ben', last_name: 'Ito', intake_on: '2026-03-05' });
    await t.ok('POST', '/api/clients', { first_name: 'Old', last_name: 'Case', intake_on: '2025-06-01', status: 'inactive' });
    await t.ok('POST', `/api/clients/${ana.id}/notes`, { date: '2026-02-11', body: 'Private detail about Ana' }, t.reader);
    await t.ok('POST', `/api/clients/${ana.id}/notes`, { date: '2026-03-12', body: 'Second' }, t.reader);
    const wrong = await t.ok('POST', `/api/clients/${ben.id}/notes`, { date: '2026-03-13', body: 'Mistake' }, t.reader);
    await t.ok('POST', `/api/notes/${wrong.id}/strike`, { reason: 'wrong' }, t.reader, 200);
    await t.ok('POST', '/api/posts', { body: 'A post' }, t.reader);

    assert.equal((await t.call('GET', '/api/cockpit/rollup')).status, 401);
    assert.equal((await t.call('GET', '/api/cockpit/rollup', null, t.manager)).status, 401, 'a person\'s session is not the service token');
    assert.equal((await t.call('GET', '/api/cockpit/rollup', null, null, { Authorization: 'Bearer wrong', 'X-TSS-Org': 'org-a' })).status, 401);
    assert.equal((await t.call('GET', '/api/cockpit/rollup', null, null, { Authorization: 'Bearer vault-svc' })).status, 400, 'the organization is named');

    const r = await t.call('GET', '/api/cockpit/rollup?from=2026-01-01&to=2026-03-31', null, null, svc);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.metrics, {
      clients_active: { value: 2 }, clients_new: { value: 2 }, case_notes: { value: 2 }, clients_seen: { value: 1 },
      checkins_due: { value: 2 }, posts: { value: 0 },
    });
    assert.deepEqual(r.body.series.case_notes, [{ month: '2026-01', value: 0 }, { month: '2026-02', value: 1 }, { month: '2026-03', value: 1 }]);
    assert.doesNotMatch(r.text, /Ana|Secretname|Private|Ben|Mistake|A post/, 'no names, notes or posts');

    const nov = await t.call('GET', '/api/cockpit/rollup?from=2026-11-01&to=2026-11-30', null, null, svc);
    assert.equal(nov.body.metrics.posts.value, 1);
    const empty = await t.call('GET', '/api/cockpit/rollup?from=2026-01-01&to=2026-03-31', null, null, { ...svc, 'X-TSS-Org': 'org-b' });
    assert.equal(empty.body.metrics.clients_active.value, 0);
    // The service token opens nothing else.
    assert.equal((await t.call('GET', '/api/clients', null, null, svc)).status, 401);
    assert.equal((await t.call('GET', '/api/notes', null, null, svc)).status, 401);
  } finally { t.close(); }
});

test('Cockpit\'s export token reads the organization\'s whole record, and only that', async () => {
  const t = await setup();
  try {
    const ana = await t.ok('POST', '/api/clients', { first_name: 'Ana', last_name: 'Reyes', intake_on: '2026-08-01' });
    const note = await t.ok('POST', `/api/clients/${ana.id}/notes`, { date: '2026-10-30', kind: 'progress', body: 'Met at school.' }, t.reader);
    await t.ok('POST', `/api/notes/${note.id}/strike`, { reason: 'Wrong client' }, t.manager, 200);
    const post = await t.ok('POST', '/api/posts', { body: 'Staff meeting moved.' }, t.reader);
    await t.ok('POST', `/api/posts/${post.id}/replies`, { body: 'Thanks.' }, t.reader2);
    await t.store.updatePost('org-a', post.id, { removed_at: '2026-11-03T10:00:00.000Z', removed_by: 'Dana' });
    await t.ok('POST', '/api/clients', { first_name: 'Bo', last_name: 'Other' }, t.other);

    const exp = { Authorization: 'Bearer vault-export', 'X-TSS-Org': 'org-a' };
    assert.equal((await t.call('GET', '/api/export/org')).status, 401);
    assert.equal((await t.call('GET', '/api/export/org', null, t.manager)).status, 401, 'a person\'s session is not the export token');
    assert.equal((await t.call('GET', '/api/export/org', null, null, { Authorization: 'Bearer vault-svc', 'X-TSS-Org': 'org-a' })).status, 401, 'the service token does not export');
    assert.equal((await t.call('GET', '/api/export/org', null, null, { Authorization: 'Bearer vault-export' })).status, 400, 'the organization is named');
    const r = await t.call('GET', '/api/export/org', null, null, exp);
    assert.equal(r.status, 200);
    assert.equal(r.body.schema, 'tss.org-export/v1');
    assert.equal(r.body.app, 'vault');
    assert.equal(r.body.org_id, 'org-a');
    assert.deepEqual(r.body.tables.clients.map((c) => c.first_name), ['Ana']);
    assert.equal(r.body.tables.case_notes.length, 1);
    assert.equal(r.body.tables.case_notes[0].strike_reason, 'Wrong client', 'struck notes stay on the record');
    assert.deepEqual(r.body.tables.posts.map((p) => p.body).sort(), ['Staff meeting moved.', 'Thanks.'], 'removed posts and replies included');
    assert.ok(r.body.tables.activity.some((a) => a.action === 'note.strike'));
    assert.ok(!r.text.includes('Other'), 'nothing from another organization');
    const theirs = await t.call('GET', '/api/export/org', null, null, { ...exp, 'X-TSS-Org': 'org-b' });
    assert.deepEqual(theirs.body.tables.clients.map((c) => c.first_name), ['Bo']);
    assert.ok((await t.store.activity('org-a')).some((a) => a.action === 'export.org'), 'the export is in the activity log');
    // The export token opens nothing else.
    assert.equal((await t.call('GET', '/api/clients', null, null, exp)).status, 401);
    assert.equal((await t.call('GET', '/api/cockpit/rollup', null, null, exp)).status, 401);
  } finally { t.close(); }
});

test('import and export of the directory are for managers, and an email match updates', async () => {
  const t = await setup();
  try {
    const csv = 'First Name,Last Name,Email,Program,Status,Case Worker,DOB\nAna,Reyes,ana@example.org,Youth,active,Dana,2010-05-04\nBen,Ito,,Adults,waitlist,,\n,,nobody@example.org,,,,\nCy,Day,,,,,not-a-date\n';
    assert.equal((await t.call('POST', '/api/import/clients', { csv }, t.reader)).status, 403);
    const r = await t.ok('POST', '/api/import/clients', { csv }, t.manager, 200);
    assert.equal(r.added, 2);
    assert.deepEqual(r.skipped.map((s) => s.line), [4, 5]);
    const again = await t.ok('POST', '/api/import/clients', { csv: 'email,phone\nANA@example.org,541 555 0100\n' }, t.manager, 200);
    assert.equal(again.updated, 1);
    const ana = (await t.ok('GET', '/api/clients?q=reyes')).clients[0];
    assert.equal(ana.phone, '541 555 0100');
    assert.equal(ana.program, 'Youth', 'the update kept what the row left blank');
    assert.equal(ana.assigned_to, 'Dana');

    assert.equal((await t.call('GET', '/api/export/clients.csv', null, t.reader)).status, 403);
    const out = await t.call('GET', '/api/export/clients.csv', null, t.manager);
    assert.equal(out.status, 200);
    assert.match(out.type, /text\/csv/);
    assert.match(out.text, /^first_name,last_name,/);
    assert.match(out.text, /Ana,Reyes/);
  } finally { t.close(); }
});
