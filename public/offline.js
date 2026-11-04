// Case notes written on a phone with no signal. A note saved while the
// browser is offline, or whose post never reached the server, waits in
// IndexedDB (database tss-vault-offline, store notes) with an id the phone
// made, and is sent when the signal is back: at start, on the browser's
// online event and on Send now. The server takes the phone's id, so a
// resend after a lost answer is the same note, never a second one
// (server.js POST /api/clients/:id/notes). A note the server refuses (a date in
// the future, a client removed meanwhile) stays with the reason
// until it is discarded; what was typed is shown so nothing is lost. A note
// not sent in 7 days is dropped. Entries another person wrote on the same
// browser leave before anything is sent. Nothing else is kept on the device.

export const QUEUE_DAYS = 7;

// ---- the rules, pure, for the tests ----

// A post that never reached the server has no HTTP status.
export const isNetworkError = (err) => !!err && err.status == null;
export function newEntry({ userId, client, note, now = Date.now(), id = crypto.randomUUID() }) {
  return { id, userId, clientId: client.id, clientName: client.name || '', note: { date: note.date, kind: note.kind, body: note.body }, createdAt: new Date(now).toISOString(), status: 'waiting', reason: '' };
}
export const waitingOf = (list) => list.filter((e) => e.status === 'waiting').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
export const expired = (e, now = Date.now(), days = QUEUE_DAYS) => !(Date.parse(e.createdAt) >= now - days * 86400e3);
// What the server is sent for one entry: the note, with the phone's id.
export const toSend = (e) => ({ id: e.id, date: e.note.date, kind: e.note.kind, body: e.note.body });
// The entry after the server's answer: written (or already written) leaves; a refusal stays with its reason.
export function settle(e, outcome) {
  if (outcome.ok) return null;
  return { ...e, status: 'refused', reason: String(outcome.reason || 'refused') };
}

// ---- the device ----

export function makeOffline({ esc, post, userId }) {
  let dbp = null;
  let running = false;
  const open = () => (dbp ||= new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') { rej(new Error('This browser keeps no notes offline')); return; }
    const r = indexedDB.open('tss-vault-offline', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('notes', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const trx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const x = db.transaction('notes', mode); const q = fn(x.objectStore('notes')); x.oncomplete = () => res(q?.result); x.onerror = () => rej(x.error); }); };
  const all = () => trx('readonly', (s) => s.getAll());
  const put = (e) => trx('readwrite', (s) => s.put(e));
  const remove = (id) => trx('readwrite', (s) => s.delete(id));
  const mine = async () => (await all()).filter((e) => e.userId === userId()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  async function badge() {
    let n = 0; try { n = (await mine()).length; } catch { n = 0; }
    for (const el of document.querySelectorAll('[data-pending]')) { el.textContent = n ? String(n) : ''; el.hidden = !n; }
    return n;
  }
  // The note form's save: posted as before, or kept on the phone with no signal. Answers { queued } so the form can say so.
  async function saveNote(client, note) {
    const entry = newEntry({ userId: userId(), client, note });
    if (navigator.onLine !== false) {
      try { await post(`/api/clients/${client.id}/notes`, toSend(entry)); return { queued: false }; }
      catch (err) { if (!isNetworkError(err)) throw err; }
    }
    await put(entry); await badge();
    return { queued: true };
  }
  async function sync() {
    if (running || navigator.onLine === false || !userId()) return null;
    running = true;
    const counts = { sent: 0, refused: 0 };
    try {
      const now = Date.now();
      for (const e of await all()) if (e.userId !== userId() || expired(e, now)) await remove(e.id);
      for (const e of waitingOf(await mine())) {
        let outcome;
        try { await post(`/api/clients/${e.clientId}/notes`, toSend(e)); outcome = { ok: true }; }
        catch (err) { if (isNetworkError(err)) break; outcome = { ok: false, reason: err.message }; }
        const next = settle(e, outcome);
        if (next) { await put(next); counts.refused += 1; } else { await remove(e.id); counts.sent += 1; }
      }
    } finally { running = false; await badge(); }
    return counts;
  }
  // The list at the top of Case Notes, the home page and a client's page, while anything waits.
  async function panel({ clientId = null } = {}) {
    let list = []; try { list = await mine(); } catch { return ''; }
    if (clientId) list = list.filter((e) => e.clientId === clientId);
    if (!list.length) return '';
    const off = navigator.onLine === false;
    return `<div class="card pending" id="pending"><div class="head"><div><h3>Waiting to send (${list.length})</h3>
      <p class="muted">${off ? 'No signal. These notes are kept on this phone and go out when the signal is back.' : 'Kept on this phone until the server takes them.'}</p></div>
      <div class="row"><button type="button" id="pending-send" ${off ? 'disabled' : ''}>Send now</button></div></div>
      <ul class="timeline">${list.map((e) => `<li class="${e.status === 'refused' ? 'refused' : ''}"><span class="when">${esc(e.note.date)}<br><span class="badge ${e.status === 'refused' ? 'warn' : ''}">${e.status === 'refused' ? 'Refused' : 'Waiting'}</span></span>
        <span class="what"><strong>${esc(e.clientName)}</strong>: ${esc(e.note.body.length > 200 ? `${e.note.body.slice(0, 200)}…` : e.note.body)}${e.reason ? `<br><span class="error">${esc(e.reason)}</span>` : ''}
        <br><button type="button" class="small" data-discard="${esc(e.id)}">Discard</button></span></li>`).join('')}</ul></div>`;
  }
  function wire(again) {
    const send = document.getElementById('pending-send');
    if (send) send.onclick = async () => { send.disabled = true; try { await sync(); } finally { again(); } };
    document.querySelectorAll('[data-discard]').forEach((b) => { b.onclick = async () => { if (confirm('Discard this note? It was never sent and cannot be recovered.')) { await remove(b.dataset.discard); await badge(); again(); } }; });
  }
  return { saveNote, sync, badge, panel, wire, mine };
}
