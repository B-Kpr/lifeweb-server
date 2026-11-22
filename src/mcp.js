/* Claude's connector, run by Life Web Cloud: MCP over HTTP (JSON-RPC in a POST, the answer as JSON).
   Reached at /mcp with "Authorization: Bearer <access code>" (the connector on a computer), or at /mcp/<connector key> (a custom
   connector in Claude on the web, Cowork or the phone, which can't send a header). Each Claude conversation gets a session that
   remembers which board it chose; the tools themselves are in tools.js. */
'use strict';
const crypto = require('crypto');
const X = require('./tools'), M = require('./model'), BT = require('./board-tools');
const { VIA, treeTargets } = X, { N, stable } = M, { ToolError, outline } = BT;
// the board tools the server shares with the app's Assistant (board-tools.js); the rest below are the connector's own
const SHARED = ['list_items', 'get_items', 'get_board_json', 'search_items', 'create_item', 'create_branch', 'update_items', 'delete_items', 'create_links', 'create_dependencies', 'update_connections', 'delete_connections', 'set_tag_colors'];
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const sessions = new Map();   // id -> { user, board: {owner, path}, seen }
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function mcpServer({ db, B, wake, history, okUser }) {
  const parseWhen = t => { const v = String(t || '').trim(); if (!v) throw new ToolError('Give a time.');
    const m = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d))?)?$/.exec(v);
    const ms = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 23, m[5] ? +m[5] : 59, m[6] ? +m[6] : (m[4] ? 0 : 59)) : Date.parse(v);
    if (!Number.isFinite(ms)) throw new ToolError('Couldn\'t read that time. Use an ISO time like 2026-11-17T15:30:00-05:00.'); return ms; };
  const okPath = p => { const s = B.segs(String(p == null ? '' : p).trim().replace(/^\/+|\/+$/g, '')); if (!s || !s.length) throw new ToolError('Give a path like "Folder/Name" (letters, numbers, spaces, dots and dashes).'); return s.join('/'); };

  function handlers(me, S) {
    const whose = u => { if (!u || u === me.name) return me.name; if (me.admin && okUser(u)) return u; throw new ToolError('Those aren\'t your files.'); };
    // the board a call works on: the one given, or the session's chosen one
    function boardOf(a) {
      const ref = a.board ? { owner: whose(a.user), path: okPath(a.board) } : S.board;
      if (!ref) throw new ToolError('No board is chosen yet. Call list_boards, then open_board (or new_board).');
      const b = B.find(ref.owner, ref.path); if (!b) throw new ToolError('There is no board at "' + ref.path + '" any more. Call list_boards.');
      return b;
    }
    const load = a => { const b = boardOf(a), snap = B.snapshot(b); return { b, snap, V: M.viewOf(snap) }; };
    // one call's changes, saved as one batch: what deleting takes with it, the time stamps, tag colours nobody uses any more
    function write(b, snap, changes) {
      if (!changes.length) return 0;
      const V = M.viewOf(snap), list = M.tagCleanup(M.cascade(changes, V), V).map(c => M.stampTimes(c, c.coll === 'nodes' ? snap.nodes[c.id] || null : null));
      const r = B.apply(b, me.name, VIA, list.map(c => ({ coll: c.coll, id: c.id, body: c.body == null ? null : c.body })));
      if (r.changed) wake(b.id);
      return r.changed;
    }
    // the shared tools, on the board this call works on
    const shared = name => async a => { const { b, snap } = load(a); return (await BT.makeTools({ view: () => M.viewOf(snap), write: changes => write(b, snap, changes) })[name](a)).result; };
    const where = b => (b.owner !== me.name ? b.owner + ': ' : '') + b.path;

    return {
      list_boards(a) {
        const u = whose(a.user), f = a.folder ? okPath(a.folder) : '';
        if (f && !B.folderExists(u, f)) throw new ToolError('No folder "' + f + '".');
        const l = B.list(u, f);
        return { folder: f, folders: l.folders.map(x => x.name), boards: l.boards.map(x => ({ name: x.name, path: (f ? f + '/' : '') + x.name, items: x.items, updated: iso(x.updatedAt) })), chosen: S.board ? S.board.path : null };
      },
      open_board(a) { const u = whose(a.user), p = okPath(a.path), b = B.find(u, p); if (!b) throw new ToolError('No board at "' + p + '". Call list_boards.');
        S.board = { owner: u, path: p }; return { chosen: where(b), items: Object.keys(B.snapshot(b).nodes).length }; },
      new_board(a) { const u = whose(a.user), p = okPath(a.path), r = B.create(me.name, u, p, null, VIA);
        if (!r) throw new ToolError('There\'s already a board called "' + p.split('/').pop() + '" there. Pick another name, or open that one.');
        S.board = { owner: u, path: p }; return { created: p, chosen: true }; },
      make_folder(a) { const u = whose(a.user), p = okPath(a.path); B.makeFolder(me.name, u, p); return { folder: p }; },
      rename_board(a) { const u = whose(a.user), p = okPath(a.path), to = String(a.to || '').trim(); if (!B.okName(to)) throw new ToolError('to is the new name only: letters, numbers, spaces, dots and dashes.');
        const r = B.rename(me.name, u, p, to); if (r.error) throw new ToolError(r.error);
        if (S.board && S.board.owner === u && (S.board.path === p || S.board.path.startsWith(p + '/'))) S.board = { owner: u, path: r.path + S.board.path.slice(p.length) };
        return { path: r.path }; },
      delete_board(a) { const u = whose(a.user), p = okPath(a.path), r = B.remove(me.name, u, p); if (r.error) throw new ToolError(r.error);
        if (S.board && S.board.owner === u && (S.board.path === p || S.board.path.startsWith(p + '/'))) S.board = null;
        return { deleted: p }; },
      save_board_as(a) { const b = boardOf(a), u = whose(a.user), p = okPath(a.path), r = B.create(me.name, u, p, B.snapshot(b), VIA, a.replace === true);
        if (!r) throw new ToolError('There is already a board at "' + p + '". Give replace: true to save over it, or another name.');
        S.board = { owner: u, path: p }; return { copied: where(b), to: p, chosen: true }; },
      ...Object.fromEntries(SHARED.map(n => [n, shared(n)])),
      tidy_layout(a) { const { b, snap, V } = load(a);
        const tops = Array.isArray(a.ids) && a.ids.length ? a.ids.map(id => { const n = V.nodes.get(String(id)); if (!n) throw new ToolError('No item has the id "' + id + '". Use ids from list_items.'); return n; }) : null, target = treeTargets(V, tops);
        const ch = [...target].filter(([id, p]) => { const n = V.nodes.get(id); return n && (Math.abs(n.x - p.x) > 1 || Math.abs(n.y - p.y) > 1); }).map(([id, p]) => N(V.nodes.get(id), { x: p.x, y: p.y }));
        write(b, snap, ch); return { moved: ch.length }; },
      get_guide() { return X.GUIDE.instructions(); },
      // Claude's last call on this board, taken back item by item; anything changed again since stays as it is
      undo(a) {
        const b = boardOf(a), cur = B.snapshot(b);
        const ats = db.q('SELECT DISTINCT at FROM changes WHERE board = ? AND user = ? AND via = ? ORDER BY at DESC LIMIT 40').all(b.id, me.name, VIA).map(r => r.at);
        for (const at of ats) {
          const rows = db.q('SELECT coll, id, before, after, diff FROM changes WHERE board = ? AND user = ? AND via = ? AND at = ? ORDER BY rev').all(b.id, me.name, VIA, at), per = new Map();
          for (const r of rows) { const k = r.coll + '\u0001' + r.id; if (!per.has(k)) per.set(k, { coll: r.coll, id: r.id, rows: [] }); per.get(k).rows.push(r); }
          const back = [], kept = [];
          // an item goes back only if it's still as Claude left it; its rows are taken back newest first
          const asLeft = (now, r) => r.after == null ? now === undefined : now !== undefined && (r.diff ? Object.entries(M.sideFields(JSON.parse(r.after))).every(([k, v]) => stable(now[k]) === stable(v)) && (JSON.parse(r.after).$gone || []).every(k => !(k in now)) : stable(now) === stable(JSON.parse(r.after)));
          for (const x of per.values()) {
            const now = cur[x.coll] && cur[x.coll][x.id], last = x.rows[x.rows.length - 1];
            if (!asLeft(now, last)) { kept.push(x.id); continue; }
            let body = now;
            for (const r of [...x.rows].reverse()) body = r.before == null ? null : r.diff ? M.onto(body, JSON.parse(r.before)) : JSON.parse(r.before);
            back.push({ coll: x.coll, id: x.id, body });
          }
          if (!back.length) continue;
          const r = B.apply(b, me.name, VIA + ' (undo)', back); if (r.changed) wake(b.id);
          return { undone: back.length, from: iso(at), ...(kept.length ? { leftAsIs: kept, why: 'changed again since' } : {}) };
        }
        return 'Nothing of Claude\'s left to undo on this board.';
      },
      board_at(a) {
        const b = boardOf(a), ms = parseWhen(a.time), t = B.timeline(b), m = t.moments.filter(x => x[0] <= ms).pop();
        if (!m) return 'The board had no history yet at that time' + (t.moments.length ? '; it starts at ' + iso(t.moments[0][0]) : '') + '.';
        const got = B.at(m[1], m[2]);
        return { asOf: iso(got.at), ...(a.json ? { collections: got.collections } : { outline: outline(M.viewOf(got.collections)) }) };
      },
      read_history(a) {
        if (!me.admin) throw new ToolError('Only the owner can read History.');
        const b = a.all_boards ? null : boardOf(a), lim = Math.max(1, Math.min(500, Math.round(+a.limit || 100))), out = [];
        let cur = a.before ? parseWhen(a.before) : 9e15;
        for (let page = 0; page < 10 && out.length < lim; page++) {
          const got = history(a.person || '', cur, 500); if (!got.length) break;
          for (const e of got) if (!b || (e.board === b.path && e.owner === b.owner)) out.push({ when: iso(e.at), ...e, at: undefined });
          cur = got[got.length - 1].at; if (got.length < 500) break;
        }
        return { entries: out.slice(0, lim), more: out.length > lim };
      },
      read_chats(a) {
        if (!me.admin) throw new ToolError('Only the owner can read Chats.');
        const lim = Math.max(1, Math.min(200, Math.round(+a.limit || 30))), before = a.before ? parseWhen(a.before) : 9e15, who = a.person || '';
        return db.q('SELECT * FROM chats WHERE at < ? AND (? = \'\' OR user = ?) ORDER BY at DESC, id DESC LIMIT ?').all(before, who, who, lim)
          .map(r => ({ when: iso(r.at), user: r.user, board: r.board, assistant: r.assistant, model: r.model, ask: r.ask, reply: r.reply, ...(r.error ? { error: r.error } : {}), ...(a.with_runs && r.trace ? { run: JSON.parse(r.trace) } : {}) }));
      }
    };
  }

  /* one JSON-RPC message -> its answer (null for notifications) */
  async function answer(me, sid, m) {
    const { id, method, params } = m || {};
    if (id === undefined || id === null) return null;
    const S = sessions.get(sid) || { user: me.name, board: null };
    if (method === 'initialize') { const want = params && params.protocolVersion;
      return { jsonrpc: '2.0', id, result: { protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'life-web', title: 'Life Web', version: '2.0.0' }, instructions: X.INTRO } }; }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: X.TOOLS } };
    if (method === 'tools/call') {
      const fname = params && params.name, h = handlers(me, S);
      if (!Object.prototype.hasOwnProperty.call(h, fname)) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'There is no tool called ' + fname + '.' }], isError: true } };
      try {
        const r = await h[fname]((params && params.arguments) || {});
        S.seen = Date.now(); sessions.set(sid, S);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }], isError: false } };
      } catch (e) {
        if (!(e instanceof ToolError)) console.error('mcp ' + fname, e);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: (e && e.message) || String(e) }) }], isError: true } };
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
  }

  // forget sessions nobody has used for a day
  setInterval(() => { const old = Date.now() - 864e5; for (const [k, s] of sessions) if ((s.seen || 0) < old) sessions.delete(k); }, 3600e3).unref();

  return {
    // req: the HTTP request already authenticated as me; body: the parsed JSON (one message or a batch)
    async handle(req, res, me, body) {
      let sid = String(req.headers['mcp-session-id'] || '');
      const msgs = Array.isArray(body) ? body : [body];
      if (msgs.some(m => m && m.method === 'initialize') || !sid || !sessions.has(sid)) {
        if (!sid || !sessions.has(sid)) { sid = crypto.randomBytes(16).toString('hex'); sessions.set(sid, { user: me.name, board: null, seen: Date.now() }); }
      }
      const s = sessions.get(sid); if (s.user !== me.name) { sid = crypto.randomBytes(16).toString('hex'); sessions.set(sid, { user: me.name, board: null, seen: Date.now() }); }
      const out = (await Promise.all(msgs.map(m => answer(me, sid, m)))).filter(Boolean);
      res.setHeader('Mcp-Session-Id', sid);
      if (!out.length) { res.writeHead(202); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(body) ? out : out[0]));
    }
  };
}

module.exports = { mcpServer };
