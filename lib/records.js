// The rules and figures of Vault, from plain lists of clients, case notes and
// message-board posts. Pure functions: the server loads one organization's
// rows from the store and asks here. Both stores give the same shapes, so
// this file is the one place a figure is defined.
//
// Dates are YYYY-MM-DD strings in the organization's local day. A timestamp
// (a post, a record made) is turned into a local day with localDay(), never
// by slicing the UTC string, which would date an evening post a day late.

// An active client with no case note for this long is flagged for a check-in.
export const CHECKIN_DAYS = 30;
export const CLIENT_STATUSES = ['active', 'waitlist', 'inactive'];
export const NOTE_KINDS = ['progress', 'activity', 'contact', 'event', 'incident', 'other'];

export const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T12:00:00`));

const zone = () => process.env.TZ_DISPLAY || 'America/Los_Angeles';

// A moment's calendar day in the organization's zone.
export function localDay(at = new Date(), tz = zone()) {
  const d = at instanceof Date ? at : new Date(at);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch (_) {
    return d.toISOString().slice(0, 10);
  }
}

export const today = (tz = zone(), at = new Date()) => localDay(at, tz);

export function daysBetween(fromDay, toDay) {
  if (!fromDay || !toDay) return Infinity;
  return Math.round((Date.parse(`${toDay}T12:00:00Z`) - Date.parse(`${fromDay}T12:00:00Z`)) / 86400000);
}

export function displayName(c) {
  if (!c) return '';
  const first = c.preferred_name || c.first_name;
  return [first, c.last_name].filter(Boolean).join(' ') || 'Unnamed';
}

// Struck notes stay on the record but count for nothing.
export const liveNotes = (notes) => notes.filter((n) => !n.struck_at);

export function lastNote(notes) {
  let last = '';
  for (const n of liveNotes(notes)) if (n.date && n.date > last) last = n.date;
  return last;
}

export function needsCheckin(client, notes, asOf) {
  if (client.archived_at || client.status !== 'active') return false;
  const last = lastNote(notes);
  // A client taken in recently is not overdue just for having no note yet.
  const since = last || client.intake_on || '';
  return daysBetween(since, asOf) > CHECKIN_DAYS;
}

// Each client with their note figures, for the directory.
export function summarizeClients(clients, notes, asOf) {
  const byClient = new Map();
  for (const n of notes) (byClient.get(n.client_id) || byClient.set(n.client_id, []).get(n.client_id)).push(n);
  return clients.map((c) => {
    const own = byClient.get(c.id) || [];
    return {
      ...c,
      name: displayName(c),
      note_count: liveNotes(own).length,
      last_note: lastNote(own) || null,
      needs_checkin: needsCheckin(c, own, asOf),
    };
  });
}

export function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while ((y < ty || (y === ty && m <= tm)) && out.length < 120) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// What Cockpit may see: counts for the period and a few point-in-time
// readings. Never a name, a note, a post or anything about one person.
export function rollup({ from, to, clients, notes, posts }, asOf) {
  const inPeriod = (d) => d && d >= from && d <= to;
  const live = clients.filter((c) => !c.archived_at);
  const active = live.filter((c) => c.status === 'active');
  const periodNotes = liveNotes(notes).filter((n) => inPeriod(n.date));
  const periodPosts = posts.filter((p) => !p.removed_at && inPeriod(localDay(p.created_at)));
  const newClients = clients.filter((c) => inPeriod(c.intake_on));
  const summaries = summarizeClients(active, notes, asOf);
  const months = monthsBetween(from, to);
  const by = (list, day) => months.map((month) => ({ month, value: list.filter((x) => day(x).startsWith(month)).length }));
  return {
    from, to,
    metrics: {
      clients_active: { value: active.length },
      clients_new: { value: newClients.length },
      case_notes: { value: periodNotes.length },
      clients_seen: { value: new Set(periodNotes.map((n) => n.client_id)).size },
      checkins_due: { value: summaries.filter((c) => c.needs_checkin).length },
      posts: { value: periodPosts.length },
    },
    series: {
      case_notes: by(periodNotes, (n) => n.date),
      clients_new: by(newClients, (c) => c.intake_on),
      posts: by(periodPosts, (p) => localDay(p.created_at)),
    },
  };
}

// ---- Cockpit's "Needs you" list for one person ----
//
// What waits for this person: posts that mention them (@First or @First Last),
// new replies to threads they started, and check-ins due on clients assigned
// to them. Staff names may appear (who wrote); a client's name, a post's text
// or a note never does. `to` is the Vault screen to open (a hash route).

export const MENTION_DAYS = 14;
export const REPLY_DAYS = 7;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whether a post's text names this person with an @.
export function mentions(body, name) {
  const full = String(name || '').trim().replace(/\s+/g, ' ');
  if (!full) return false;
  const first = full.split(' ')[0];
  const forms = [...new Set([full, first])].filter((f) => f.length >= 2).map(escapeRe);
  if (!forms.length) return false;
  return new RegExp(`(^|[^\\w@])@(${forms.join('|')})(?![\\w])`, 'i').test(String(body || ''));
}

export function needsYou({ clients, notes, posts, replies }, asOf, person, tz = zone()) {
  const items = [];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const dayOf = (p) => localDay(new Date(p.created_at), tz);
  const recent = (p, days) => daysBetween(dayOf(p), asOf) <= days;
  const notMine = (p) => p.created_by_id !== person.id;
  const roots = new Map(posts.map((p) => [p.id, p]));

  for (const p of [...posts, ...replies]) {
    if (p.removed_at || !notMine(p) || !recent(p, MENTION_DAYS) || !mentions(p.body, person.name)) continue;
    const thread = p.parent_id || p.id;
    items.push({
      id: `mention-${p.id}`, title: `${p.created_by || 'Someone'} mentioned you on the Message Board`,
      detail: p.parent_id ? 'In a reply.' : 'In a post.', due: dayOf(p), severity: 'due', to: `#/board?post=${thread}`,
    });
  }

  const byThread = new Map();
  for (const r of replies) {
    const root = roots.get(r.parent_id);
    if (!root || root.removed_at || r.removed_at || root.created_by_id !== person.id || !notMine(r) || !recent(r, REPLY_DAYS)) continue;
    (byThread.get(root.id) || byThread.set(root.id, []).get(root.id)).push(r);
  }
  for (const [id, list] of byThread) {
    const last = list.reduce((d, r) => (dayOf(r) > d ? dayOf(r) : d), '');
    items.push({
      id: `replies-${id}`, title: `${plural(list.length, 'new reply', 'new replies')} to your post`,
      detail: `Last on ${last}.`, due: last, severity: 'info', count: list.length, to: `#/board?post=${id}`,
    });
  }

  const me = [person.name, person.email].map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  const mine = clients.filter((c) => me.includes(String(c.assigned_to || '').trim().toLowerCase()));
  const due = summarizeClients(mine, notes.filter((n) => mine.some((c) => c.id === n.client_id)), asOf).filter((c) => c.needs_checkin);
  if (due.length) {
    items.push({
      id: 'checkins', title: `${plural(due.length, 'of your clients is', 'of your clients are')} due a check-in`,
      detail: `No case note in ${CHECKIN_DAYS} days.`, due: asOf, severity: 'overdue', count: due.length, to: '#/directory?filter=checkin',
    });
  }
  return { as_of: asOf, items };
}
