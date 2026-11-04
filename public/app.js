// Vault frontend. Vanilla modules, no build step, same as Library and
// Rollodex. All server text goes through esc() before innerHTML. Views are
// addressed by hash: #/board, #/notes, #/directory, #/directory/<id>...

const $ = (sel, root = document) => root.querySelector(sel);

import { esc, day, when, KIND, STATUS, ago, age } from './util.js';

const state = { token: null, name: '', org: '', canManage: false, me: null, today: new Date().toISOString().slice(0, 10) };

try {
  state.token = sessionStorage.getItem('vault.token');
  state.name = sessionStorage.getItem('vault.name') || '';
  state.org = sessionStorage.getItem('vault.org') || '';
  state.canManage = sessionStorage.getItem('vault.manage') === '1';
} catch (_) { /* storage blocked: Cockpit signs you in each visit */ }

function remember(key, value) { try { sessionStorage.setItem(key, value); } catch (_) { /* ignore */ } }

function saveSession(j) {
  state.token = j.token; state.name = j.name; state.org = j.org?.name || ''; state.canManage = Boolean(j.can_manage);
  remember('vault.token', j.token); remember('vault.name', j.name); remember('vault.org', state.org); remember('vault.manage', state.canManage ? '1' : '0');
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401 && !path.startsWith('/api/auth/')) { signOut(); throw new Error('Sign in again'); }
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

function signOut() {
  state.token = null;
  try { sessionStorage.removeItem('vault.token'); } catch (_) { /* ignore */ }
  showLogin();
}

const fail = (err) => alert(err.message);

// Downloads with the session token, then hands the browser a file.
async function download(path, name) {
  const r = await fetch(path, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Download failed');
  const url = URL.createObjectURL(await r.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- sign in: Cockpit sends a launch ticket in the address fragment ----

function takeTicket() {
  const m = /(?:^#|&)tss_launch=([^&]+)/.exec(location.hash);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return decodeURIComponent(m[1]);
}

async function showLogin(error = '') {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-error').textContent = error;
  const h = await fetch('/api/health').then((r) => r.json()).catch(() => null);
  const link = $('#cockpit-link');
  link.hidden = !h?.cockpit_url;
  link.onclick = () => { location.href = h.cockpit_url; };
  if (!h?.cockpit_url) $('#login-message').textContent = 'Sign-in through Cockpit is not set up on this server yet.';
  $('#dev-signin').hidden = !h?.dev_signin;
}

$('#dev-signin').addEventListener('click', async () => {
  try { saveSession(await api('/api/auth/dev', { method: 'POST' })); boot(); } catch (err) { $('#login-error').textContent = err.message; }
});

// ---- modal forms ----

function openModal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
  $('#modal-body input, #modal-body select, #modal-body textarea')?.focus();
}
function closeModal() { $('#modal').hidden = true; $('#modal-body').innerHTML = ''; }
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

const options = (list, labels, selected) => list.map((v) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(labels?.[v] || v)}</option>`).join('');

// Reads a form into an object; checkboxes become booleans, blanks stay blank.
function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

const formEnd = '<p class="error" id="f-error"></p><div class="row"><button class="primary">Save</button><button type="button" id="cancel">Cancel</button></div></form>';

function clientForm(c = {}) {
  return `<form id="f" class="form"><h3>${c.id ? 'Edit client' : 'New client'}</h3>
    <div class="three"><label><span>First name</span><input name="first_name" value="${esc(c.first_name)}"></label><label><span>Last name</span><input name="last_name" value="${esc(c.last_name)}"></label><label><span>Goes by</span><input name="preferred_name" value="${esc(c.preferred_name)}"></label></div>
    <div class="three"><label><span>Pronouns</span><input name="pronouns" value="${esc(c.pronouns)}"></label><label><span>Date of birth</span><input name="date_of_birth" type="date" value="${esc(c.date_of_birth || '')}" max="${esc(state.today)}"></label>
    <label><span>Status</span><select name="status">${options(state.me.options.statuses, STATUS, c.status || 'active')}</select></label></div>
    <div class="three"><label><span>Program</span><input name="program" value="${esc(c.program)}"></label><label><span>Assigned to</span><input name="assigned_to" value="${esc(c.assigned_to ?? (c.id ? '' : state.name))}"></label>
    <label><span>Intake date</span><input name="intake_on" type="date" value="${esc(c.intake_on || state.today)}" max="${esc(state.today)}"></label></div>
    <div class="two"><label><span>Email</span><input name="email" type="email" value="${esc(c.email)}"></label><label><span>Phone</span><input name="phone" value="${esc(c.phone)}"></label></div>
    <label><span>Address</span><textarea name="address" rows="2">${esc(c.address)}</textarea></label>
    <label><span>Emergency contact</span><input name="emergency_contact" value="${esc(c.emergency_contact)}" placeholder="Name, relationship, phone"></label>
    <label><span>Tags (comma separated)</span><input name="tags" value="${esc((c.tags || []).join(', '))}"></label>
    <label><span>Summary</span><textarea name="summary" rows="3" placeholder="Who they are and what they are working on">${esc(c.summary)}</textarea></label>
    ${formEnd}`;
}

function noteForm({ client } = {}) {
  return `<form id="f" class="form"><h3>${client ? `Case note for ${esc(client.name)}` : 'New case note'}</h3>
    ${client ? '' : '<label><span>Client</span><input name="client_search" placeholder="Type a name" autocomplete="off"><input type="hidden" name="client_id"><div id="client-hits" class="row"></div></label>'}
    <div class="two"><label><span>Date</span><input name="date" type="date" value="${esc(state.today)}" max="${esc(state.today)}" required></label>
    <label><span>Kind</span><select name="kind">${options(state.me.options.note_kinds, KIND, 'progress')}</select></label></div>
    <label><span>What happened, what comes next</span><textarea name="body" rows="6" required></textarea></label>
    <p class="muted">Signed ${esc(state.name)}. A note cannot be edited after it is saved; one written in error is struck, and stays on the record.</p>
    ${formEnd}`;
}

// Opens a form in the modal; `submit(values)` saves, then `after()` redraws.
function modalForm(html, submit, after) {
  openModal(html);
  const form = $('#f');
  $('#cancel').onclick = closeModal;
  wireClientPicker(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = formData(form);
    delete values.client_search;
    try { await submit(values); closeModal(); await after?.(); } catch (err) { $('#f-error').textContent = err.message; }
  });
}

// A client picker for forms opened away from a client's page.
function wireClientPicker(form) {
  const input = form.elements.client_search;
  if (!input) return;
  const hits = $('#client-hits');
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    form.elements.client_id.value = '';
    timer = setTimeout(async () => {
      if (input.value.trim().length < 2) { hits.innerHTML = ''; return; }
      const { clients } = await api(`/api/clients?q=${encodeURIComponent(input.value.trim())}`);
      hits.innerHTML = clients.slice(0, 8).map((c) => `<button type="button" class="small" data-id="${esc(c.id)}" data-name="${esc(c.name)}">${esc(c.name)}${c.program ? ` <span class="muted">${esc(c.program)}</span>` : ''}</button>`).join('') || '<span class="muted">No match.</span>';
      hits.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { form.elements.client_id.value = b.dataset.id; input.value = b.dataset.name; hits.innerHTML = ''; }));
    }, 200);
  });
}

function wireRows() {
  document.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a, button')) location.hash = tr.dataset.href; }));
}

// ---- routing ----

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [view = 'home', id] = hash.split('?')[0].split('/');
  document.querySelectorAll('.nav a').forEach((a) => a.setAttribute('aria-current', String(a.dataset.view === (view || 'home'))));
  const views = { home: showHome, board: showBoard, notes: showNotes, directory: id ? () => showClient(id) : showDirectory, import: showImport, activity: showActivity };
  (views[view] || showHome)().catch(fail);
}

const params = () => new URLSearchParams(location.hash.split('?')[1] || '');

// ---- home: exactly three buttons ----

async function showHome() {
  const h = await api('/api/home');
  state.today = h.as_of;
  const d = h.directory;
  $('#view').innerHTML = `
    <div class="head"><div><h2>${esc(state.org) || 'Vault'}</h2><p class="muted">Signed in as ${esc(state.name)}.</p></div></div>
    <div class="doors">
      <a class="door" href="#/board"><span class="t">Message Board</span><span class="d">Internal work messages for the team.</span>
        <span class="c">${h.board.recent.length ? `Latest: ${esc(h.board.recent[0].created_by)}, ${esc(when(h.board.recent[0].created_at))}` : 'No posts yet.'}</span></a>
      <a class="door" href="#/notes"><span class="t">Case Notes</span><span class="d">Progress and event notes, dated and signed.</span>
        <span class="c">${h.notes.this_week} note${h.notes.this_week === 1 ? '' : 's'} in the last 7 days.</span></a>
      <a class="door" href="#/directory"><span class="t">Directory</span><span class="d">Client profiles and each client's notes.</span>
        <span class="c">${d.active} active of ${d.clients}${d.checkins_due ? `. <strong>${d.checkins_due} need a check-in</strong>` : ''}.</span></a>
    </div>
    <div class="grid2">
      <div class="card"><h3>Recent case notes</h3>
        ${h.notes.recent.length ? `<ul class="timeline">${h.notes.recent.map((n) => `<li><span class="when">${esc(day(n.date))}<br><span class="badge">${esc(KIND[n.kind] || n.kind)}</span></span><span class="what"><a href="#/directory/${esc(n.client_id)}">${esc(n.client_name)}</a>: ${esc(n.body.length > 160 ? `${n.body.slice(0, 160)}…` : n.body)}<br><span class="muted">${esc(n.created_by)}</span></span></li>`).join('')}</ul>` : '<p class="empty">No case notes yet.</p>'}</div>
      <div class="card"><h3>Due for a check-in</h3><p class="muted">Active clients with no note in ${state.me.options.checkin_days} days.</p>
        ${h.checkins.length ? `<table class="list"><tbody>${h.checkins.map((c) => `<tr data-href="#/directory/${esc(c.id)}"><td><strong>${esc(c.name)}</strong><br><span class="muted">${esc(c.assigned_to || 'Unassigned')}</span></td><td class="num">${esc(ago(c.last_note, h.as_of))}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">Everyone has a recent note.</p>'}</div>
    </div>`;
  wireRows();
}

// ---- message board ----

function postHtml(p, { reply = false } = {}) {
  const tools = [
    !reply && state.canManage ? `<button class="small" data-pin="${esc(p.id)}" data-pinned="${p.pinned ? '1' : ''}">${p.pinned ? 'Unpin' : 'Pin'}</button>` : '',
    p.can_remove ? `<button class="small" data-remove="${esc(p.id)}">Remove</button>` : '',
  ].join('');
  const meta = `<div class="meta"><strong>${esc(p.created_by)}</strong><span>${esc(when(p.created_at))}</span>${p.pinned ? '<span class="badge accent">Pinned</span>' : ''}${p.client_id ? `<a class="badge" href="#/directory/${esc(p.client_id)}">${esc(p.client_name)}</a>` : ''}${tools ? `<span class="ptools">${tools}</span>` : ''}</div>`;
  if (reply) return `<li>${meta}<div class="body">${esc(p.body)}</div></li>`;
  return `<li class="post ${p.pinned ? 'pinned' : ''}">${meta}<div class="body">${esc(p.body)}</div>
    ${p.replies.length ? `<ul class="replies">${p.replies.map((r) => postHtml(r, { reply: true })).join('')}</ul>` : ''}
    <form class="reply-form" data-reply="${esc(p.id)}"><input name="body" placeholder="Reply" aria-label="Reply"><button class="small">Reply</button></form></li>`;
}

function wireBoard(again) {
  document.querySelectorAll('[data-reply]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = f.elements.body.value.trim();
    if (!body) return;
    try { await api(`/api/posts/${f.dataset.reply}/replies`, { method: 'POST', body: { body } }); again(); } catch (err) { fail(err); }
  }));
  document.querySelectorAll('[data-pin]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/posts/${b.dataset.pin}/pin`, { method: 'POST', body: { pinned: !b.dataset.pinned } }); again(); } catch (err) { fail(err); }
  }));
  document.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Remove this message from the board?')) return;
    try { await api(`/api/posts/${b.dataset.remove}`, { method: 'DELETE' }); again(); } catch (err) { fail(err); }
  }));
}

async function showBoard() {
  const { posts } = await api('/api/posts');
  $('#view').innerHTML = `
    <div class="head"><div><h2>Message Board</h2><p class="muted">Internal to ${esc(state.org) || 'your organization'}. Keep client details in case notes.</p></div></div>
    <form id="compose" class="card compose"><label><span>New message</span><textarea name="body" rows="3" required></textarea></label>
      <div class="row"><button class="primary">Post</button><p id="compose-error" class="error"></p></div></form>
    ${posts.length ? `<ul class="posts">${posts.map((p) => postHtml(p)).join('')}</ul>` : '<p class="empty">No messages yet.</p>'}`;
  $('#compose').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/posts', { method: 'POST', body: { body: e.target.elements.body.value } }); showBoard(); } catch (err) { $('#compose-error').textContent = err.message; }
  });
  wireBoard(showBoard);
}

// ---- case notes ----

function noteItem(n, { withClient = true } = {}) {
  return `<li class="${n.struck_at ? 'struck' : ''}"><span class="when">${esc(day(n.date))}<br><span class="badge">${esc(KIND[n.kind] || n.kind)}</span></span>
    <span class="what">${withClient ? `<a href="#/directory/${esc(n.client_id)}">${esc(n.client_name)}</a><br>` : ''}${esc(n.body)}<br><span class="muted">${esc(n.created_by)}, ${esc(when(n.created_at))}</span>
    ${n.struck_at ? `<br><span class="badge bad">Struck by ${esc(n.struck_by)}: ${esc(n.strike_reason)}</span>` : ''}</span>
    ${n.can_strike ? `<button class="small" data-strike="${esc(n.id)}">Strike</button>` : ''}</li>`;
}

function wireStrike(again) {
  document.querySelectorAll('[data-strike]').forEach((b) => b.addEventListener('click', async () => {
    const reason = prompt('Why is this note struck? It stays on the record, marked.');
    if (!reason || !reason.trim()) return;
    try { await api(`/api/notes/${b.dataset.strike}/strike`, { method: 'POST', body: { reason } }); again(); } catch (err) { fail(err); }
  }));
}

async function showNotes() {
  const p = params();
  const q = p.get('q') || '';
  const kind = p.get('kind') || '';
  const from = p.get('from') || '';
  const to = p.get('to') || '';
  const { notes } = await api(`/api/notes?${new URLSearchParams({ q, kind, from, to })}`);
  $('#view').innerHTML = `
    <div class="head"><div><h2>Case Notes</h2><p class="muted">${notes.length} note${notes.length === 1 ? '' : 's'}${notes.length === 300 ? ' (the latest 300)' : ''}.</p></div>
      <div class="row"><button id="add" class="primary">New case note</button></div></div>
    <form id="filters" class="toolbar">
      <input type="search" name="q" value="${esc(q)}" placeholder="Search note text" aria-label="Search">
      <select name="kind"><option value="">All kinds</option>${options(state.me.options.note_kinds, KIND, kind)}</select>
      <label class="row">From <input name="from" type="date" value="${esc(from)}"></label><label class="row">to <input name="to" type="date" value="${esc(to)}"></label>
      <button class="small">Apply</button>
    </form>
    <div class="card">${notes.length ? `<ul class="timeline">${notes.map((n) => noteItem(n)).join('')}</ul>` : '<p class="empty">No notes match.</p>'}</div>`;
  $('#filters').addEventListener('submit', (e) => {
    e.preventDefault();
    const out = new URLSearchParams();
    for (const [k, v] of Object.entries(formData(e.target))) if (v) out.set(k, v);
    location.hash = `#/notes${out.toString() ? `?${out}` : ''}`;
  });
  $('#add').onclick = () => modalForm(noteForm(), (v) => {
    if (!v.client_id) throw new Error('Pick the client from the list');
    return api(`/api/clients/${v.client_id}/notes`, { method: 'POST', body: v });
  }, showNotes);
  wireStrike(showNotes);
}

// ---- directory ----

async function showDirectory() {
  const p = params();
  const q = p.get('q') || '';
  const status = p.get('status') || '';
  const filter = p.get('filter') || '';
  const archived = p.get('archived') === '1';
  const { clients, total, as_of } = await api(`/api/clients?${new URLSearchParams({ q, status, filter, archived: archived ? '1' : '' })}`);
  state.today = as_of;
  $('#view').innerHTML = `
    <div class="head"><div><h2>Directory</h2><p class="muted">${clients.length} of ${total}${archived ? ' archived' : ''} client${total === 1 ? '' : 's'}.</p></div>
      <div class="row">${state.canManage ? '<button id="add" class="primary">Add client</button><button id="export">Export CSV</button>' : ''}</div></div>
    <form id="filters" class="toolbar">
      <input type="search" name="q" value="${esc(q)}" placeholder="Search name, phone, email, program, worker, tags" aria-label="Search">
      <select name="status"><option value="">Any status</option>${options(state.me.options.statuses, STATUS, status)}</select>
      <select name="filter">${options(['', 'checkin'], { '': 'Everyone', checkin: 'Due for a check-in' }, filter)}</select>
      <label class="row"><input type="checkbox" name="archived" ${archived ? 'checked' : ''}> Archived</label>
    </form>
    ${clients.length ? `<table class="list"><thead><tr><th class="keep">Name</th><th>Program</th><th>Assigned to</th><th class="keep">Last note</th><th>Status</th></tr></thead><tbody>
      ${clients.map((c) => `<tr data-href="#/directory/${esc(c.id)}"><td class="keep"><strong>${esc(c.name)}</strong>${c.pronouns ? ` <span class="muted">(${esc(c.pronouns)})</span>` : ''}${c.phone ? `<br><span class="muted">${esc(c.phone)}</span>` : ''}</td>
        <td>${esc(c.program)}</td><td>${esc(c.assigned_to)}</td><td class="keep">${esc(ago(c.last_note, as_of))}</td>
        <td><span class="badge ${c.status === 'active' ? 'good' : c.status === 'waitlist' ? 'warn' : ''}">${esc(STATUS[c.status] || c.status)}</span>${c.needs_checkin ? ' <span class="badge warn">Check in</span>' : ''}</td></tr>`).join('')}
    </tbody></table>` : `<p class="empty">${total ? 'No clients match.' : state.canManage ? 'No clients yet. Add one, or import a spreadsheet.' : 'No clients yet.'}</p>`}`;
  wireRows();
  const form = $('#filters');
  const apply = () => {
    const out = new URLSearchParams();
    for (const [k, v] of Object.entries(formData(form))) if (v) out.set(k, v === true ? '1' : v);
    location.hash = `#/directory${out.toString() ? `?${out}` : ''}`;
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
  form.querySelectorAll('select, input[type=checkbox]').forEach((el) => el.addEventListener('change', apply));
  $('#add')?.addEventListener('click', () => modalForm(clientForm(), async (v) => { const c = await api('/api/clients', { method: 'POST', body: v }); location.hash = `#/directory/${c.id}`; }));
  $('#export')?.addEventListener('click', () => download('/api/export/clients.csv', 'vault-directory.csv').catch(fail));
}

async function showClient(id) {
  const c = await api(`/api/clients/${encodeURIComponent(id)}`);
  const m = state.canManage;
  const years = age(c.date_of_birth, state.today);
  const facts = [
    ['Goes by', c.preferred_name], ['Pronouns', c.pronouns], ['Date of birth', c.date_of_birth ? `${day(c.date_of_birth)}${years !== null ? ` (${years})` : ''}` : ''],
    ['Program', c.program], ['Assigned to', c.assigned_to], ['Intake', day(c.intake_on)], ['Emergency contact', c.emergency_contact],
  ].filter(([, v]) => v);
  $('#view').innerHTML = `
    <p><a href="#/directory">Directory</a></p>
    <div class="head"><div><h2>${esc(c.name)}${c.archived_at ? ' <span class="badge">Archived</span>' : ''}</h2>
      <p><span class="badge ${c.status === 'active' ? 'good' : c.status === 'waitlist' ? 'warn' : ''}">${esc(STATUS[c.status] || c.status)}</span>${c.needs_checkin ? ` <span class="badge warn">Check in: last note ${esc(ago(c.last_note, state.today))}</span>` : ''}${(c.tags || []).map((t) => ` <span class="badge">${esc(t)}</span>`).join('')}</p>
      <p>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}${c.email && c.phone ? ' · ' : ''}${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ''}${c.address ? `<br><span class="notes">${esc(c.address)}</span>` : ''}</p></div>
      <div class="row"><button id="note" class="primary">New case note</button>${m ? `<button id="edit">Edit</button><button id="archive">${c.archived_at ? 'Restore' : 'Archive'}</button>` : ''}</div></div>
    ${facts.length ? `<div class="tiles">${facts.map(([l, v]) => `<div class="tile"><div class="l">${esc(l)}</div><div>${esc(v)}</div></div>`).join('')}</div>` : ''}
    ${c.summary ? `<div class="card"><h3>Summary</h3><p class="notes">${esc(c.summary)}</p></div>` : ''}
    <div class="grid2">
      <div class="card"><h3>Case notes (${c.note_count})</h3>
        ${c.notes.length ? `<ul class="timeline">${c.notes.map((n) => noteItem(n, { withClient: false })).join('')}</ul>` : '<p class="empty">No case notes yet.</p>'}</div>
      <div class="card"><h3>On the message board</h3>
        <form id="compose" class="compose"><textarea name="body" rows="2" placeholder="Post about ${esc(c.name)} for the team" aria-label="Message"></textarea><div class="row"><button class="small">Post</button></div></form>
        ${c.posts.length ? `<ul class="posts">${c.posts.map((p) => postHtml(p)).join('')}</ul>` : '<p class="empty">No posts about this client.</p>'}</div>
    </div>`;
  const again = () => showClient(id);
  $('#note').onclick = () => modalForm(noteForm({ client: c }), (v) => api(`/api/clients/${id}/notes`, { method: 'POST', body: v }), again);
  $('#edit')?.addEventListener('click', () => modalForm(clientForm(c), (v) => api(`/api/clients/${id}`, { method: 'PATCH', body: v }), again));
  $('#archive')?.addEventListener('click', async () => {
    if (!c.archived_at && !confirm(`Archive ${c.name}? Notes stay on the record; the client leaves the directory list.`)) return;
    try { await api(`/api/clients/${id}/${c.archived_at ? 'unarchive' : 'archive'}`, { method: 'POST' }); again(); } catch (err) { fail(err); }
  });
  $('#compose').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = e.target.elements.body.value.trim();
    if (!body) return;
    try { await api('/api/posts', { method: 'POST', body: { body, client_id: id } }); again(); } catch (err) { fail(err); }
  });
  wireStrike(again);
  wireBoard(again);
}

// ---- import and activity (managers) ----

async function showImport() {
  $('#view').innerHTML = `<h2>Import clients</h2>
    <p class="muted">Save the sheet as CSV. Column names are matched by name in any order; extra columns are ignored.</p>
    <div class="card"><p>Columns: <code>first_name, last_name, preferred_name, pronouns, date_of_birth, email, phone, address, program, status, assigned_to, intake_on, emergency_contact, tags, summary</code>. Dates like 2026-03-31. A row whose email matches an existing client updates that client.</p>
      <input type="file" id="clients-file" accept=".csv,text/csv"><p id="clients-status" class="status" aria-live="polite"></p></div>`;
  $('#clients-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const status = $('#clients-status');
    status.textContent = `Importing ${file.name}…`;
    try {
      const r = await api('/api/import/clients', { method: 'POST', body: { csv: await file.text() } });
      status.innerHTML = `${r.added} added, ${r.updated} updated.${r.skipped.length ? `<br><span class="error">${r.skipped.length} row${r.skipped.length === 1 ? '' : 's'} skipped:</span><br>${r.skipped.slice(0, 20).map((s) => `line ${s.line}: ${esc(s.reason)}`).join('<br>')}${r.skipped.length > 20 ? '<br>…' : ''}` : ''}`;
    } catch (err) { status.textContent = err.message; }
    e.target.value = '';
  });
}

async function showActivity() {
  const { activity } = await api('/api/activity');
  const LABEL = {
    'client.add': 'Added client', 'client.update': 'Changed client', 'client.archive': 'Archived client', 'client.unarchive': 'Restored client',
    'note.add': 'Wrote a case note for', 'note.strike': 'Struck a case note', 'post.add': 'Posted', 'post.reply': 'Replied to a post',
    'post.pin': 'Pinned a post', 'post.unpin': 'Unpinned a post', 'post.remove': 'Removed a post', 'import.clients': 'Imported clients', 'export.clients': 'Exported the directory', 'directory.lookup': 'Looked up the directory for intake',
  };
  $('#view').innerHTML = `<h2>Activity</h2>
    <table class="list"><thead><tr><th class="keep">When</th><th class="keep">Who</th><th class="keep">What</th></tr></thead><tbody>
    ${activity.map((e) => `<tr><td class="keep">${esc(when(e.at))}</td><td class="keep">${esc(e.actor)}</td><td class="keep">${esc(LABEL[e.action] || e.action)}${e.target ? `: ${esc(e.target)}` : ''}${e.detail ? ` <span class="muted">(${esc(e.detail)})</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Nothing yet.</td></tr>'}
    </tbody></table>`;
}

// ---- start ----

async function boot() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  state.me = await api('/api/me');
  state.today = state.me.today || state.today;
  $('#who').textContent = [state.name, state.org].filter(Boolean).join(' · ');
  document.querySelectorAll('[data-manage]').forEach((el) => { el.hidden = !state.canManage; });
  $('#health').textContent = state.canManage ? 'You can add and change client profiles.' : 'You can read, write case notes and post.';
  window.addEventListener('hashchange', route);
  route();
}

async function start() {
  const ticket = takeTicket();
  if (ticket) {
    try { saveSession(await api('/api/auth/cockpit', { method: 'POST', body: { ticket } })); } catch (err) { return showLogin(err.message); }
  }
  if (state.token) boot().catch(fail); else showLogin();
}

start();
