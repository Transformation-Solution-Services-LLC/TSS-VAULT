// Page helpers with no DOM, so tests can import them: escaping and dates.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export const day = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
export const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const KIND = { progress: 'Progress', activity: 'Activity', contact: 'Contact', event: 'Event', incident: 'Incident', other: 'Other' };
export const STATUS = { active: 'Active', waitlist: 'Waitlist', inactive: 'Inactive' };

// Days since a date, in words.
export function ago(d, asOf) {
  if (!d) return 'never';
  const days = Math.round((Date.parse(`${asOf}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  return `${Math.round(days / 30)} months ago`;
}

// Age in whole years on a given day, from a YYYY-MM-DD date of birth.
export function age(dob, asOf) {
  if (!dob || !asOf) return null;
  const [y, m, d] = dob.split('-').map(Number);
  const [ty, tm, td] = asOf.split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

// The screen Cockpit asked to open with a launch ticket (#tss_launch=...&tss_to=...).
// Only a plain hash route is accepted; anything else opens the home screen.
export function launchRoute(hash) {
  const m = /(?:^#|&)tss_to=([^&]+)/.exec(String(hash || ''));
  if (!m) return '';
  let to = '';
  try { to = decodeURIComponent(m[1]); } catch (_) { return ''; }
  return /^#\/[A-Za-z0-9/_?=&.-]{0,300}$/.test(to) ? to : '';
}
