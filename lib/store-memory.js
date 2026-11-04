// In-memory store: development and tests. Everything is lost on restart, so
// production refuses it (lib/store.js). Same contract as lib/store-postgres.js;
// test/store.test.mjs runs one suite against both.
//
// Every method takes the organization first and answers only for it. Records
// are plain objects; dates are YYYY-MM-DD strings, timestamps ISO strings.
// Nothing is deleted: a client is archived, a mistaken note is struck (kept,
// marked, and left out of counts), a post is removed (kept, hidden).

const clone = (v) => structuredClone(v);
const now = () => new Date().toISOString();
const byDateDesc = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.created_at || '').localeCompare(a.created_at || '');

export const CLIENT_FIELDS = ['first_name', 'last_name', 'preferred_name', 'pronouns', 'date_of_birth', 'email', 'phone', 'address', 'program', 'status', 'assigned_to', 'intake_on', 'emergency_contact', 'tags', 'summary', 'archived_at', 'updated_by'];
export const POST_FIELDS = ['pinned', 'removed_at', 'removed_by'];

// Substring match over a client's names, contact details, program, worker, tags and summary.
export function clientMatches(c, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return true;
  const hay = [c.first_name, c.last_name, c.preferred_name, c.email, c.phone, c.program, c.assigned_to, (c.tags || []).join(' '), c.summary].join(' ').toLowerCase();
  return hay.includes(needle);
}

const sortName = (c) => `${(c.last_name || '').toLowerCase()}\u0000${(c.preferred_name || c.first_name || '').toLowerCase()}`;

export class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.clients = new Map();
    this.notes = new Map();
    this.posts = new Map();
    this.log_ = [];
  }

  async init() { return this; }
  async close() {}
  async ping() { return true; }

  own(map, org, id) {
    const r = map.get(id);
    return r && r.org_id === org ? r : null;
  }

  // ---- clients (the directory) ----

  async listClients(org, { q = '', status = '', archived = false } = {}) {
    return [...this.clients.values()]
      .filter((c) => c.org_id === org && Boolean(c.archived_at) === Boolean(archived) && (!status || c.status === status) && clientMatches(c, q))
      .map(clone)
      .sort((a, b) => sortName(a).localeCompare(sortName(b)));
  }

  async getClient(org, id) {
    const c = this.own(this.clients, org, id);
    return c ? clone(c) : null;
  }

  async createClient(org, rec) {
    const c = {
      first_name: '', last_name: '', preferred_name: '', pronouns: '', date_of_birth: null, email: '', phone: '', address: '',
      program: '', status: 'active', assigned_to: '', intake_on: null, emergency_contact: '', tags: [], summary: '', archived_at: null,
      ...clone(rec), org_id: org, created_at: now(), updated_at: now(),
    };
    c.updated_by = c.updated_by || c.created_by || '';
    this.clients.set(c.id, c);
    return clone(c);
  }

  async updateClient(org, id, patch) {
    const c = this.own(this.clients, org, id);
    if (!c) return null;
    for (const k of CLIENT_FIELDS) if (patch[k] !== undefined) c[k] = clone(patch[k]);
    c.updated_at = now();
    return clone(c);
  }

  // ---- case notes ----

  async listNotes(org, { client_id = null, from = null, to = null, kind = null, q = '', limit = null } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    const list = [...this.notes.values()]
      .filter((n) => n.org_id === org && (!client_id || n.client_id === client_id) && (!from || n.date >= from) && (!to || n.date <= to)
        && (!kind || n.kind === kind) && (!needle || n.body.toLowerCase().includes(needle)))
      .map(clone).sort(byDateDesc);
    return limit ? list.slice(0, limit) : list;
  }

  async getNote(org, id) {
    const n = this.own(this.notes, org, id);
    return n ? clone(n) : null;
  }

  async createNote(org, rec) {
    if (!this.own(this.clients, org, rec.client_id)) return null;
    if (this.notes.has(rec.id)) return false;   // the id is taken (a resend checks getNote first)
    const n = { kind: 'progress', body: '', created_by: '', created_by_id: '', struck_at: null, struck_by: '', strike_reason: '', ...clone(rec), org_id: org, created_at: now() };
    this.notes.set(n.id, n);
    return clone(n);
  }

  // A note is never edited or deleted. One written by mistake is struck.
  async strikeNote(org, id, { by, reason }) {
    const n = this.own(this.notes, org, id);
    if (!n) return null;
    if (!n.struck_at) Object.assign(n, { struck_at: now(), struck_by: by || '', strike_reason: reason || '' });
    return clone(n);
  }

  // ---- message board ----

  async listPosts(org, { parent_id = null, client_id = null, removed = false, limit = null } = {}) {
    const list = [...this.posts.values()]
      .filter((p) => p.org_id === org && (parent_id === undefined || (p.parent_id || null) === parent_id) && (!client_id || p.client_id === client_id) && (removed || !p.removed_at))
      .map(clone)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '') || String(b.id).localeCompare(String(a.id)));
    return limit ? list.slice(0, limit) : list;
  }

  // Every post and reply, removed ones included, oldest first: the export.
  async allPosts(org) {
    return [...this.posts.values()]
      .filter((p) => p.org_id === org)
      .map(clone)
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '') || String(a.id).localeCompare(String(b.id)));
  }

  async listReplies(org, parentIds) {
    const want = new Set(parentIds);
    return [...this.posts.values()]
      .filter((p) => p.org_id === org && p.parent_id && want.has(p.parent_id) && !p.removed_at)
      .map(clone)
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '') || String(a.id).localeCompare(String(b.id)));
  }

  async getPost(org, id) {
    const p = this.own(this.posts, org, id);
    return p ? clone(p) : null;
  }

  async createPost(org, rec) {
    if (rec.client_id && !this.own(this.clients, org, rec.client_id)) return null;
    if (rec.parent_id) {
      const parent = this.own(this.posts, org, rec.parent_id);
      if (!parent || parent.parent_id) return null;
    }
    const p = { parent_id: null, client_id: null, created_by: '', created_by_id: '', pinned: false, removed_at: null, removed_by: '', ...clone(rec), org_id: org, created_at: rec.created_at || now() };
    this.posts.set(p.id, p);
    return clone(p);
  }

  async updatePost(org, id, patch) {
    const p = this.own(this.posts, org, id);
    if (!p) return null;
    for (const k of POST_FIELDS) if (patch[k] !== undefined) p[k] = clone(patch[k]);
    return clone(p);
  }

  // ---- activity ----

  async log(org, { actor, action, target = '', detail = '' }) {
    this.log_.push({ id: this.log_.length + 1, org_id: org, at: now(), actor, action, target, detail: String(detail).slice(0, 500) });
  }

  async activity(org, limit = 100) {
    return this.log_.filter((e) => e.org_id === org).slice(-limit).reverse().map(clone);
  }
}
