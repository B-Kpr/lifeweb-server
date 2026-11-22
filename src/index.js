/* Life Web Cloud: keeps Life Web boards on a server so any device can open them, item by item in a SQLite database.
   Runs on Node 24 or newer with no other packages. Settings come from the environment (see server/.env.example):
     LIFEWEB_TOKEN     the owner's access code (24+ characters). The owner is the admin.
     LIFEWEB_ADMIN     the owner's name (default "Owner")
     LIFEWEB_DATA      where the database and its daily backups go (default /data)
     LIFEWEB_LMSTUDIO  optional: the owner's LM Studio, shared with everyone's Assistant through this server
     PORT              default 3095
   Every request but /api/health, /api/join and /join/<code> needs "Authorization: Bearer <access code>".

   Files and boards
     GET  /api/me                                       -> { name, admin }
     GET  /api/files?path=<folder>[&user=]              -> { user, path, folders: [{name}], boards: [{name, rev, updatedAt, items}] }
     POST /api/folder { path, user? }                   -> { ok }
     POST /api/rename { path, to, user? }               -> { ok, path }   a board or folder, in the same folder
     POST /api/delete { path, user? }                   -> { ok }         marked deleted (kept in the database)
     POST /api/board { path, user?, items?, via?, replace? }  -> { rev }   a new board (409 if the name is taken, unless replace: then it
                                                       saves over it and carries on its history)
     GET  /api/board/timeline?path=&user=               -> { boards, moments: [[at, board, rev]] }   every second that had a change
     GET  /api/board/at?path=&user=&b=&rev= | &time=ms  -> { rev, at, collections }   the board as it was then
     GET  /api/board?path=&user=                        -> { rev, updatedAt, collections }
     GET  /api/board/changes?path=&user=&since=N[&wait=25]  -> { rev, changes: [{ rev, at, user, coll, id, body|null }] }
     POST /api/board/changes { path, user?, via?, changes: [{ coll, id, body|null, base? }] }  -> { rev, changed, merged?, clashes?, rejected? }
   People (owner only, except join)
     GET  /api/users  ->  { users, invites }      POST /api/invites { name } -> { link, ... }      DELETE /api/users/<name>
     POST /api/users/<name>/ai { on }             POST /api/join { code } -> { name, token, server }
   The owner's logs:  GET /api/history[?user=&board=&before=&limit=]    POST /api/history/prune {user, before}    POST /api/chats {...}    GET /api/chats[?user=&before=&limit=]
   Claude:  POST /mcp (access code) or /mcp/<key> -> the board tools (MCP);  GET/POST/DELETE /api/connector-link -> your private link
   Assistant:  GET /api/ai, /api/ai/models, POST /api/ai/chat (the owner's LM Studio);  /api/relay/... (Claude through your own desktop) */
'use strict';
const http = require('http'), crypto = require('crypto');
const { open, backup } = require('./db');
const { boards: boardsOf, describe, segs, okName } = require('./boards');
const { relayRoutes } = require('./relay');
const { aiRoutes } = require('./ai');
const { mcpServer } = require('./mcp');

const PORT = +process.env.PORT || 3095, DATA = process.env.LIFEWEB_DATA || '/data', TOKEN = process.env.LIFEWEB_TOKEN || '';
const PUBLIC_URL = String(process.env.LIFEWEB_PUBLIC_URL || '').trim().replace(/\/+$/, '');
const ADMIN = String(process.env.LIFEWEB_ADMIN || 'Owner').trim(), LMSTUDIO = String(process.env.LIFEWEB_LMSTUDIO || '').trim().replace(/\/+$/, '');
const INVITE_DAYS = 7, VERSION = require('../package.json').version;
/* The board format this server keeps (see docs/COMPATIBILITY.md). 2: concepts, tiles and chips (Life Web 1.5). An app says which format
   it writes in the X-LifeWeb-Format header; writes from an app with an older format are refused (426), so it can't mix old-shaped
   items into a newer board. Reads are allowed, and every board read says its format, so a newer app can refuse an older server. */
const FORMAT = 2;
const tooOld = req => (+req.headers['x-lifeweb-format'] || 1) < FORMAT;
const OLD_APP = 'This board is kept in a newer format (' + FORMAT + '). Update Life Web on this device to change it.';
const okUser = n => typeof n === 'string' && /^[\w][\w .'-]{0,39}$/.test(n) && !/\.\.|[. ]$/.test(n);
if (TOKEN.length < 24) { console.error('LIFEWEB_TOKEN must be set (24+ characters). See server/.env.example.'); process.exit(1); }
if (!okUser(ADMIN)) { console.error('LIFEWEB_ADMIN must be a plain name.'); process.exit(1); }
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const same = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };

const db = open(DATA), B = boardsOf(db);
db.q('INSERT OR IGNORE INTO people (name, admin, created) VALUES (?, 1, ?)').run(ADMIN, Date.now());

/* ---------------------------------------------------------------- who is asking */
function whoIs(req) {
  const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || '')); if (!m) return null;
  if (same(m[1], TOKEN)) return { name: ADMIN, admin: true };
  const p = db.q('SELECT name FROM people WHERE token_hash = ? AND removed IS NULL').get(sha(m[1]));
  return p ? { name: p.name, admin: false } : null;
}
/* Wrong access codes, connector links and invites, counted per visitor: 10 wrong in 10 minutes and that visitor waits 15 minutes.
   Behind Tailscale Funnel the visitor's own address comes in a header (Tailscale-Ingress-Src, or X-Forwarded-For); without one it's the
   connection's. If wrong codes pour in from everywhere at once (more than 300 in 10 minutes), every wrong answer is also slowed down,
   so nobody can lock the owner out by pretending to be many visitors. Real codes are 44 random characters: guessing one isn't possible. */
const misses = new Map(); let missWindow = { at: Date.now(), n: 0 };
const visitor = req => String(req.headers['tailscale-ingress-src'] || '').replace(/:\d+$/, '') || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || String(req.socket.remoteAddress || '');
const lockedOut = req => { const m = misses.get(visitor(req)); return !!m && m.until > Date.now(); };
function missed(req) {
  const now = Date.now(), k = visitor(req); let m = misses.get(k);
  if (!m || now - m.first > 600e3) m = { first: now, n: 0, until: 0 };
  if (++m.n >= 10) m.until = now + 900e3;
  misses.set(k, m);
  if (now - missWindow.at > 600e3) missWindow = { at: now, n: 0 };
  missWindow.n++;
  if (misses.size > 5000) for (const [key, v] of misses) if (v.until < now && now - v.first > 600e3) misses.delete(key);
  return missWindow.n > 300 ? 1000 : 0;   // how long to hold the answer back
}
const aiAllowed = name => { const p = db.q('SELECT ai FROM people WHERE name = ?').get(name); return !p || !!p.ai; };

const page = (title, body) => '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title>' +
  '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#222;background:#fafaf7}@media(prefers-color-scheme:dark){body{color:#eee;background:#1d1d1b}}code{background:rgba(127,127,127,.18);padding:2px 6px;border-radius:5px;word-break:break-all}</style>' + body;
const escH = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// waiting for a board's next change (long polling): woken when that board changes
const watchers = new Map();
const wake = id => { const w = watchers.get(id); if (w) { watchers.delete(id); for (const fn of w) fn(); } };
const MCP = mcpServer({ db, B, wake, history: (who, before, lim) => history(who, before, lim), okUser });

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, obj) => { if (res.headersSent || res.destroyed) return; res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const refuse = (code, obj) => { const wait = missed(req); if (wait) setTimeout(() => send(code, obj), wait); else send(code, obj); };
  if (lockedOut(req)) return send(429, { error: 'Too many wrong access codes from here. Try again in 15 minutes.' });
  const url = new URL(req.url, 'http://x'), parts = url.pathname.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch (e) { return ''; } });
  const qs = k => url.searchParams.get(k);
  const origin = (req.headers['x-forwarded-proto'] || 'http') + '://' + (req.headers['x-forwarded-host'] || req.headers.host || 'localhost:' + PORT);
  const body = fn => { let b = ''; req.setEncoding('utf8'); req.on('data', c => { b += c; if (b.length > 10e6) { send(413, { error: 'Too big (10 MB at most)' }); req.destroy(); } });
    req.on('end', async () => { let m; try { m = b ? JSON.parse(b) : {}; } catch (e) { return send(400, { error: 'Not JSON' }); }
      try { await fn(m || {}); } catch (e) { console.error(e); send(e.code === 400 ? 400 : 500, { error: e.message }); } }); };
  const fail = e => { console.error(e); send(e.code === 400 ? 400 : 500, { error: e.message }); };

  try {
    // an invite link opened in a browser: say what to do with it
    if (parts[0] === 'join' && parts.length === 2 && req.method === 'GET') {
      const inv = db.q('SELECT * FROM invites WHERE code_hash = ?').get(sha(parts[1])), live = inv && inv.expires > Date.now();
      res.writeHead(live ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page('Life Web invite', live
        ? '<h1>You’re invited to Life Web Cloud</h1><p>This invite is for <b>' + escH(inv.name) + '</b>.</p><ol><li>Open Life Web (on a computer: <b>File › Connections…</b>; on a phone: <b>Menu › Connections…</b>).</li><li>Choose <b>Join with an invite link</b>.</li><li>Paste this page’s address:</li></ol><p><code>' + escH(origin + '/join/' + parts[1]) + '</code></p><p>It works once and runs out on ' + new Date(inv.expires).toDateString() + '.</p>'
        : '<h1>This invite has run out</h1><p>It was used already or it’s too old. Ask for a new one.</p>'));
    }
    if (parts[0] === 'connect' && parts.length === 1 && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page('Connect to Life Web Cloud', '<h1>This is your Life Web connection link</h1><p>It signs Life Web in to this server. It holds your access code (after the #), so keep it private.</p><ol><li>Open Life Web (on a computer: <b>File › Connections…</b>; on a phone: <b>Menu › Connections…</b>).</li><li>Paste this whole link into <b>Connection link or invite</b> and press <b>Connect</b>.</li></ol>'));
    }
    /* Claude's connector: /mcp with the access code, or /mcp/<connector key> (claude.ai, Cowork and the phone can't send a header) */
    if (parts[0] === 'mcp' && parts.length <= 2) {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(405, { error: 'POST JSON-RPC messages here' }); }
      let who = null;
      if (parts[1]) { const p = db.q('SELECT name, admin FROM people WHERE mcp_hash = ? AND removed IS NULL').get(sha(parts[1])); if (p) who = { name: p.name, admin: !!p.admin }; }
      else who = whoIs(req);
      if (!who) return refuse(401, { error: 'Wrong or missing access code or connector link' });
      return body(m => MCP.handle(req, res, who, m));
    }
    if (parts[0] !== 'api') return send(404, { error: 'Not found' });
    if (parts[1] === 'health' && req.method === 'GET') return send(200, { ok: true, name: 'Life Web Cloud', version: 3, format: FORMAT, server: VERSION, lmstudio: !!LMSTUDIO });
    if (parts[1] === 'join' && req.method === 'POST') return body(m => {
      const code = String(m.code || '').replace(/^.*\/join\//, '').trim(), h = sha(code), inv = code && db.q('SELECT * FROM invites WHERE code_hash = ?').get(h);
      if (!inv || inv.expires < Date.now()) return refuse(404, { error: 'That invite was used already or has run out. Ask for a new one.' });
      const token = crypto.randomBytes(24).toString('base64url'), now = Date.now();
      db.tx(() => {
        db.q('INSERT INTO people (name, token_hash, admin, created, joined) VALUES (?, ?, 0, ?, ?) ON CONFLICT (name) DO UPDATE SET token_hash = excluded.token_hash, joined = excluded.joined, removed = NULL').run(inv.name, sha(token), now, now);
        db.q('DELETE FROM invites WHERE code_hash = ?').run(h);
      });
      send(200, { name: inv.name, token, server: origin });
    });

    const me = whoIs(req);
    if (!me) return refuse(401, { error: 'Wrong or missing access code' });
    if (parts[1] === 'me' && req.method === 'GET') return send(200, me);
    // your own private connector link for Claude: made (or made again, which stops the old one), checked, or turned off
    if (parts[1] === 'connector-link') {
      if (req.method === 'GET') { const p = db.q('SELECT mcp_hash FROM people WHERE name = ?').get(me.name); return send(200, { on: !!(p && p.mcp_hash), publicUrl: PUBLIC_URL || null }); }
      if (req.method === 'POST') { const key = crypto.randomBytes(24).toString('base64url'); db.q('UPDATE people SET mcp_hash = ? WHERE name = ?').run(sha(key), me.name);
        return send(200, { on: true, path: '/mcp/' + key, link: (PUBLIC_URL || origin) + '/mcp/' + key, publicUrl: PUBLIC_URL || null }); }
      if (req.method === 'DELETE') { db.q('UPDATE people SET mcp_hash = NULL WHERE name = ?').run(me.name); return send(200, { on: false }); }
    }

    // whose files: your own, or (for the owner) anyone's
    const whose = u => (!u || u === me.name) ? me.name : me.admin && okUser(u) ? u : null;

    /* ---------------------------------------------------------------- files and boards */
    if (parts[1] === 'files' && req.method === 'GET') {
      const u = whose(qs('user')); if (!u) return send(403, { error: 'Those aren’t your files' });
      const s = segs(qs('path')); if (!s) return send(400, { error: 'Bad folder name' });
      if (s.length && !B.folderExists(u, s.join('/'))) return send(404, { error: 'No such folder' });
      return send(200, { user: u, path: s.join('/'), ...B.list(u, s.join('/')) });
    }
    if ((parts[1] === 'folder' || parts[1] === 'rename' || parts[1] === 'delete') && req.method === 'POST') return body(m => {
      const u = whose(m.user), s = segs(m.path);
      if (!u) return send(403, { error: 'Those aren’t your files' });
      if (!s || !s.length) return send(400, { error: 'Names use letters, numbers, spaces, dots and dashes (60 at most).' });
      if (parts[1] === 'folder') { B.makeFolder(me.name, u, s.join('/')); return send(200, { ok: true }); }
      if (parts[1] === 'rename') { const to = String(m.to || '').trim(); if (!okName(to)) return send(400, { error: 'Names use letters, numbers, spaces, dots and dashes (60 at most).' });
        const r = B.rename(me.name, u, s.join('/'), to); return r.error ? send(r.code, { error: r.error }) : send(200, { ok: true, path: r.path }); }
      const r = B.remove(me.name, u, s.join('/')); return r.error ? send(r.code, { error: r.error }) : send(200, { ok: true });
    });
    if (parts[1] === 'board') {
      if (req.method !== 'GET' && tooOld(req)) return send(426, { error: OLD_APP, format: FORMAT });
      if (parts.length === 2 && req.method === 'POST') return body(m => {
        const u = whose(m.user), s = segs(m.path);
        if (!u) return send(403, { error: 'Those aren’t your files' });
        if (!s || !s.length) return send(400, { error: 'Board names use letters, numbers, spaces, dots and dashes (60 at most).' });
        const r = B.create(me.name, u, s.join('/'), m.items && typeof m.items === 'object' ? m.items : null, m.via, m.replace === true);
        return r ? send(200, { rev: r.rev }) : send(409, { error: 'There’s already a board called “' + s[s.length - 1] + '” there.' });
      });
      const getBoard = (u, p) => { u = whose(u); const s = segs(p); if (!u) return [403, 'Those aren’t your files']; if (!s || !s.length) return [400, 'Bad board name']; const b = B.find(u, s.join('/')); return b ? [0, b] : [404, 'No such board']; };
      // the board's history to step through, and the board as it was at one of those moments (or at a time)
      if ((parts[2] === 'timeline' || parts[2] === 'at') && req.method === 'GET') {
        const [code, b] = getBoard(qs('user'), qs('path')); if (code) return send(code, { error: b });
        const t = B.timeline(b);
        if (parts[2] === 'timeline') return send(200, t);
        let bid = +qs('b') || b.id, rev = qs('rev') == null ? NaN : +qs('rev');
        if (qs('time') != null) {
          const when = +qs('time'); if (!Number.isFinite(when)) return send(400, { error: 'time is milliseconds since 1970' });
          const m = t.moments.filter(x => x[0] <= when).pop();
          if (!m) return send(200, { board: b.id, path: b.path, rev: 0, at: when, before: true, first: t.moments.length ? t.moments[0][0] : null, collections: { nodes: {}, links: {}, deps: {}, ranks: {}, tagmeta: {} } });
          bid = m[1]; rev = m[2];
        }
        if (!t.boards.some(x => x.id === bid) || !Number.isFinite(rev)) return send(400, { error: 'Give rev (and b) from the timeline, or time' });
        return send(200, B.at(bid, rev));
      }
      if (parts.length === 2 && req.method === 'GET') { const [code, b] = getBoard(qs('user'), qs('path')); if (code) return send(code, { error: b }); return send(200, { rev: b.rev, updatedAt: b.updated, format: FORMAT, collections: B.snapshot(b) }); }
      if (parts[2] === 'changes' && req.method === 'GET') {
        const [code, b] = getBoard(qs('user'), qs('path')); if (code) return send(code, { error: b });
        const since = Math.max(0, +qs('since') || 0), wait = Math.min(30, Math.max(0, +qs('wait') || 0));
        const reply = () => { const cur = B.find(b.owner, b.path) || b, ch = B.changesSince(cur, since); send(200, { rev: cur.rev, changes: ch, more: ch.length >= 5000 }); };
        if (b.rev > since || !wait) return reply();
        const t = setTimeout(done, wait * 1000);
        function done() { clearTimeout(t); const w = watchers.get(b.id); if (w) w.delete(done); reply(); }
        if (!watchers.has(b.id)) watchers.set(b.id, new Set()); watchers.get(b.id).add(done);
        req.on('close', () => { clearTimeout(t); const w = watchers.get(b.id); if (w) w.delete(done); });
        return;
      }
      if (parts[2] === 'changes' && req.method === 'POST') return body(m => {
        const [code, b] = getBoard(m.user, m.path); if (code) return send(code, { error: b });
        if (!Array.isArray(m.changes)) return send(400, { error: 'No changes' });
        const r = B.apply(b, me.name, m.via ? String(m.via).slice(0, 60) : '', m.changes.slice(0, 20000), true);   // what can't go in is answered, the rest goes in
        if (r.changed) wake(b.id);
        send(200, r);
      });
    }

    /* ---------------------------------------------------------------- people (the owner) */
    if (parts[1] === 'users' && me.admin) {
      if (parts.length === 2 && req.method === 'GET') {
        const users = db.q('SELECT * FROM people ORDER BY admin DESC, name').all().map(p => ({ name: p.name, admin: !!p.admin, created: p.created, access: !!p.admin || (!!p.token_hash && !p.removed), ai: !!p.admin || !!p.ai, boards: B.count(p.name) }));
        const invites = db.q('SELECT name, created, expires FROM invites WHERE expires > ? ORDER BY created DESC').all(Date.now());
        return send(200, { users, invites });
      }
      if (parts.length === 4 && parts[3] === 'ai' && req.method === 'POST') return body(m => {
        const r = db.q('UPDATE people SET ai = ? WHERE name = ? AND admin = 0').run(m.on === false ? 0 : 1, parts[2]); send(r.changes ? 200 : 404, r.changes ? { ok: true } : { error: 'No such person' });
      });
      if (parts.length === 3 && req.method === 'DELETE') {
        if (parts[2] === ADMIN) return send(400, { error: 'The owner’s access comes from the server’s .env file.' });
        const r = db.q('UPDATE people SET token_hash = NULL, removed = ? WHERE name = ? AND admin = 0').run(Date.now(), parts[2]);
        db.q('DELETE FROM invites WHERE name = ?').run(parts[2]);
        return send(r.changes ? 200 : 404, r.changes ? { ok: true } : { error: 'No such person' });
      }
    }
    if (parts[1] === 'invites' && req.method === 'POST' && me.admin) return body(m => {
      const name = String(m.name || '').trim().replace(/\s+/g, ' ');
      if (!okUser(name)) return send(400, { error: 'Use a plain name: letters, numbers, spaces, dots, dashes (40 at most).' });
      if (name === ADMIN) return send(400, { error: 'That’s your own name.' });
      const code = crypto.randomBytes(18).toString('base64url'), expires = Date.now() + INVITE_DAYS * 864e5;
      db.tx(() => { db.q('DELETE FROM invites WHERE name = ?').run(name); db.q('INSERT INTO invites (code_hash, name, created, expires, by) VALUES (?, ?, ?, ?, ?)').run(sha(code), name, Date.now(), expires, me.name); });
      send(200, { name, code, link: origin + '/join/' + code, expires });
    });

    /* ---------------------------------------------------------------- the owner's logs */
    if (parts[1] === 'chats' && req.method === 'POST') return body(m => {
      const t = (v, n) => String(v == null ? '' : v).slice(0, n || 50000);
      let trace = null;
      if (Array.isArray(m.trace) && m.trace.length) { let n = 0; trace = [];
        for (const e of m.trace.slice(0, 2000)) { const x = { t: t(e.t, 20), ...(e.name ? { name: t(e.name, 80) } : {}), text: t(e.text, 200000), ...(e.args != null ? { args: t(e.args, 200000) } : {}), ...(e.finish ? { finish: t(e.finish, 20) } : {}), ...(e.error ? { error: true } : {}), ...(e.earlier ? { earlier: true } : {}), ...(e.auto ? { auto: true } : {}) };
          n += x.text.length + (x.args || '').length; if (n > 4e6) { trace.push({ t: 'note', text: '…the rest was too long to keep' }); break; } trace.push(x); } }
      db.q('INSERT INTO chats (at, user, board, assistant, model, ask, reply, error, trace) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(Date.now(), me.name, t(m.board, 200), t(m.assistant, 80), t(m.model, 80), t(m.ask), t(m.reply), m.error ? t(m.error, 2000) : null, trace ? JSON.stringify(trace) : null);
      send(200, { ok: true });
    });
    // the owner deletes one person's board history from before a date (that person's boards: every change to them, and their board events)
    if (parts[1] === 'history' && parts[2] === 'prune' && req.method === 'POST') return body(m => {
      if (!me.admin) return send(403, { error: 'Only the owner can delete history.' });
      const who = String(m.user || ''), before = +m.before;
      if (!who || !(who === me.name || okUser(who))) return send(400, { error: 'Say whose boards (a person\'s name).' });
      if (!(before > 0) || before > Date.now() + 864e5) return send(400, { error: 'Give a date in the past.' });
      const r = B.pruneHistory(who, before);
      try { db.exec('VACUUM'); } catch (e) {}
      send(200, { ok: true, ...r });
    });
    if ((parts[1] === 'history' || parts[1] === 'chats') && req.method === 'GET') {
      if (!me.admin) return send(403, { error: 'Only the owner can read this.' });
      const lim = Math.min(1000, Math.max(1, +qs('limit') || 300)), before = +qs('before') || 9e15, who = qs('user') || '';
      if (parts[1] === 'chats') return send(200, { entries: db.q('SELECT * FROM chats WHERE at < ? AND (? = \'\' OR user = ?) ORDER BY at DESC, id DESC LIMIT ?').all(before, who, who, lim)
        .map(r => ({ at: r.at, user: r.user, board: r.board, assistant: r.assistant, model: r.model, ask: r.ask, reply: r.reply, ...(r.error ? { error: r.error } : {}), ...(r.trace ? { trace: JSON.parse(r.trace) } : {}) })) });
      return send(200, { entries: history(who, before, lim) });
    }

    /* ---------------------------------------------------------------- the Assistant */
    if (parts[1] === 'relay') return relayRoutes({ req, res, parts, qs, me, send, body, segs, okUser });
    if (parts[1] === 'ai') return aiRoutes({ req, res, parts, me, send, body, LMSTUDIO, allowed: me.admin || aiAllowed(me.name) });

    send(404, { error: 'Not found' });
  } catch (e) { fail(e); }
});

/* History: the stored changes and board events, newest first, described the way the app shows them */
function history(who, before, lim) {
  const out = [], labels = new Map();
  const labelOf = (boardId, id) => {
    const k = boardId + '\u0000' + id; if (labels.has(k)) return labels.get(k);
    const cur = db.q("SELECT body FROM items WHERE board = ? AND coll = 'nodes' AND id = ?").get(boardId, id);
    let l = cur ? JSON.parse(cur.body).label : null;
    if (l == null) { const old = db.q("SELECT before, after FROM changes WHERE board = ? AND coll = 'nodes' AND id = ? ORDER BY rev DESC LIMIT 1").get(boardId, id); const x = old && (old.after || old.before); l = x ? JSON.parse(x).label : id; if (l == null) l = id; }
    labels.set(k, l); return l;
  };
  let cursor = before;
  while (out.length < lim) {
    const rows = db.q('SELECT c.*, b.owner, b.path FROM changes c JOIN boards b ON b.id = c.board WHERE c.at < ? AND (? = \'\' OR c.user = ?) ORDER BY c.at DESC, c.rev DESC LIMIT ?').all(cursor, who, who, lim * 2);
    const evs = db.q('SELECT * FROM board_events WHERE at < ? AND (? = \'\' OR user = ?) ORDER BY at DESC, id DESC LIMIT ?').all(cursor, who, who, lim);
    if (!rows.length && !evs.length) break;
    const merged = [...rows.map(r => ({ r })), ...evs.map(e => ({ e }))].sort((a, b) => (b.r || b.e).at - (a.r || a.e).at);
    let last = cursor;
    for (const x of merged) {
      if (out.length >= lim && (x.r || x.e).at !== out[out.length - 1].at) break;   // keep the rest of a save that has the same time
      if (x.r) { const d = describe(x.r, id => labelOf(x.r.board, id)); last = x.r.at; if (d) out.push({ at: x.r.at, user: x.r.user, owner: x.r.owner, board: x.r.path, ...(x.r.via ? { via: x.r.via } : {}), ...d }); }
      else { const e = x.e, name = e.path.split('/').pop(), d = e.detail ? JSON.parse(e.detail) : {}; last = e.at;
        out.push({ at: e.at, user: e.user, owner: e.owner, board: e.path, ...(e.action === 'create' ? { action: 'create', what: e.what, label: name + (d.items ? ' (' + d.items + ' items)' : '') }
          : e.action === 'rename' ? { action: 'change', what: e.what, label: name, fields: ['label'], values: { label: [name, String(d.to || '').split('/').pop()] } } : { action: 'remove', what: e.what, label: name }) }); }
    }
    if (last >= cursor) break; cursor = last;
    if (merged.length < lim || out.length >= lim) break;
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => console.log('Life Web Cloud ' + VERSION + ' on port ' + PORT + ', data in ' + DATA + ', owner ' + ADMIN + (LMSTUDIO ? ', LM Studio at ' + LMSTUDIO : '')));
// a copy of the database every day (and one at start-up)
const daily = () => { try { const f = backup(db, DATA); if (f) console.log('Backed up the database to ' + f); } catch (e) { console.error('Backup failed: ' + e.message); } };
daily(); setInterval(daily, 3600e3).unref();
const stop = () => { server.close(); try { db.close(); } catch (e) {} process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
