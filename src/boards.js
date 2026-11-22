/* Boards, folders and their items. A board is identified by its owner and its path ("Folder/Sub/Name").
   Changes are applied item by item; each one gets the board's next number (rev), so a device can ask for "everything since 1234".
   Two devices changing the same item: a device that says what it started from gets a merge by field (clashes are answered, not applied).
   History (the changes table) keeps, for an edit, only the fields that changed (model.diffBodies). */
'use strict';
const { COLLS, stable, checkItem, mergeBodies, diffBodies, onto, sideFields } = require('./model');
const okName = n => typeof n === 'string' && /^[\w][\w .,'()&+-]{0,59}$/.test(n) && !/\.\.|[. ]$/.test(n);
const segs = p => { const s = String(p == null ? '' : p).split('/').filter(Boolean); return s.length <= 8 && s.every(okName) ? s : null; };

function boards(db) {
  const find = (owner, p) => db.q('SELECT * FROM boards WHERE owner = ? AND path = ? AND deleted IS NULL').get(owner, p);
  const event = (user, owner, p, action, what, detail) => db.q('INSERT INTO board_events (at, user, owner, path, action, what, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run(Date.now(), user, owner, p, action, what, detail ? JSON.stringify(detail) : null);
  const folderExists = (owner, p) => !p || !!db.q('SELECT 1 FROM folders WHERE owner = ? AND path = ?').get(owner, p) || !!db.q("SELECT 1 FROM boards WHERE owner = ? AND deleted IS NULL AND path LIKE ? ESCAPE '\\' LIMIT 1").get(owner, like(p) + '/%');
  const like = p => p.replace(/[\\%_]/g, c => '\\' + c);

  /* apply a list of { coll, id, body|null, base? } to a board; returns the new rev, how many really changed, and what it couldn't take as sent.
     base (when given): the item as the device last had it from the server, so the server can merge by field (model.mergeBodies).
     lenient: a change that isn't right, or clashes, is answered (rejected / clashes) and the rest still go in; otherwise it stops everything. */
  function apply(board, user, via, list, lenient) {
    let rev = board.rev, n = 0; const now = Date.now(), merged = [], clashes = [], rejected = [];
    const refuse = (c, why) => { if (!lenient) throw Object.assign(new Error(why), { code: 400 }); rejected.push({ coll: c.coll, id: String(c.id), why }); };
    // the items this batch touches, as they are now, in one query (not one per change)
    const ids = [...new Set(list.map(c => String(c && c.id)))], known = new Map();
    for (let i = 0; i < ids.length; i += 500) for (const r of db.q('SELECT coll, id, body FROM items WHERE board = ? AND id IN (SELECT value FROM json_each(?))').all(board.id, JSON.stringify(ids.slice(i, i + 500)))) known.set(r.coll + '\u0001' + r.id, r.body);
    for (const c of list) {
      if (!COLLS.includes(c.coll) || typeof c.id !== 'string' || !c.id || c.id.length > 200) { refuse(c, 'Bad change: ' + JSON.stringify(c).slice(0, 120)); continue; }
      if (c.body != null && (typeof c.body !== 'object' || Array.isArray(c.body))) { refuse(c, 'Bad item body for ' + c.id); continue; }
      const wrong = checkItem(c.coll, c.body); if (wrong) { refuse(c, wrong + ' (' + c.coll + ' ' + c.id + ')'); continue; }
      const key = c.coll + '\u0001' + c.id, curBody = known.get(key), cur = curBody === undefined ? null : { body: curBody };
      if ('base' in c) {   // merge by field against what the device started from
        const m = mergeBodies(c.base == null ? null : c.base, c.body == null ? null : c.body, cur ? JSON.parse(cur.body) : null);
        if (m.clash) { clashes.push({ coll: c.coll, id: c.id, body: cur ? JSON.parse(cur.body) : null, fields: m.clash }); continue; }
        if (stable(m.body) !== stable(c.body == null ? null : c.body)) { merged.push({ coll: c.coll, id: c.id, body: m.body }); c.body = m.body; }
      }
      const after = c.body == null ? null : JSON.stringify(c.body);
      if (after == null) known.delete(key); else known.set(key, after);
      if ((cur ? cur.body : null) === after || (cur && after && stable(JSON.parse(cur.body)) === stable(c.body))) continue;   // no real change
      if (!cur && after == null) continue;
      rev++; n++;
      if (after == null) db.q('DELETE FROM items WHERE board = ? AND coll = ? AND id = ?').run(board.id, c.coll, c.id);
      else db.q('INSERT INTO items (board, coll, id, body, rev, updated, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (board, coll, id) DO UPDATE SET body = excluded.body, rev = excluded.rev, updated = excluded.updated, updated_by = excluded.updated_by')
        .run(board.id, c.coll, c.id, after, rev, now, user);
      // History: an edit keeps only what changed; a new or deleted item keeps its whole body
      const d = cur && after != null ? diffBodies(JSON.parse(cur.body), c.body) : null;
      db.q('INSERT INTO changes (board, rev, at, user, via, coll, id, before, after, diff) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(board.id, rev, now, user, via || null, c.coll, c.id,
        d ? JSON.stringify(d.before) : cur ? cur.body : null, d ? JSON.stringify(d.after) : after, d ? 1 : 0);
    }
    if (n) db.q('UPDATE boards SET rev = ?, updated = ? WHERE id = ?').run(rev, now, board.id);
    return { rev, changed: n, ...(merged.length ? { merged } : {}), ...(clashes.length ? { clashes } : {}), ...(rejected.length ? { rejected } : {}) };
  }

  return {
    COLLS, segs, okName, find,
    list(owner, folder) {
      const pre = folder ? folder + '/' : '', folders = new Map(), out = [];
      for (const f of db.q("SELECT path FROM folders WHERE owner = ? AND path LIKE ? ESCAPE '\\'").all(owner, like(pre) + '%')) { const rest = f.path.slice(pre.length).split('/')[0]; if (rest) folders.set(rest, true); }
      for (const b of db.q("SELECT b.path, b.rev, b.updated, (SELECT COUNT(*) FROM items i WHERE i.board = b.id AND i.coll = 'nodes') AS items FROM boards b WHERE owner = ? AND deleted IS NULL AND path LIKE ? ESCAPE '\\'").all(owner, like(pre) + '%')) {
        const rest = b.path.slice(pre.length).split('/');
        if (rest.length > 1) folders.set(rest[0], true); else out.push({ name: rest[0], rev: b.rev, version: b.rev, updatedAt: b.updated, items: b.items });
      }
      const by = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      return { folders: [...folders.keys()].map(name => ({ name })).sort(by), boards: out.sort(by) };
    },
    folderExists,
    makeFolder(user, owner, p) { db.q('INSERT OR IGNORE INTO folders (owner, path, created) VALUES (?, ?, ?)').run(owner, p, Date.now()); },
    count(owner) { return db.q('SELECT COUNT(*) AS n FROM boards WHERE owner = ? AND deleted IS NULL').get(owner).n; },
    // a new board, optionally with items in it from the start. replace: save over the board of that name; the old one is kept
    // (marked deleted) and the new one carries on its history, so the board can still be seen as it was before
    create(user, owner, p, items, via, replace) {
      return db.tx(() => {
        const old = find(owner, p);
        if (old && !replace) return null;
        const now = Date.now(), parent = p.split('/').slice(0, -1).join('/');
        if (old) { db.q('UPDATE boards SET deleted = ? WHERE id = ?').run(now, old.id); event(user, owner, p, 'delete', 'board', { replaced: true }); }
        if (parent) db.q('INSERT OR IGNORE INTO folders (owner, path, created) VALUES (?, ?, ?)').run(owner, parent, now);
        const id = db.q('INSERT INTO boards (owner, path, rev, created, updated, prev) VALUES (?, ?, 0, ?, ?, ?)').run(owner, p, now, now, old ? old.id : null).lastInsertRowid;
        event(user, owner, p, 'create', 'board', { items: items ? Object.keys(items.nodes || {}).length : 0, ...(old ? { replaced: true } : {}) });
        let rev = 0;
        if (items) { const list = []; for (const c of COLLS) for (const [k, b] of Object.entries(items[c] || {})) list.push({ coll: c, id: k, body: b }); rev = apply(find(owner, p), user, via, list).rev; }
        return { id: Number(id), rev };
      });
    },
    snapshot(board) {
      const out = {}; for (const c of COLLS) out[c] = {};
      for (const r of db.q('SELECT coll, id, body FROM items WHERE board = ?').all(board.id)) out[r.coll][r.id] = JSON.parse(r.body);
      return out;
    },
    /* the board's history as moments to step through: [at, board id, rev], oldest first, one per second that had a change.
       It runs back through the boards this one replaced (Save As onto the same name), each up to when the next one took over. */
    timeline(board) {
      const chain = [board]; let cur = board;
      for (let g = 0; cur.prev && g < 50; g++) { cur = db.q('SELECT * FROM boards WHERE id = ?').get(cur.prev); if (!cur) break; chain.push(cur); }
      const out = [];
      chain.forEach((b, i) => {
        const until = i ? chain[i - 1].created : 9e15;
        for (const r of db.q('SELECT MAX(at) AS at, MAX(rev) AS rev FROM changes WHERE board = ? AND at < ? GROUP BY at / 1000').all(b.id, until)) out.push([r.at, b.id, r.rev]);
      });
      return { boards: chain.map(b => ({ id: b.id, path: b.path, created: b.created, deleted: b.deleted || null })), moments: out.sort((a, b) => a[0] - b[0] || a[2] - b[2]) };
    },
    // a board as it was just after change number rev: today's items, with every later change taken back
    at(boardId, rev) {
      const b = db.q('SELECT * FROM boards WHERE id = ?').get(boardId); if (!b) return null;
      const out = this.snapshot(b);
      for (const c of db.q('SELECT coll, id, before, diff FROM changes WHERE board = ? AND rev > ? ORDER BY rev DESC').all(b.id, rev)) {
        if (!out[c.coll]) continue;
        if (c.before == null) delete out[c.coll][c.id];
        else out[c.coll][c.id] = c.diff ? onto(out[c.coll][c.id], JSON.parse(c.before)) : JSON.parse(c.before);
      }
      const last = db.q('SELECT at FROM changes WHERE board = ? AND rev <= ? ORDER BY rev DESC LIMIT 1').get(b.id, rev);
      return { board: b.id, path: b.path, rev: Math.min(rev, b.rev), at: last ? last.at : b.created, collections: out };
    },
    // what changed since rev: each item once (its latest change), as it is now
    changesSince(board, since, limit = 5000) {
      const last = new Map();
      for (const r of db.q('SELECT rev, at, user, coll, id FROM changes WHERE board = ? AND rev > ? ORDER BY rev LIMIT ?').all(board.id, since, limit)) { const k = r.coll + '\u0001' + r.id; last.delete(k); last.set(k, r); }
      return [...last.values()].map(r => { const cur = db.q('SELECT body FROM items WHERE board = ? AND coll = ? AND id = ?').get(board.id, r.coll, r.id);
        return { rev: r.rev, at: r.at, user: r.user, coll: r.coll, id: r.id, body: cur ? JSON.parse(cur.body) : null }; });
    },
    // the owner's clean-up: a person's boards lose their history (changes and board events) from before a time. As it was then starts there.
    pruneHistory(owner, before) {
      return db.tx(() => ({
        changes: Number(db.q('DELETE FROM changes WHERE at < ? AND board IN (SELECT id FROM boards WHERE owner = ?)').run(before, owner).changes),
        events: Number(db.q('DELETE FROM board_events WHERE at < ? AND owner = ?').run(before, owner).changes) }));
    },
    apply(board, user, via, list, lenient) { return db.tx(() => apply(db.q('SELECT * FROM boards WHERE id = ?').get(board.id), user, via, list, lenient)); },
    // rename a board, or a folder and everything in it
    rename(user, owner, p, to) {
      const dest = [...p.split('/').slice(0, -1), to].join('/');
      return db.tx(() => {
        if (find(owner, dest) || folderExists(owner, dest)) return { error: 'There’s already something called “' + to + '” there.', code: 409 };
        const b = find(owner, p);
        if (b) { db.q('UPDATE boards SET path = ?, updated = ? WHERE id = ?').run(dest, Date.now(), b.id); event(user, owner, p, 'rename', 'board', { to: dest }); return { path: dest }; }
        if (!folderExists(owner, p)) return { error: 'It isn’t there any more.', code: 404 };
        for (const x of db.q("SELECT id, path FROM boards WHERE owner = ? AND deleted IS NULL AND path LIKE ? ESCAPE '\\'").all(owner, like(p) + '/%')) db.q('UPDATE boards SET path = ? WHERE id = ?').run(dest + x.path.slice(p.length), x.id);
        for (const f of db.q("SELECT path FROM folders WHERE owner = ? AND (path = ? OR path LIKE ? ESCAPE '\\')").all(owner, p, like(p) + '/%')) db.q('UPDATE folders SET path = ? WHERE owner = ? AND path = ?').run(dest + f.path.slice(p.length), owner, f.path);
        event(user, owner, p, 'rename', 'folder', { to: dest }); return { path: dest };
      });
    },
    // delete a board, or a folder and everything in it: the boards are only marked deleted, so they can be brought back
    remove(user, owner, p) {
      return db.tx(() => {
        const now = Date.now(), b = find(owner, p);
        if (b) { db.q('UPDATE boards SET deleted = ? WHERE id = ?').run(now, b.id); event(user, owner, p, 'delete', 'board'); return { ok: true }; }
        if (!folderExists(owner, p)) return { error: 'It isn’t there any more.', code: 404 };
        db.q("UPDATE boards SET deleted = ? WHERE owner = ? AND deleted IS NULL AND path LIKE ? ESCAPE '\\'").run(now, owner, like(p) + '/%');
        db.q("DELETE FROM folders WHERE owner = ? AND (path = ? OR path LIKE ? ESCAPE '\\')").run(owner, p, like(p) + '/%');
        event(user, owner, p, 'delete', 'folder'); return { ok: true };
      });
    }
  };
}

/* ---------------------------------------------------------------- History: each stored change, described the way the app shows it.
   Everything a person does is shown: moving things on the board, resizing them, every field. Only the app's own timestamps are left out. */
const SKIP = new Set(['modified', 'created', 'schedAt']);
const POS = new Set(['x', 'y']), SIZE = new Set(['w', 'h', 'r']);
const nodeWhat = n => !n ? 'tile' : n.kind === 'chip' ? 'chip' : n.kind === 'concept' ? 'concept' : 'tile';
const CHIP_WORDS = { check: 'check', note: 'note', link: 'link', text: 'text' };
const nameOf = n => n.kind === 'chip' ? (n.label || n.url || CHIP_WORDS[n.chip] || 'chip') : (n.label || '');
const show = v => { const x = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v); return x.length > 2000 ? x.slice(0, 2000) + '…' : x; };
const where = n => Math.round(+n.x || 0) + ', ' + Math.round(+n.y || 0);
// a tile's or chip's size is its width and height; a concept's is how wide it is across. "auto" is the size it takes by itself
const sizeText = n => n.kind === 'concept' ? (+n.r > 0 ? Math.round(n.r * 2) + ' across' : 'auto') : (+n.w > 0 ? Math.round(n.w) : 'auto') + ' × ' + (+n.h > 0 ? Math.round(n.h) : 'auto');
function describe(ch, labelOf) {
  const o = ch.before ? sideFields(JSON.parse(ch.before)) : null, n = ch.after ? sideFields(JSON.parse(ch.after)) : null;   // a diff's sides hold just the fields that changed (and the ones that name it)
  if (ch.coll === 'nodes') {
    if (!o && n.kind === 'chip') { const values = { kind: ['', CHIP_WORDS[n.chip] || 'note'] };
      if (n.url) values.url = ['', show(n.url)];
      if (n.done) values.done = ['', 'done'];
      if (n.date) values.date = ['', show(n.date)];
      if (!n.dock) values.where = ['', 'on the board'];
      return { action: 'add', what: 'chip', id: ch.id, label: nameOf(n), parent: n.parent ? labelOf(n.parent) : '', fields: Object.keys(values), values }; }
    if (!o) { const values = { position: ['', where(n)] };
      if (+n.w > 0 || +n.h > 0 || +n.r > 0) values.size = ['', sizeText(n)];
      for (const k of ['status', 'date', 'time', 'endDate', 'endTime', 'repeat']) if (n[k] && !(k === 'status' && n[k] === 'todo')) values[k] = ['', show(n[k])];
      if ((n.tags || []).length) values.tags = ['', n.tags.join(', ')];
      if (n.notes) values.notes = ['', show(n.notes)];
      return { action: 'add', what: nodeWhat(n), id: ch.id, label: n.label || '', parent: n.parent ? labelOf(n.parent) : '', fields: Object.keys(values), values }; }
    if (!n) return { action: 'remove', what: nodeWhat(o), id: ch.id, label: nameOf(o), parent: o.parent ? labelOf(o.parent) : '', ...(o.kind === 'chip' ? {} : { fields: ['position'], values: { position: [where(o), ''] } }) };
    const raw = [...new Set([...Object.keys(o), ...Object.keys(n)])].filter(k => !SKIP.has(k) && JSON.stringify(o[k]) !== JSON.stringify(n[k]));
    if (!raw.length) return null;
    // x and y read as one position; w, h and r as one size
    const fields = [...new Set(raw.map(k => POS.has(k) || k === 'order' ? 'position' : SIZE.has(k) ? 'size' : k === 'dock' ? 'where' : k === 'chip' ? 'kind' : k))];
    const action = fields.every(k => k === 'position' || k === 'where') ? 'move' : fields.includes('size') && fields.every(k => k === 'size' || k === 'position') ? 'resize' : 'change';
    const e = { action, what: nodeWhat(n), id: ch.id, label: nameOf(n), fields, values: {} };
    for (const k of fields) {
      if (k === 'position' && n.kind === 'chip' && n.dock && o.dock) e.values.position = ['place ' + (+o.order || 0), 'place ' + (+n.order || 0)];
      else if (k === 'position') e.values.position = [where(o), where(n)];
      else if (k === 'where') e.values.where = [o.dock ? 'in its tile' : 'on the board', n.dock ? 'in its tile' : 'on the board'];
      else if (k === 'kind' && n.kind === 'chip' && o.kind === 'chip') e.values.kind = [CHIP_WORDS[o.chip] || 'note', CHIP_WORDS[n.chip] || 'note'];
      else if (k === 'kind') e.values.kind = [nodeWhat(o), nodeWhat(n)];
      else if (k === 'done') e.values.done = [o.done ? 'done' : 'not done', n.done ? 'done' : 'not done'];
      else if (k === 'size') e.values.size = [sizeText(o), sizeText(n)];
else if (k === 'parent') e.values.parent = [o.parent ? labelOf(o.parent) : '(on its own)', n.parent ? labelOf(n.parent) : '(on its own)'];
      else if (k === 'tags') e.values.tags = [(o.tags || []).join(', '), (n.tags || []).join(', ')];
      else e.values[k] = [show(o[k]), show(n[k])];
    }
    if (fields.includes('label')) e.from = o.label || '';
    if (fields.includes('status')) e.status = n.status;
    if (fields.includes('parent')) e.to = e.values.parent[1];
    return e;
  }
  if (ch.coll === 'links' || ch.coll === 'deps') {
    const x = n || o, ends = ch.coll === 'links' ? [x.a, x.b] : [x.task, x.needs];
    const e = { action: n && !o ? 'add' : !n ? 'remove' : 'change', what: ch.coll === 'links' ? 'cross-link' : 'dependency', id: ch.id, label: labelOf(ends[0]) + (ch.coll === 'links' ? ' ↔ ' : ' needs ') + labelOf(ends[1]) };
    if (o && n) { const fields = [...new Set([...Object.keys(o), ...Object.keys(n)])].filter(k => !SKIP.has(k) && JSON.stringify(o[k]) !== JSON.stringify(n[k])); e.fields = fields; e.values = {}; for (const k of fields) e.values[k] = [show(o[k]), show(n[k])]; }
    else if (x.note) { e.fields = ['note']; e.values = { note: n ? ['', show(n.note)] : [show(o.note), ''] }; }
    return e;
  }
  if (ch.coll === 'ranks') return { action: 'change', what: 'ranking', id: ch.id, label: labelOf((n || o).a) + ' vs ' + labelOf((n || o).b) };
  if (ch.coll === 'tagmeta') {   // a tag's colour; colours that come and go with the tag itself aren't worth a line
    if (!o || !n) return null;
    const col = t => (typeof t.hue === 'number' ? 'hue ' + t.hue : 'auto') + (t.shade ? ', shade ' + t.shade : '');
    if (col(o) === col(n)) return null;
    return { action: 'change', what: 'tag', id: ch.id, label: n.name || ch.id, fields: ['colour'], values: { colour: [col(o), col(n)] } };
  }
  return null;
}

module.exports = { boards, describe, COLLS, segs, okName };
