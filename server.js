// Vault: the staff workspace in the TSS product suite.
//
// One Express service serving the API and the frontend, the same shape as
// Library and Rollodex. Its first screen has three buttons:
//
//   Message Board  internal work messages, with replies, pins, and an
//                  optional link to a client.
//   Case Notes     dated progress and event notes, each with its author,
//                  each about one client.
//   Directory      client profiles, each with the route to that client's
//                  notes and the posts about them.
//
// Staff with "use" read everything, write case notes and post. Staff with
// "manage" add and change client profiles, import and export, strike a
// mistaken note, pin and remove posts, and read the activity log. Nothing is
// deleted: a client is archived, a note is struck (kept and marked), a post
// is removed (kept and hidden).
//
// People sign in through TSS Cockpit (lib/cockpit.js). Every record belongs to
// one Cockpit organization. Cockpit's server reads counts, never a name or a
// note, with the service token (GET /api/cockpit/rollup).

import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireUser, requireManager, requireService, requireExport, sessionFor, devSignInEnabled } from './lib/auth.js';
import { createTicketVerifier, cockpitUrl, frameHeaders } from './lib/cockpit.js';
import { createCockpitLink } from './lib/cockpit-link.js';
import { publicErrorBody, logSafeError, normalizePublicError, requestContext, PublicError } from './lib/public-error.js';
import { errorReporter, installCrashHandlers } from './lib/error-tracking.js';
import { openStore } from './lib/store.js';
import { toCsv } from './lib/csv.js';
import { readSheet, cleanMapping, mappedRows, previewOf, nameKey, phoneKey, readDay, MAX_ROWS } from './lib/import-map.js';
import {
  CLIENT_STATUSES, NOTE_KINDS, CHECKIN_DAYS,
  isDay, today, daysBetween, displayName, summarizeClients, rollup, needsYou,
} from './lib/records.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => ID.test(String(v || ''));
// Who may come in at all: either of the app's permissions from Cockpit.
export const CAN_ENTER = (perms) => perms.includes('use') || perms.includes('manage');
export const APP_NAME = 'Vault';
// The activity log rows an organization export carries, newest first.
const EXPORT_ACTIVITY_LIMIT = 100000;

export function createApp({
  store,
  verifyTicket = createTicketVerifier({ audience: 'vault' }),
  // Access changes from Cockpit and the audit trail Cockpit reads (lib/cockpit-link.js).
  cockpitLink = createCockpitLink({ audience: 'vault', canEnter: CAN_ENTER }),
  clock = () => today(),
} = {}) {
  if (!store) throw new Error('createApp needs a store');
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
  app.use(frameHeaders);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Client records: never kept in a shared cache.
    if (_req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // A CSV import of a few thousand clients stays well under this.
  app.use(express.json({ limit: '8mb' }));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  app.locals.cockpitLink = cockpitLink;
  cockpitLink.routes(app, { wrap });
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  // The app's own activity list, and the trail Cockpit reads into its one audit log.
  const audit = (req, action, target, detail = '') => {
    cockpitLink.record({ org: req.user.org_id, actorId: req.user.id, actor: req.user.name, email: req.user.email, action, target, detail, ip: req.ip });
    return store.log(req.user.org_id, { actor: req.user.name, action, target, detail }).catch((e) => logSafeError(console, e, 'audit_failed'));
  };
  const bad = (code, message) => new PublicError(400, code, message);
  const notFound = (what) => new PublicError(404, 'not_found', `No such ${what}`);
  const forbidden = (message) => new PublicError(403, 'not_permitted', message);

  // ---- field checks ----

  const dayField = (v, label, { required = false } = {}) => {
    const s = str(v, 10);
    if (!s) { if (required) throw bad('date_required', `Give the ${label}`); return null; }
    if (!isDay(s)) throw bad('bad_date', `${label[0].toUpperCase()}${label.slice(1)} must be a date like 2026-03-31`);
    return s;
  };
  const oneOf = (v, list, label, fallback) => {
    const s = str(v, 40).toLowerCase();
    if (!s) return fallback;
    if (!list.includes(s)) throw bad('bad_value', `${label} must be one of: ${list.join(', ')}`);
    return s;
  };
  const tagsField = (v) => {
    const list = Array.isArray(v) ? v : String(v ?? '').split(/[,;]/);
    return [...new Set(list.map((t) => str(t, 40)).filter(Boolean))].slice(0, 30);
  };

  function clientFields(b, existing = null) {
    const out = {};
    const has = (k) => b[k] !== undefined;
    for (const k of ['first_name', 'last_name', 'preferred_name']) if (!existing || has(k)) out[k] = str(b[k], 120);
    if (!existing || has('pronouns')) out.pronouns = str(b.pronouns, 40);
    if (!existing || has('date_of_birth')) {
      out.date_of_birth = dayField(b.date_of_birth, 'date of birth');
      if (out.date_of_birth && out.date_of_birth > clock()) throw bad('bad_date', 'The date of birth is in the future');
    }
    if (!existing || has('email')) {
      out.email = str(b.email, 200).toLowerCase();
      if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw bad('bad_email', 'That email address does not look right');
    }
    if (!existing || has('phone')) out.phone = str(b.phone, 40);
    if (!existing || has('address')) out.address = str(b.address, 500);
    if (!existing || has('program')) out.program = str(b.program, 120);
    if (!existing || has('status')) out.status = oneOf(b.status, CLIENT_STATUSES, 'Status', 'active');
    if (!existing || has('assigned_to')) out.assigned_to = str(b.assigned_to, 120);
    if (!existing || has('intake_on')) out.intake_on = dayField(b.intake_on, 'intake date') || (existing ? null : clock());
    if (!existing || has('emergency_contact')) out.emergency_contact = str(b.emergency_contact, 500);
    if (!existing || has('tags')) out.tags = tagsField(b.tags);
    if (!existing || has('summary')) out.summary = str(b.summary, 5000);
    const merged = { ...(existing || {}), ...out };
    if (!merged.first_name && !merged.last_name && !merged.preferred_name) throw bad('no_name', 'Give the client a first or last name');
    return out;
  }

  // ---- sign-in: through Cockpit only ----

  const signedIn = (person) => ({
    token: sessionFor(person), name: person.name, org: person.org,
    can_manage: person.permissions.includes('manage'),
  });

  app.post('/api/auth/cockpit', wrap(async (req, res) => {
    const person = await verifyTicket(str((req.body || {}).ticket, 8000));
    if (!person.permissions.includes('use') && !person.permissions.includes('manage')) {
      throw new PublicError(403, 'not_permitted', `Your role in Cockpit does not include ${APP_NAME}. Ask your administrator.`);
    }
    if (!person.permissions.includes('use')) person.permissions = [...person.permissions, 'use'];
    await cockpitLink.record({ org: person.org.id, actorId: person.sub, actor: person.name, email: person.email, action: 'signin', detail: person.permissions.join(', '), ip: req.ip });
    res.json(signedIn(person));
  }));

  app.post('/api/auth/dev', (_req, res) => {
    if (!devSignInEnabled()) return res.status(404).json({ error: 'No such endpoint', code: 'not_found' });
    res.json(signedIn({ sub: 'dev', name: 'Developer', org: { id: 'dev', name: 'Development' }, permissions: ['use', 'manage'] }));
  });

  app.get('/api/health', wrap(async (_req, res) => {
    let db = true;
    try { await store.ping(); } catch (_) { db = false; }
    res.status(db ? 200 : 503).json({ ok: db, app: APP_NAME, store: store.kind, db, cockpit_url: cockpitUrl(), dev_signin: devSignInEnabled() });
  }));

  app.get('/api/me', requireUser, (req, res) => {
    res.json({
      id: req.user.id, name: req.user.name, org: { id: req.user.org_id, name: req.user.org_name }, can_manage: req.user.can_manage,
      options: { statuses: CLIENT_STATUSES, note_kinds: NOTE_KINDS, checkin_days: CHECKIN_DAYS },
      today: clock(),
    });
  });

  // ---- loading, scoped to the caller's organization ----

  async function loadClient(req, id = req.params.id) {
    const c = isId(id) ? await store.getClient(req.user.org_id, id) : null;
    if (!c) throw notFound('client');
    return c;
  }
  async function loadPost(req, id = req.params.id) {
    const p = isId(id) ? await store.getPost(req.user.org_id, id) : null;
    if (!p || p.removed_at) throw notFound('post');
    return p;
  }
  async function namesFor(org) {
    const [live, archived] = await Promise.all([store.listClients(org), store.listClients(org, { archived: true })]);
    return new Map([...live, ...archived].map((c) => [c.id, displayName(c)]));
  }
  const withName = (names) => (x) => ({ ...x, client_name: x.client_id ? names.get(x.client_id) || 'Unknown' : '' });
  const mine = (req, x) => x.created_by_id && x.created_by_id === req.user.id;

  // Top-level posts with their replies, pinned first.
  async function board(req, { client_id = null, limit = 100 } = {}) {
    const org = req.user.org_id;
    const posts = await store.listPosts(org, { client_id, limit });
    const replies = await store.listReplies(org, posts.map((p) => p.id));
    const names = await namesFor(org);
    const decorate = (p) => ({ ...withName(names)(p), can_remove: req.user.can_manage || mine(req, p) });
    const byParent = new Map();
    for (const r of replies) (byParent.get(r.parent_id) || byParent.set(r.parent_id, []).get(r.parent_id)).push(decorate(r));
    const list = posts.map((p) => ({ ...decorate(p), replies: byParent.get(p.id) || [] }));
    return [...list.filter((p) => p.pinned), ...list.filter((p) => !p.pinned)];
  }

  // ---- home: the three buttons and what is new behind each ----

  app.get('/api/home', requireUser, wrap(async (req, res) => {
    const org = req.user.org_id;
    const asOf = clock();
    const [clients, notes, posts] = await Promise.all([store.listClients(org), store.listNotes(org), store.listPosts(org, { limit: 5 })]);
    const active = clients.filter((c) => c.status === 'active');
    const summaries = summarizeClients(active, notes, asOf);
    const names = new Map(clients.map((c) => [c.id, displayName(c)]));
    const weekNotes = notes.filter((n) => !n.struck_at && daysBetween(n.date, asOf) < 7);
    res.json({
      as_of: asOf,
      directory: { clients: clients.length, active: active.length, checkins_due: summaries.filter((c) => c.needs_checkin).length },
      notes: { this_week: weekNotes.length, recent: notes.filter((n) => !n.struck_at).slice(0, 5).map(withName(names)) },
      board: { recent: posts.map(withName(names)) },
      checkins: summaries.filter((c) => c.needs_checkin).sort((a, b) => (a.last_note || '').localeCompare(b.last_note || '')).slice(0, 10)
        .map((c) => ({ id: c.id, name: c.name, assigned_to: c.assigned_to, last_note: c.last_note })),
    });
  }));

  // ---- directory ----

  app.get('/api/clients', requireUser, wrap(async (req, res) => {
    const org = req.user.org_id;
    const asOf = clock();
    const status = req.query.status ? oneOf(req.query.status, CLIENT_STATUSES, 'Status', '') : '';
    const archived = String(req.query.archived || '') === '1';
    const clients = await store.listClients(org, { q: str(req.query.q, 200), status, archived });
    let list = summarizeClients(clients, await store.listNotes(org), asOf);
    if (str(req.query.filter, 20) === 'checkin') list = list.filter((c) => c.needs_checkin);
    const mineOnly = str(req.query.assigned, 120);
    if (mineOnly) list = list.filter((c) => c.assigned_to.toLowerCase() === mineOnly.toLowerCase());
    res.json({ clients: list, total: clients.length, as_of: asOf });
  }));

  app.post('/api/clients', requireManager, wrap(async (req, res) => {
    const c = await store.createClient(req.user.org_id, { id: crypto.randomUUID(), ...clientFields(req.body || {}), created_by: req.user.name });
    audit(req, 'client.add', displayName(c));
    res.status(201).json(c);
  }));

  app.get('/api/clients/:id', requireUser, wrap(async (req, res) => {
    const c = await loadClient(req);
    const org = req.user.org_id;
    const notes = await store.listNotes(org, { client_id: c.id });
    const [summary] = summarizeClients([c], notes, clock());
    res.json({
      ...summary,
      notes: notes.map((n) => ({ ...n, can_strike: !n.struck_at && (req.user.can_manage || mine(req, n)) })),
      posts: await board(req, { client_id: c.id, limit: 50 }),
    });
  }));

  app.patch('/api/clients/:id', requireManager, wrap(async (req, res) => {
    const existing = await loadClient(req);
    const c = await store.updateClient(req.user.org_id, existing.id, { ...clientFields(req.body || {}, existing), updated_by: req.user.name });
    audit(req, 'client.update', displayName(c));
    res.json(c);
  }));

  // Archived, never deleted: notes and posts stay on the record.
  for (const [verb, value] of [['archive', () => new Date().toISOString()], ['unarchive', () => null]]) {
    app.post(`/api/clients/:id/${verb}`, requireManager, wrap(async (req, res) => {
      const existing = await loadClient(req);
      const c = await store.updateClient(req.user.org_id, existing.id, { archived_at: value(), updated_by: req.user.name });
      audit(req, `client.${verb}`, displayName(c));
      res.json(c);
    }));
  }

  // ---- case notes: anyone with "use" writes one ----

  app.get('/api/notes', requireUser, wrap(async (req, res) => {
    const org = req.user.org_id;
    const q = req.query;
    const from = dayField(q.from, 'from');
    const to = dayField(q.to, 'to');
    const client_id = q.client_id ? (await loadClient(req, q.client_id)).id : null;
    const kind = q.kind ? oneOf(q.kind, NOTE_KINDS, 'Kind', null) : null;
    const notes = await store.listNotes(org, { client_id, from, to, kind, q: str(q.q, 200), limit: 300 });
    const names = await namesFor(org);
    res.json({ notes: notes.map(withName(names)).map((n) => ({ ...n, can_strike: !n.struck_at && (req.user.can_manage || mine(req, n)) })) });
  }));

  app.post('/api/clients/:id/notes', requireUser, wrap(async (req, res) => {
    const c = await loadClient(req);
    const b = req.body || {};
    const rec = {
      id: crypto.randomUUID(), client_id: c.id,
      date: dayField(b.date, 'date', { required: true }),
      kind: oneOf(b.kind, NOTE_KINDS, 'Kind', 'progress'),
      body: str(b.body, 20000),
      created_by: req.user.name, created_by_id: req.user.id,
    };
    if (!rec.body) throw bad('no_body', 'Write the note');
    if (rec.date > clock()) throw bad('future_date', 'A note cannot be dated in the future');
    const n = await store.createNote(req.user.org_id, rec);
    audit(req, 'note.add', displayName(c), rec.kind);
    res.status(201).json(n);
  }));

  // A note is never edited or deleted. One written in error is struck: it
  // stays on the record, marked, with who struck it and why.
  app.post('/api/notes/:id/strike', requireUser, wrap(async (req, res) => {
    const n = isId(req.params.id) ? await store.getNote(req.user.org_id, req.params.id) : null;
    if (!n) throw notFound('note');
    if (!req.user.can_manage && !mine(req, n)) throw forbidden('Only the author or a Vault manager can strike a note.');
    const reason = str((req.body || {}).reason, 500);
    if (!reason) throw bad('no_reason', 'Say why the note is struck');
    const struck = await store.strikeNote(req.user.org_id, n.id, { by: req.user.name, reason });
    audit(req, 'note.strike', n.client_id, reason);
    res.json(struck);
  }));

  // ---- message board ----

  app.get('/api/posts', requireUser, wrap(async (req, res) => {
    res.json({ posts: await board(req) });
  }));

  async function newPost(req, { parent_id = null } = {}) {
    const b = req.body || {};
    const body = str(b.body, 5000);
    if (!body) throw bad('no_body', 'Write the message');
    const client_id = !parent_id && b.client_id ? (await loadClient(req, b.client_id)).id : null;
    const p = await store.createPost(req.user.org_id, { id: crypto.randomUUID(), parent_id, client_id, body, created_by: req.user.name, created_by_id: req.user.id });
    if (!p) throw notFound('post');
    return p;
  }

  app.post('/api/posts', requireUser, wrap(async (req, res) => {
    const p = await newPost(req);
    audit(req, 'post.add', p.client_id || '', p.body.slice(0, 80));
    res.status(201).json(p);
  }));

  app.post('/api/posts/:id/replies', requireUser, wrap(async (req, res) => {
    const parent = await loadPost(req);
    if (parent.parent_id) throw bad('nested_reply', 'Reply to the first post of the thread');
    const p = await newPost(req, { parent_id: parent.id });
    audit(req, 'post.reply', parent.id);
    res.status(201).json(p);
  }));

  app.post('/api/posts/:id/pin', requireManager, wrap(async (req, res) => {
    const p = await loadPost(req);
    if (p.parent_id) throw bad('reply_pin', 'Pin the first post of the thread');
    const pinned = (req.body || {}).pinned !== false;
    const out = await store.updatePost(req.user.org_id, p.id, { pinned });
    audit(req, pinned ? 'post.pin' : 'post.unpin', p.id);
    res.json(out);
  }));

  // Removed, not deleted: hidden from the board, kept for the record.
  app.delete('/api/posts/:id', requireUser, wrap(async (req, res) => {
    const p = await loadPost(req);
    if (!req.user.can_manage && !mine(req, p)) throw forbidden('Only the author or a Vault manager can remove a post.');
    await store.updatePost(req.user.org_id, p.id, { removed_at: new Date().toISOString(), removed_by: req.user.name });
    audit(req, 'post.remove', p.id);
    res.status(204).end();
  }));

  // ---- for Cockpit's server only: counts, never a name or a note ----

  app.get('/api/cockpit/rollup', requireService, wrap(async (req, res) => {
    const asOf = clock();
    const year = asOf.slice(0, 4);
    const from = dayField(req.query.from, 'from') || `${year}-01-01`;
    const to = dayField(req.query.to, 'to') || `${year}-12-31`;
    if (to < from) throw bad('bad_period', 'The period ends before it starts');
    const org = req.user.org_id;
    const [live, archived, notes, posts] = await Promise.all([store.listClients(org), store.listClients(org, { archived: true }), store.listNotes(org), store.listPosts(org)]);
    const replies = await store.listReplies(org, posts.map((p) => p.id));
    res.json(rollup({ from, to, clients: [...live, ...archived], notes, posts: [...posts, ...replies] }, asOf));
  }));

  // ---- for Cockpit's server only: the organization's whole record ----
  // Cockpit's "Export everything" asks for this with its export token and
  // the organization in X-TSS-Org, and zips it with the other apps' exports.
  // Everything this organization has, struck notes, archived clients and
  // removed posts included, since nothing in Vault is deleted.

  app.get('/api/export/org', requireExport, wrap(async (req, res) => {
    const org = req.user.org_id;
    const [live, archived, notes, posts, activity] = await Promise.all([
      store.listClients(org), store.listClients(org, { archived: true }), store.listNotes(org), store.allPosts(org), store.activity(org, EXPORT_ACTIVITY_LIMIT),
    ]);
    const clients = [...live, ...archived];
    audit(req, 'export.org', 'everything', `${clients.length} clients, ${notes.length} case notes, ${posts.length} posts`);
    res.json({
      schema: 'tss.org-export/v1', app: 'vault', org_id: org, exported_at: new Date().toISOString(),
      tables: { clients, case_notes: notes, posts, activity }, files: [],
    });
  }));

  // ---- for another TSS app's server: the directory lookup at intake ----
  // Circles looks a client up here when it opens a case, so staff pick a
  // person already in the directory instead of typing them again. Open
  // clients only, at most ten, and only the fields an intake form fills.
  // Every lookup is logged with the app and the person asking, never with
  // what was typed. Nothing is written.

  const DIRECTORY_FIELDS = ['id', 'first_name', 'last_name', 'preferred_name', 'pronouns', 'date_of_birth', 'email', 'phone', 'program', 'status'];
  app.get('/api/service/clients', requireService, wrap(async (req, res) => {
    const q = str(req.query.q, 100);
    if (q.length < 2) throw bad('query_too_short', 'Type at least two letters of the name');
    const who = str(req.headers['x-tss-user'], 120) || 'a staff member';
    const found = (await store.listClients(req.user.org_id, { q })).slice(0, 10);
    audit(req, 'directory.lookup', `${found.length} match${found.length === 1 ? '' : 'es'}`, `by ${who}`);
    res.json({ clients: found.map((c) => Object.fromEntries(DIRECTORY_FIELDS.map((k) => [k, c[k] ?? '']))) });
  }));

  // Cockpit's "Needs you" list for one signed-in person (lib/records.js
  // needsYou): mentions, replies to their threads, their clients' check-ins.
  // Cockpit names the person in X-TSS-User (their Cockpit id, the same as a
  // session's) and X-TSS-User-Name (URI-encoded). Never a client's name or a
  // post's text.
  app.get('/api/cockpit/needs-you', requireService, wrap(async (req, res) => {
    const id = str(req.headers['x-tss-user'], 200);
    if (!id) throw bad('user_required', 'Name the person in X-TSS-User');
    let name = '';
    try { name = decodeURIComponent(String(req.headers['x-tss-user-name'] || '')); } catch (_) { name = ''; }
    const email = str(req.headers['x-tss-user-email'], 200);
    const org = req.user.org_id;
    const [clients, notes, posts] = await Promise.all([store.listClients(org), store.listNotes(org), store.listPosts(org)]);
    const replies = await store.listReplies(org, posts.map((p) => p.id));
    res.json(needsYou({ clients, notes, posts, replies }, clock(), { id, name: name.slice(0, 120), email }));
  }));

  // ---- export and import (CSV), managers only: this is client data ----

  const CLIENT_COLUMNS = ['first_name', 'last_name', 'preferred_name', 'pronouns', 'date_of_birth', 'email', 'phone', 'address', 'program', 'status', 'assigned_to', 'intake_on', 'emergency_contact', 'tags', 'summary'];

  app.get('/api/export/clients.csv', requireManager, wrap(async (req, res) => {
    const org = req.user.org_id;
    const rows = summarizeClients(await store.listClients(org), await store.listNotes(org), clock());
    audit(req, 'export.clients', `${rows.length} clients`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="vault-directory.csv"');
    res.send(toCsv([...CLIENT_COLUMNS, 'last_note', 'note_count'], rows));
  }));

  // Clients from a spreadsheet, in three steps: preview reads the columns and
  // guesses which field each fills; a dry run (dry_run: true) says row by row
  // what an import would do and writes nothing; the import does it. A client
  // already in the directory is matched (email, then name with the same date
  // of birth or phone, then name alone when nothing on either side tells them
  // apart) and the row fills in what it gives, so the same sheet imported
  // twice changes nothing the second time.
  const CLIENT_FIELDS = [
    { id: 'first_name', label: 'First name', aliases: ['first', 'firstname', 'given_name', 'client_first_name'] },
    { id: 'last_name', label: 'Last name', aliases: ['last', 'lastname', 'surname', 'family_name', 'client_last_name'] },
    { id: 'full_name', label: 'Full name (split into first and last)', aliases: ['name', 'full_name', 'client', 'client_name', 'participant', 'participant_name', 'youth', 'youth_name'] },
    { id: 'preferred_name', label: 'Preferred name', aliases: ['nickname', 'goes_by', 'chosen_name'] },
    { id: 'pronouns', label: 'Pronouns', aliases: ['pronoun'] },
    { id: 'date_of_birth', label: 'Date of birth', aliases: ['dob', 'birthdate', 'birth_date', 'birthday', 'born'] },
    { id: 'email', label: 'Email', aliases: ['email_address', 'e_mail', 'e_mail_address'] },
    { id: 'phone', label: 'Phone', aliases: ['phone_number', 'telephone', 'tel', 'mobile', 'cell', 'cell_phone'] },
    { id: 'address', label: 'Address', aliases: ['mailing_address', 'street', 'street_address', 'home_address'] },
    { id: 'program', label: 'Program', aliases: ['service', 'program_name', 'track'] },
    { id: 'status', label: 'Status', hint: CLIENT_STATUSES.join(', '), aliases: ['client_status', 'state'] },
    { id: 'assigned_to', label: 'Assigned to', aliases: ['case_worker', 'caseworker', 'case_manager', 'staff', 'worker', 'assigned', 'counselor', 'advocate'] },
    { id: 'intake_on', label: 'Intake date', aliases: ['intake_date', 'intake', 'enrolled', 'enrollment_date', 'start_date', 'date_enrolled'] },
    { id: 'emergency_contact', label: 'Emergency contact', aliases: ['emergency', 'emergency_contact_name', 'guardian', 'parent_guardian'] },
    { id: 'tags', label: 'Tags', aliases: ['tag', 'groups', 'labels'] },
    { id: 'summary', label: 'Summary', aliases: ['notes', 'note', 'comments', 'description', 'background'] },
  ];
  const STATUS_WORDS = { open: 'active', current: 'active', enrolled: 'active', waiting: 'waitlist', wait_list: 'waitlist', waitlisted: 'waitlist', pending: 'waitlist', closed: 'inactive', discharged: 'inactive', exited: 'inactive', former: 'inactive' };
  const splitName = (full) => {
    const s = str(full, 240);
    if (!s) return ['', ''];
    if (s.includes(',')) { const [last, ...rest] = s.split(','); return [rest.join(' ').trim(), last.trim()]; }
    const parts = s.split(/\s+/);
    return parts.length > 1 ? [parts.slice(0, -1).join(' '), parts.at(-1)] : [parts[0], ''];
  };

  app.post('/api/import/clients/preview', requireManager, wrap(async (req, res) => {
    const sheet = readSheet(str((req.body || {}).csv, 6_000_000));
    if (!sheet.headers.length) throw bad('empty_csv', 'The file is empty');
    res.json(previewOf(sheet, CLIENT_FIELDS));
  }));

  app.post('/api/import/clients', requireManager, wrap(async (req, res) => {
    const b = req.body || {};
    const dry = Boolean(b.dry_run);
    const sheet = readSheet(str(b.csv, 6_000_000));
    if (!sheet.rows.length) throw bad('empty_csv', 'The file has no rows under its header');
    if (sheet.rows.length > MAX_ROWS) throw bad('too_many_rows', `Import at most ${MAX_ROWS.toLocaleString('en-US')} rows at a time`);
    const rows = mappedRows(sheet, cleanMapping(b.mapping, sheet.headers, CLIENT_FIELDS));
    const org = req.user.org_id;
    const existing = [...(await store.listClients(org)), ...(await store.listClients(org, { archived: true }))];
    const byEmail = new Map(); const byName = new Map();
    const remember = (c) => {
      if (c.email) byEmail.set(c.email.toLowerCase(), c);
      const k = nameKey(c.first_name, c.last_name);
      if (k) byName.set(k, [...(byName.get(k) || []), c]);
    };
    existing.forEach(remember);
    const differ = (a, b) => Boolean(a && b && a !== b);
    const find = (g) => {
      if (g.email && byEmail.has(g.email)) return byEmail.get(g.email);
      const same = byName.get(nameKey(g.first_name || '', g.last_name || '')) || [];
      // Same name, and nothing on file says it is someone else.
      const fits = same.filter((c) => !differ(c.email, g.email) && !differ(c.date_of_birth, g.date_of_birth) && !differ(phoneKey(c.phone), phoneKey(g.phone)));
      const strong = fits.filter((c) => (g.date_of_birth && c.date_of_birth === g.date_of_birth) || (phoneKey(g.phone) && phoneKey(c.phone) === phoneKey(g.phone)));
      return strong[0] || (fits.length === 1 ? fits[0] : null);
    };
    const result = { dry_run: dry, added: 0, updated: 0, unchanged: 0, skipped: [], plan: [] };
    const plan = (p) => { if (result.plan.length < 200) result.plan.push(p); };
    for (const [i, r] of rows.entries()) {
      const line = i + 2;
      try {
        const [first, last] = splitName(r.full_name);
        const status = (r.status || '').toLowerCase().trim().replace(/\s+/g, '_');
        const given = Object.fromEntries(Object.entries({
          first_name: r.first_name || first, last_name: r.last_name || last, preferred_name: r.preferred_name,
          pronouns: r.pronouns, date_of_birth: readDay(r.date_of_birth), email: (r.email || '').toLowerCase(), phone: r.phone, address: r.address,
          program: r.program, status: STATUS_WORDS[status] || status || undefined, assigned_to: r.assigned_to,
          intake_on: readDay(r.intake_on), emergency_contact: r.emergency_contact, tags: r.tags, summary: r.summary,
        }).filter(([, v]) => v !== undefined && v !== ''));
        const match = find(given);
        if (match) {
          const patch = clientFields(given, match);
          const changed = Object.keys(patch).filter((k) => JSON.stringify(patch[k]) !== JSON.stringify(match[k] ?? (k === 'tags' ? [] : '')));
          if (!changed.length) { result.unchanged++; plan({ line, action: 'same', name: displayName(match) }); continue; }
          if (!dry) await store.updateClient(org, match.id, { ...patch, updated_by: req.user.name });
          Object.assign(match, patch);
          result.updated++;
          plan({ line, action: 'update', name: displayName(match), detail: changed.join(', ') });
        } else {
          const fields = clientFields(given);
          const c = dry ? { id: `new-${line}`, ...fields } : await store.createClient(org, { id: crypto.randomUUID(), ...fields, created_by: req.user.name });
          remember(c);
          result.added++;
          plan({ line, action: 'add', name: displayName(c) });
        }
      } catch (e) {
        const reason = e instanceof PublicError ? e.message : 'Could not read this row';
        result.skipped.push({ line, reason });
        plan({ line, action: 'skip', reason });
      }
    }
    if (!dry) audit(req, 'import.clients', `${result.added} added, ${result.updated} updated`, [result.unchanged && `${result.unchanged} already there`, result.skipped.length && `${result.skipped.length} skipped`].filter(Boolean).join(', '));
    res.json(result);
  }));

  app.get('/api/activity', requireManager, wrap(async (req, res) => {
    res.json({ activity: await store.activity(req.user.org_id, Math.min(Number(req.query.limit) || 100, 500)) });
  }));

  // ---- frontend and errors ----

  app.use('/api', (_req, res) => res.status(404).json({ error: 'No such endpoint', code: 'not_found' }));
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  app.use((err, req, res, _next) => {
    if (err?.type === 'entity.too.large') err = new PublicError(413, 'too_large', 'That upload is too large. Import at most a few thousand rows at a time.');
    if (err?.type === 'entity.parse.failed') err = new PublicError(400, 'bad_json', 'The request body was not valid JSON.');
    // One diagnostic id for the user's message, the log and the error tracker.
    const normalized = normalizePublicError(err);
    logSafeError(console, normalized, 'request_failed', requestContext(req));
    res.status(err && err.status >= 400 && err.status < 600 ? err.status : normalized.status).json(publicErrorBody(normalized));
  });

  return app;
}

const PORT = Number(process.env.PORT) || 8796;
if (process.env.NODE_ENV !== 'test' && process.argv[1] === fileURLToPath(import.meta.url)) {
  installCrashHandlers(errorReporter('tss-vault'));
  const store = await openStore();
  const cockpitLink = await createCockpitLink({ audience: 'vault', canEnter: CAN_ENTER, pool: store.kind === 'postgres' ? store.pool : null }).init();
  const server = createApp({ store, cockpitLink }).listen(PORT, () => console.log(`vault listening on ${PORT} (${store.kind} store)`));
  const stop = () => server.close(() => store.close().finally(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
