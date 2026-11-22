/* Claude from a phone, run by that same person's own desktop Life Web on the Claude account signed in there (never anyone else's).
     GET  /api/relay/status                              -> { desktop }   is this person's desktop waiting for requests?
     POST /api/relay/ask { board, text, session, model }  -> { id }        the phone asks (board = { user, path } of a cloud board)
     GET  /api/relay/next                                -> a request, or 204 after ~25 s   (the desktop waits here)
     POST /api/relay/<id>/events { events: [...] }       -> { stop }      the desktop reports text, tool steps, then { done, text, error, session, trace }
     GET  /api/relay/<id>?from=<n>                       -> { events, done }   the phone reads them (waits up to ~25 s for new ones)
     POST /api/relay/<id>/stop                           -> { ok }
   Requests live in memory for an hour at most. */
'use strict';
const crypto = require('crypto');
const jobs = new Map(), waiters = new Set(), seen = new Map();
const wake = () => { for (const w of [...waiters]) w(); };

function relayRoutes({ req, res, parts, qs, me, send, body, segs, okUser }) {
  const now = Date.now(), last = seen.get(me.name) || 0;
  for (const [id, j] of jobs) if (now - j.created > 3600e3) jobs.delete(id);
  if (parts[2] === 'status' && req.method === 'GET') return send(200, { desktop: now - last < 40000 });
  if (parts[2] === 'ask' && req.method === 'POST') return body(m => {
    if (now - last > 40000) return send(503, { error: 'Your desktop isn’t connected. Open Life Web on your desktop (signed in to Life Web Cloud) and try again.' });
    const b = m.board || {}, text = String(m.text || '').trim(), s = segs(b.path);
    if (!text || !s || !s.length) return send(400, { error: 'Open a cloud board first, then ask.' });
    const id = crypto.randomBytes(9).toString('base64url');
    jobs.set(id, { id, owner: me.name, board: { user: b.user && okUser(b.user) ? b.user : '', path: s.join('/') }, text: text.slice(0, 20000), session: String(m.session || '').slice(0, 100), model: String(m.model || '').slice(0, 40), events: [], done: false, taken: false, stop: false, created: now });
    wake(); send(200, { id });
  });
  if (parts[2] === 'next' && req.method === 'GET') {
    seen.set(me.name, now);
    const give = () => { if (res.destroyed || res.writableEnded) return false;            // a desktop that went away never gets a request
      const j = [...jobs.values()].find(x => x.owner === me.name && !x.taken && !x.done);   // only this person's own requests
      if (!j) return false; j.taken = true; j.touched = Date.now(); send(200, { id: j.id, board: j.board, text: j.text, session: j.session, model: j.model }); return true; };
    if (give()) return;
    const t = setTimeout(() => { waiters.delete(w); seen.set(me.name, Date.now()); if (!res.headersSent) { res.writeHead(204); res.end(); } }, 25000);
    const w = () => { if (give()) { clearTimeout(t); waiters.delete(w); } };
    waiters.add(w); req.on('close', () => { clearTimeout(t); waiters.delete(w); });
    return;
  }
  const j = jobs.get(parts[2]); if (!j || j.owner !== me.name) return send(404, { error: 'That request is gone.' });
  if (parts[3] === 'events' && req.method === 'POST') return body(m => {
    seen.set(me.name, now); j.touched = now;
    for (const e of Array.isArray(m.events) ? m.events : []) { j.events.push(e); if (e && e.done) j.done = true; }
    for (const fn of j.listeners || []) fn(); j.listeners = [];
    send(200, { stop: j.stop });
  });
  if (parts[3] === 'stop' && req.method === 'POST') { j.stop = true; if (!j.taken) { j.events.push({ done: true, stopped: true }); j.done = true; } return send(200, { ok: true }); }
  if (parts.length === 3 && req.method === 'GET') {
    const from = Math.max(0, +qs('from') || 0);
    // a desktop that took the request and then went quiet for 3 minutes (closed, asleep, offline) has dropped it
    const reply = () => { if (j.taken && !j.done && Date.now() - j.touched > 180000) { j.events.push({ done: true, error: 'Your desktop stopped answering in the middle of this request. Any changes it made are on the board.' }); j.done = true; }
      send(200, { events: j.events.slice(from), done: j.done, waiting: !j.taken }); };
    if (j.events.length > from || j.done) return reply();
    const t = setTimeout(() => { j.listeners = (j.listeners || []).filter(x => x !== fn); reply(); }, 25000);
    const fn = () => { clearTimeout(t); reply(); };
    (j.listeners = j.listeners || []).push(fn); req.on('close', () => clearTimeout(t));
    return;
  }
  send(404, { error: 'Not found' });
}
module.exports = { relayRoutes };
