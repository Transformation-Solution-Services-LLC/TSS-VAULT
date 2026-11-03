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
export const NOTE_KINDS = ['progress', 'contact', 'event', 'incident', 'other'];

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
