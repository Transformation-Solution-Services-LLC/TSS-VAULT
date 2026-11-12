// Postgres store: production. Same contract as lib/store-memory.js.
//
// Every query names the organization, so one database serves every
// organization in Cockpit without mixing them. The schema is created on start
// and only ever added to; an advisory lock keeps two instances starting at
// once from racing each other.

import pg from 'pg';
import { CLIENT_FIELDS, POST_FIELDS } from './store-memory.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vault_clients (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  first_name text NOT NULL DEFAULT '',
  last_name text NOT NULL DEFAULT '',
  preferred_name text NOT NULL DEFAULT '',
  pronouns text NOT NULL DEFAULT '',
  date_of_birth date,
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  program text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  assigned_to text NOT NULL DEFAULT '',
  intake_on date,
  emergency_contact text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  summary text NOT NULL DEFAULT '',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS vault_clients_org ON vault_clients (org_id, last_name, first_name);

CREATE TABLE IF NOT EXISTS vault_notes (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  client_id uuid NOT NULL REFERENCES vault_clients (id),
  date date NOT NULL,
  kind text NOT NULL DEFAULT 'progress',
  body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT '',
  created_by_id text NOT NULL DEFAULT '',
  struck_at timestamptz,
  struck_by text NOT NULL DEFAULT '',
  strike_reason text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS vault_notes_org ON vault_notes (org_id, date DESC);
CREATE INDEX IF NOT EXISTS vault_notes_client ON vault_notes (org_id, client_id, date DESC);

CREATE TABLE IF NOT EXISTS vault_posts (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  parent_id uuid REFERENCES vault_posts (id),
  client_id uuid REFERENCES vault_clients (id),
  body text NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT '',
  created_by_id text NOT NULL DEFAULT '',
  removed_at timestamptz,
  removed_by text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS vault_posts_org ON vault_posts (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS vault_posts_parent ON vault_posts (org_id, parent_id);

CREATE TABLE IF NOT EXISTS vault_activity (
  id bigserial PRIMARY KEY,
  org_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL DEFAULT '',
  action text NOT NULL,
  target text NOT NULL DEFAULT '',
  detail text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS vault_activity_org ON vault_activity (org_id, at DESC);

-- Imports from another system (Regroup or a spreadsheet): the client's id
-- there, so its notes find the client, and where an imported note came from.
ALTER TABLE vault_clients ADD COLUMN IF NOT EXISTS external_id text;
CREATE INDEX IF NOT EXISTS vault_clients_external ON vault_clients (org_id, external_id) WHERE external_id IS NOT NULL;
ALTER TABLE vault_notes ADD COLUMN IF NOT EXISTS imported_from text;
`;

const iso = (d) => (d instanceof Date ? d.toISOString() : d);
// A date column comes back as a Date at local midnight; the contract wants YYYY-MM-DD.
const day = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d);

const DATE_COLS = new Set(['date', 'date_of_birth', 'intake_on']);
const TIME_COLS = new Set(['created_at', 'updated_at', 'archived_at', 'struck_at', 'removed_at']);
function row(r) {
  if (!r) return null;
  const out = { ...r };
  for (const k of Object.keys(out)) {
    if (DATE_COLS.has(k)) out[k] = day(out[k]);
    else if (TIME_COLS.has(k)) out[k] = iso(out[k]);
  }
  return out;
}

export class PostgresStore {
  constructor(connectionString, { ssl } = {}) {
    this.kind = 'postgres';
    this.pool = new pg.Pool({ connectionString, max: Number(process.env.PG_POOL_MAX) || 10, ssl });
  }

  async init() {
    const c = await this.pool.connect();
    try {
      await c.query('SELECT pg_advisory_lock(7463)');
      try { await c.query(SCHEMA); } finally { await c.query('SELECT pg_advisory_unlock(7463)'); }
    } finally { c.release(); }
    return this;
  }

  async close() { await this.pool.end(); }
  async ping() { await this.pool.query('SELECT 1'); return true; }

  q(text, params) { return this.pool.query(text, params); }

  async owns(table, org, id) {
    if (!id) return true;
    const { rows } = await this.q(`SELECT 1 FROM ${table} WHERE org_id = $1 AND id = $2`, [org, id]);
    return rows.length > 0;
  }

  // ---- clients ----

  async listClients(org, { q = '', status = '', archived = false } = {}) {
    const { rows } = await this.q(
      `SELECT * FROM vault_clients
        WHERE org_id = $1 AND (archived_at IS NOT NULL) = $2
          AND ($3 = '' OR status = $3)
          AND ($4 = '' OR concat_ws(' ', first_name, last_name, preferred_name, email, phone, program, assigned_to, array_to_string(tags, ' '), summary) ILIKE '%' || $4 || '%')
        ORDER BY lower(last_name), lower(COALESCE(NULLIF(preferred_name, ''), first_name)), id`,
      [org, Boolean(archived), status || '', String(q || '').trim()]);
    return rows.map(row);
  }

  async getClient(org, id) {
    const { rows } = await this.q('SELECT * FROM vault_clients WHERE org_id = $1 AND id = $2', [org, id]);
    return row(rows[0]);
  }

  async createClient(org, rec) {
    const { rows } = await this.q(
      `INSERT INTO vault_clients (id, org_id, first_name, last_name, preferred_name, pronouns, date_of_birth, email, phone, address, program, status, assigned_to, intake_on, emergency_contact, tags, summary, created_by, updated_by, external_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18, $19) RETURNING *`,
      [rec.id, org, rec.first_name || '', rec.last_name || '', rec.preferred_name || '', rec.pronouns || '', rec.date_of_birth || null, rec.email || '', rec.phone || '', rec.address || '',
        rec.program || '', rec.status || 'active', rec.assigned_to || '', rec.intake_on || null, rec.emergency_contact || '', Array.isArray(rec.tags) ? rec.tags : [], rec.summary || '', rec.created_by || '', rec.external_id || null]);
    return row(rows[0]);
  }

  async updateClient(org, id, patch) {
    const sets = [];
    const params = [org, id];
    for (const k of CLIENT_FIELDS) {
      if (patch[k] === undefined) continue;
      params.push(patch[k]);
      sets.push(`${k} = $${params.length}`);
    }
    sets.push('updated_at = now()');
    const { rows } = await this.q(`UPDATE vault_clients SET ${sets.join(', ')} WHERE org_id = $1 AND id = $2 RETURNING *`, params);
    return row(rows[0]);
  }

  // ---- case notes ----

  async listNotes(org, { client_id = null, from = null, to = null, kind = null, q = '', limit = null } = {}) {
    const { rows } = await this.q(
      `SELECT * FROM vault_notes
        WHERE org_id = $1 AND ($2::uuid IS NULL OR client_id = $2) AND ($3::date IS NULL OR date >= $3) AND ($4::date IS NULL OR date <= $4)
          AND ($5::text IS NULL OR kind = $5) AND ($6 = '' OR body ILIKE '%' || $6 || '%')
        ORDER BY date DESC, created_at DESC
        LIMIT $7`, [org, client_id, from, to, kind, String(q || '').trim(), limit || null]);
    return rows.map(row);
  }

  async getNote(org, id) {
    const { rows } = await this.q('SELECT * FROM vault_notes WHERE org_id = $1 AND id = $2', [org, id]);
    return row(rows[0]);
  }

  async createNote(org, rec) {
    if (!(await this.owns('vault_clients', org, rec.client_id))) return null;
    const { rows } = await this.q(
      `INSERT INTO vault_notes (id, org_id, client_id, date, kind, body, created_by, created_by_id, imported_from) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING RETURNING *`,
      [rec.id, org, rec.client_id, rec.date, rec.kind || 'progress', rec.body || '', rec.created_by || '', rec.created_by_id || '', rec.imported_from || null]);
    return rows[0] ? row(rows[0]) : false;   // false: the id is taken
  }

  async strikeNote(org, id, { by, reason }) {
    await this.q(
      `UPDATE vault_notes SET struck_at = now(), struck_by = $3, strike_reason = $4 WHERE org_id = $1 AND id = $2 AND struck_at IS NULL`,
      [org, id, by || '', reason || '']);
    return this.getNote(org, id);
  }

  // ---- message board ----

  async listPosts(org, { parent_id = null, client_id = null, removed = false, limit = null } = {}) {
    const { rows } = await this.q(
      `SELECT * FROM vault_posts
        WHERE org_id = $1 AND (($2::uuid IS NULL AND parent_id IS NULL) OR parent_id = $2) AND ($3::uuid IS NULL OR client_id = $3) AND ($4::boolean OR removed_at IS NULL)
        ORDER BY created_at DESC, id DESC
        LIMIT $5`, [org, parent_id, client_id, Boolean(removed), limit || null]);
    return rows.map(row);
  }

  // Every post and reply, removed ones included, oldest first: the export.
  async allPosts(org) {
    const { rows } = await this.q('SELECT * FROM vault_posts WHERE org_id = $1 ORDER BY created_at, id', [org]);
    return rows.map(row);
  }

  async listReplies(org, parentIds) {
    if (!parentIds.length) return [];
    const { rows } = await this.q(
      `SELECT * FROM vault_posts WHERE org_id = $1 AND parent_id = ANY($2::uuid[]) AND removed_at IS NULL ORDER BY created_at, id`,
      [org, parentIds]);
    return rows.map(row);
  }

  async getPost(org, id) {
    const { rows } = await this.q('SELECT * FROM vault_posts WHERE org_id = $1 AND id = $2', [org, id]);
    return row(rows[0]);
  }

  async createPost(org, rec) {
    if (!(await this.owns('vault_clients', org, rec.client_id))) return null;
    if (rec.parent_id) {
      const parent = await this.getPost(org, rec.parent_id);
      if (!parent || parent.parent_id) return null;
    }
    const { rows } = await this.q(
      `INSERT INTO vault_posts (id, org_id, parent_id, client_id, body, created_by, created_by_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now())) RETURNING *`,
      [rec.id, org, rec.parent_id || null, rec.client_id || null, rec.body, rec.created_by || '', rec.created_by_id || '', rec.created_at || null]);
    return row(rows[0]);
  }

  async updatePost(org, id, patch) {
    const sets = [];
    const params = [org, id];
    for (const k of POST_FIELDS) {
      if (patch[k] === undefined) continue;
      params.push(patch[k]);
      sets.push(`${k} = $${params.length}`);
    }
    if (!sets.length) return this.getPost(org, id);
    const { rows } = await this.q(`UPDATE vault_posts SET ${sets.join(', ')} WHERE org_id = $1 AND id = $2 RETURNING *`, params);
    return row(rows[0]);
  }

  // ---- activity ----

  async log(org, { actor, action, target = '', detail = '' }) {
    await this.q('INSERT INTO vault_activity (org_id, actor, action, target, detail) VALUES ($1, $2, $3, $4, $5)',
      [org, actor || '', action, target, String(detail).slice(0, 500)]);
  }

  async activity(org, limit = 100) {
    const { rows } = await this.q('SELECT id, org_id, at, actor, action, target, detail FROM vault_activity WHERE org_id = $1 ORDER BY at DESC, id DESC LIMIT $2', [org, limit]);
    return rows.map((r) => ({ ...r, id: Number(r.id), at: iso(r.at) }));
  }
}
