// One contract, two stores. The in-memory store always runs; the Postgres
// store runs when TEST_DATABASE_URL points at a database (CI starts one).

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MemoryStore } from '../lib/store-memory.js';
import { PostgresStore } from '../lib/store-postgres.js';

const stores = [['memory', async () => new MemoryStore().init()]];
if (process.env.TEST_DATABASE_URL) {
  stores.push(['postgres', async () => {
    const s = await new PostgresStore(process.env.TEST_DATABASE_URL).init();
    await s.q('TRUNCATE vault_activity, vault_posts, vault_notes, vault_clients');
    return s;
  }]);
}

const id = () => crypto.randomUUID();
const wait = () => new Promise((r) => setTimeout(r, 5));

for (const [name, open] of stores) {
  test(`${name}: clients stay inside their organization, search, archive and keep their fields`, async () => {
    const store = await open();
    try {
      const ana = await store.createClient('org-a', { id: id(), first_name: 'Ana', last_name: 'Reyes', preferred_name: 'Annie', email: 'ana@example.org', tags: ['school', 'housing'], program: 'Youth', date_of_birth: '2010-05-04', intake_on: '2026-08-01', created_by: 'Ray' });
      await store.createClient('org-a', { id: id(), first_name: 'Ben', last_name: 'Ito', status: 'waitlist' });
      await store.createClient('org-b', { id: id(), first_name: 'Theirs', last_name: 'Only' });
      assert.deepEqual(ana.tags, ['school', 'housing']);
      assert.equal(ana.updated_by, 'Ray');
      assert.equal(ana.status, 'active');
      assert.equal(ana.date_of_birth, '2010-05-04');
      assert.equal(ana.intake_on, '2026-08-01');
      assert.equal(ana.archived_at, null);
      assert.equal(typeof ana.created_at, 'string');

      assert.deepEqual((await store.listClients('org-a')).map((c) => c.last_name), ['Ito', 'Reyes']);
      assert.deepEqual((await store.listClients('org-a', { q: 'HOUSING' })).map((c) => c.first_name), ['Ana'], 'search is case-insensitive and covers tags');
      assert.deepEqual((await store.listClients('org-a', { q: 'annie' })).map((c) => c.first_name), ['Ana'], 'and the name a client goes by');
      assert.deepEqual((await store.listClients('org-a', { status: 'waitlist' })).map((c) => c.first_name), ['Ben']);
      assert.equal(await store.getClient('org-b', ana.id), null);
      assert.equal(await store.updateClient('org-b', ana.id, { phone: 'x' }), null);

      const edited = await store.updateClient('org-a', ana.id, { phone: '541', tags: ['school'], date_of_birth: null, archived_at: '2026-11-03T10:00:00.000Z', updated_by: 'Kim' });
      assert.equal(edited.phone, '541');
      assert.equal(edited.email, 'ana@example.org', 'untouched fields stay');
      assert.deepEqual(edited.tags, ['school']);
      assert.equal(edited.date_of_birth, null);
      assert.equal(edited.updated_by, 'Kim');
      assert.equal(new Date(edited.archived_at).toISOString(), '2026-11-03T10:00:00.000Z');
      assert.equal((await store.listClients('org-a')).length, 1);
      assert.equal((await store.listClients('org-a', { archived: true })).length, 1);
      assert.equal((await store.updateClient('org-a', ana.id, { archived_at: null })).archived_at, null);
    } finally { await store.close(); }
  });

  test(`${name}: case notes belong to the organization's own clients and are struck, never removed`, async () => {
    const store = await open();
    try {
      const ana = await store.createClient('org-a', { id: id(), first_name: 'Ana' });
      const ben = await store.createClient('org-a', { id: id(), first_name: 'Ben' });
      const theirs = await store.createClient('org-b', { id: id(), first_name: 'Theirs' });
      assert.equal(await store.createNote('org-a', { id: id(), client_id: theirs.id, date: '2026-10-01', body: 'x' }), null, 'not another organization\'s client');
      const n1 = await store.createNote('org-a', { id: id(), client_id: ana.id, date: '2026-10-01', kind: 'progress', body: 'Attendance up', created_by: 'Ray', created_by_id: 'u-ray' });
      await store.createNote('org-a', { id: id(), client_id: ben.id, date: '2026-10-05', kind: 'event', body: 'Intake held' });
      assert.equal(n1.date, '2026-10-01');
      assert.equal(n1.created_by_id, 'u-ray');
      assert.equal(n1.struck_at, null);

      assert.deepEqual((await store.listNotes('org-a')).map((n) => n.body), ['Intake held', 'Attendance up'], 'newest first');
      assert.deepEqual((await store.listNotes('org-a', { client_id: ana.id })).map((n) => n.body), ['Attendance up']);
      assert.deepEqual((await store.listNotes('org-a', { kind: 'event' })).map((n) => n.body), ['Intake held']);
      assert.deepEqual((await store.listNotes('org-a', { q: 'ATTEND' })).map((n) => n.body), ['Attendance up']);
      assert.deepEqual((await store.listNotes('org-a', { from: '2026-10-02', to: '2026-10-31' })).map((n) => n.body), ['Intake held']);
      assert.equal((await store.listNotes('org-a', { limit: 1 })).length, 1);
      assert.deepEqual(await store.listNotes('org-b'), []);
      assert.equal(await store.getNote('org-b', n1.id), null);

      assert.equal(await store.strikeNote('org-b', n1.id, { by: 'Bea', reason: 'x' }), null);
      const struck = await store.strikeNote('org-a', n1.id, { by: 'Dana', reason: 'Wrong client' });
      assert.equal(struck.struck_by, 'Dana');
      assert.equal(struck.strike_reason, 'Wrong client');
      assert.equal(typeof struck.struck_at, 'string');
      const twice = await store.strikeNote('org-a', n1.id, { by: 'Kim', reason: 'again' });
      assert.equal(twice.struck_by, 'Dana', 'the first strike stands');
      assert.equal((await store.listNotes('org-a')).length, 2, 'struck notes stay');
    } finally { await store.close(); }
  });

  test(`${name}: posts, replies, pins and removal stay inside the organization`, async () => {
    const store = await open();
    try {
      const ana = await store.createClient('org-a', { id: id(), first_name: 'Ana' });
      const theirs = await store.createClient('org-b', { id: id(), first_name: 'Theirs' });
      const p1 = await store.createPost('org-a', { id: id(), body: 'First', created_by: 'Ray', created_by_id: 'u-ray' });
      await wait();
      const p2 = await store.createPost('org-a', { id: id(), body: 'About Ana', client_id: ana.id });
      assert.equal(await store.createPost('org-a', { id: id(), body: 'x', client_id: theirs.id }), null);
      assert.equal(await store.createPost('org-b', { id: id(), body: 'x', parent_id: p1.id }), null, 'no replies across organizations');
      const r1 = await store.createPost('org-a', { id: id(), body: 'Reply', parent_id: p2.id });
      assert.equal(await store.createPost('org-a', { id: id(), body: 'nested', parent_id: r1.id }), null, 'one level of replies');
      assert.equal(p1.pinned, false);
      assert.equal(p1.created_by_id, 'u-ray');

      assert.deepEqual((await store.listPosts('org-a')).map((p) => p.body), ['About Ana', 'First'], 'top level, newest first');
      assert.deepEqual((await store.listPosts('org-a', { client_id: ana.id })).map((p) => p.body), ['About Ana']);
      assert.deepEqual((await store.listPosts('org-a', { limit: 1 })).map((p) => p.body), ['About Ana']);
      assert.deepEqual((await store.listReplies('org-a', [p1.id, p2.id])).map((p) => p.body), ['Reply']);
      assert.deepEqual(await store.listReplies('org-b', [p2.id]), []);
      assert.deepEqual(await store.listReplies('org-a', []), []);
      assert.deepEqual(await store.listPosts('org-b'), []);

      assert.equal(await store.updatePost('org-b', p1.id, { pinned: true }), null);
      assert.equal((await store.updatePost('org-a', p1.id, { pinned: true })).pinned, true);
      const removed = await store.updatePost('org-a', p2.id, { removed_at: '2026-11-03T10:00:00.000Z', removed_by: 'Dana' });
      assert.equal(removed.removed_by, 'Dana');
      assert.deepEqual((await store.listPosts('org-a')).map((p) => p.body), ['First']);
      assert.equal((await store.listPosts('org-a', { removed: true })).length, 2, 'kept for the record');
    } finally { await store.close(); }
  });

  test(`${name}: the activity log is per organization, newest first`, async () => {
    const store = await open();
    try {
      await store.log('org-a', { actor: 'Ray', action: 'client.add', target: 'Ana' });
      await wait();
      await store.log('org-a', { actor: 'Ray', action: 'note.add', target: 'Ana', detail: 'progress' });
      await store.log('org-b', { actor: 'Bea', action: 'client.add', target: 'Theirs' });
      const a = await store.activity('org-a');
      assert.deepEqual(a.map((e) => e.action), ['note.add', 'client.add']);
      assert.equal(a[0].detail, 'progress');
      assert.equal(typeof a[0].at, 'string');
      assert.equal((await store.activity('org-b')).length, 1);
    } finally { await store.close(); }
  });
}
