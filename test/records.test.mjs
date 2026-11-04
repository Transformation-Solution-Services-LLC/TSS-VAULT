import test from 'node:test';
import assert from 'node:assert/strict';
import { localDay, daysBetween, displayName, needsCheckin, summarizeClients, monthsBetween, rollup, mentions, CHECKIN_DAYS } from '../lib/records.js';

test('a moment is dated in the organization\'s zone, not in UTC', () => {
  // 8pm in Oregon on November 3 is already November 4 in UTC.
  assert.equal(localDay('2026-11-04T04:00:00.000Z', 'America/Los_Angeles'), '2026-11-03');
  assert.equal(localDay('2026-11-04T04:00:00.000Z', 'UTC'), '2026-11-04');
  assert.equal(daysBetween('2026-10-04', '2026-11-03'), 30);
  assert.equal(daysBetween('', '2026-11-03'), Infinity);
});

test('a client is shown by the name they go by', () => {
  assert.equal(displayName({ first_name: 'Ana', last_name: 'Reyes', preferred_name: 'Annie' }), 'Annie Reyes');
  assert.equal(displayName({ first_name: 'Ana', last_name: 'Reyes' }), 'Ana Reyes');
  assert.equal(displayName({}), 'Unnamed');
});

test('a check-in is due after a month without a note, counted from intake for a new client', () => {
  const asOf = '2026-11-03';
  const client = { id: 'c', status: 'active', intake_on: '2026-10-20' };
  assert.equal(CHECKIN_DAYS, 30);
  assert.equal(needsCheckin(client, [], asOf), false, 'taken in two weeks ago');
  assert.equal(needsCheckin({ ...client, intake_on: '2026-09-01' }, [], asOf), true);
  assert.equal(needsCheckin({ ...client, intake_on: null }, [], asOf), true, 'no intake date and no note');
  assert.equal(needsCheckin({ ...client, intake_on: '2026-01-01' }, [{ client_id: 'c', date: '2026-10-10' }], asOf), false);
  assert.equal(needsCheckin({ ...client, intake_on: '2026-01-01' }, [{ client_id: 'c', date: '2026-10-10', struck_at: 'x' }], asOf), true, 'a struck note does not count');
  assert.equal(needsCheckin({ ...client, status: 'waitlist', intake_on: '2026-01-01' }, [], asOf), false);
  assert.equal(needsCheckin({ ...client, archived_at: 'x', intake_on: '2026-01-01' }, [], asOf), false);
  const [s] = summarizeClients([{ ...client, first_name: 'Ana' }], [{ client_id: 'c', date: '2026-10-30' }, { client_id: 'c', date: '2026-10-31', struck_at: 'x' }, { client_id: 'other', date: '2026-11-01' }], asOf);
  assert.equal(s.note_count, 1);
  assert.equal(s.last_note, '2026-10-30');
  assert.equal(s.name, 'Ana');
});

test('the rollup counts the period and never carries a name', () => {
  assert.deepEqual(monthsBetween('2025-11-15', '2026-02-01'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  const r = rollup({
    from: '2026-01-01', to: '2026-01-31',
    clients: [
      { id: 'a', first_name: 'Ana', status: 'active', intake_on: '2026-01-05' },
      { id: 'b', first_name: 'Ben', status: 'inactive', intake_on: '2025-01-05' },
      { id: 'c', first_name: 'Cy', status: 'active', intake_on: '2026-01-06', archived_at: 'x' },
    ],
    notes: [{ client_id: 'a', date: '2026-01-10', body: 'secret' }, { client_id: 'a', date: '2026-01-11' }, { client_id: 'b', date: '2026-01-12', struck_at: 'x' }],
    posts: [{ created_at: '2026-01-31T12:00:00.000Z' }, { created_at: '2026-02-01T05:00:00.000Z' }, { created_at: '2026-01-15T00:00:00.000Z', removed_at: 'x' }],
  }, '2026-02-05');
  assert.deepEqual(r.metrics, {
    clients_active: { value: 1 }, clients_new: { value: 2 }, case_notes: { value: 2 }, clients_seen: { value: 1 }, checkins_due: { value: 0 },
    // February 1 at 5am UTC is still January 31 in Oregon.
    posts: { value: 2 },
  });
  assert.deepEqual(r.series.case_notes, [{ month: '2026-01', value: 2 }]);
  assert.doesNotMatch(JSON.stringify(r), /Ana|Ben|Cy|secret/);
});

test('an @ names a person by first name or full name, not by a longer word or an email', () => {
  assert.ok(mentions('@Ray can you', 'Ray Ortiz'));
  assert.ok(mentions('thanks @ray ortiz!', 'Ray Ortiz'));
  assert.ok(mentions('(@Ray)', 'Ray'));
  assert.ok(!mentions('@Raymond', 'Ray'));
  assert.ok(!mentions('ray@example.org', 'Ray'));
  assert.ok(!mentions('Ray, no at sign', 'Ray'));
  assert.ok(!mentions('@Ray', ''));
});
