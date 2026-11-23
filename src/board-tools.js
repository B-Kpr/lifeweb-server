/* The board tools, written once: what list_items, get_items, create_branch, update_items and the rest do with a board.
   Life Web Cloud (Claude's connector, mcp.js) and the app's own Assistant (web/assistant/ai.js) both use them, each through a small
   context that says how to read the board, save changes and place new things. The tools' names, descriptions and rules are in
   guide.js. Each tool answers { result, step }: result goes back to the model, step is the one-line note the app shows. */
'use strict';
const M = require('./model');
const { CHIP_KINDS, STATUSES, HUES, tagId, tagsOf, chipKind, isConceptKind, chipBody, nodeBody, N, C, notesChip } = M;

class ToolError extends Error {}
const NO_CONCEPT_CHIPS = 'A concept can\'t hold chips. Make a tile for this instead, and put them on the tile.';
const checkDate = (v, f) => { if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ToolError(f + ' must look like YYYY-MM-DD.'); return v || ''; };
const checkTime = (v, f) => { if (v && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v)) throw new ToolError(f + ' must look like HH:MM in 24 hour time.'); return v || ''; };
const checkEnum = (v, list, f) => { if (!list.includes(v)) throw new ToolError(f + ' must be one of: ' + list.join(', ') + '.'); return v; };
const addDays = (k, d) => { const x = new Date(k + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
// a new start date keeps a stretch's length; no date clears the whole schedule
function startPatch(s, date, tile) {
  if (!date) return { date: '', time: '', endDate: '', endTime: '', ...(tile ? { repeat: '' } : {}) };
  if (!s.date || !s.endDate) return { date };
  return { date, endDate: addDays(s.endDate, dayDiff(s.date, date)) };
}
const clampEnd = (start, end) => !end ? '' : (start && end < start ? start : end);
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

/* the outline the model reads: one line per concept and tile, with its id, under what it sits */
function outline(V, under) {
  const out = [];
  const line = (n, depth) => {
    const bits = ['[' + n.id + ']', isConceptKind(n.kind) ? 'concept' : 'tile', JSON.stringify(n.label)];
    if (!isConceptKind(n.kind)) bits.push(n.status || 'todo');
    if (tagsOf(n).length) bits.push('tags=' + tagsOf(n).join(','));
    if (n.date) bits.push('date=' + n.date + (n.repeat ? ' ' + n.repeat : ''));
    const docked = V.isTile(n) ? V.dockedOf(n.id) : [], checks = docked.filter(c => chipKind(c) === 'check'), other = docked.filter(c => chipKind(c) !== 'check');
    if (checks.length) bits.push('checks=' + checks.filter(c => c.done).length + '/' + checks.length);
    if (other.length) bits.push('chips=' + other.map(chipKind).join(','));
    if (n.notes) bits.push('notes: ' + JSON.stringify(n.notes.slice(0, 80) + (n.notes.length > 80 ? '…' : '')));
    bits.push('at=' + Math.round(n.x) + ',' + Math.round(n.y));
    out.push('  '.repeat(depth) + '- ' + bits.join(' '));
    for (const k of V.kidsOf(n.id).sort((a, b) => a.y - b.y || a.x - b.x)) if (depth < 40) line(k, depth + 1);
  };
  if (under) { const n = V.nodes.get(under); if (!n) throw new ToolError('No item has the id "' + under + '". Use ids from list_items.'); line(n, 0); }
  else for (const r of [...V.nodes.values()].filter(V.isRoot).sort((a, b) => a.x - b.x)) line(r, 0);
  return out.join('\n') || '(the board is empty)';
}

/* ctx:
     view()            a fresh model view of the board (model.makeView / viewOf)
     write(changes)    save these changes (may be async); the side saving adds the cascade, the time stamps and the tag clean-up
     place(V, parent)  where a new item under parent goes (default: model.autoPlace);  rootSpot(V)  where a new base item goes
     extraInfo(n)      more facts for get_items (the app adds the size it's drawn at)
     hooks             optional: createItem(V, parent) -> info, before a single item is made (may throw); createdItem(id, info);
                       branchStart(), branchDone(); reparented(); linked(); depended()
     uid(prefix)       new ids (default: model.uid) */
function makeTools(ctx) {
  const uid = ctx.uid || M.uid, hooks = ctx.hooks || {}, place = ctx.place || M.autoPlace, rootSpot = ctx.rootSpot || M.rootSpot;
  const need = (V, id) => { const n = V.nodes.get(String(id)); if (!n) throw new ToolError('No item has the id "' + id + '". Use ids from list_items.'); return n; };
  const needAny = (V, id) => { const n = V.get(String(id)); if (!n) throw new ToolError('No item or chip has the id "' + id + '". Use ids from list_items or get_items.'); return n; };
  const name = n => '"' + (n.kind === 'chip' ? n.label || n.url || 'chip' : n.label) + '"';
  const chipInfo = c => ({ id: c.id, kind: chipKind(c), text: c.label, ...(c.url ? { url: c.url } : {}), ...(chipKind(c) === 'check' ? { done: !!c.done, date: c.date || '' } : {}), ...(tagsOf(c).length ? { tags: tagsOf(c) } : {}), inTile: !!c.dock });
  const connectionsOf = (V, id) => ({ ranks: [...V.ranks.values()].filter(r => r.a === id || r.b === id).map(r => ({ a: r.a, b: r.b, winner: r.winner || '', winner2: r.winner2 || '' })),
    crossLinks: [...V.links.values()].filter(l => l.a === id || l.b === id).map(l => ({ id: l.id, with: l.a === id ? l.b : l.a, label: l.label })),
    dependencies: [...V.deps.values()].filter(d => d.task === id || d.needs === id).map(d => ({ id: d.id, task: d.task, needs: d.needs, why: d.why })) });
  const waitsOn = (V, a, b, seen = new Set()) => { if (seen.has(b)) return false; seen.add(b); if (a === b) return true; return [...V.deps.values()].some(d => d.task === b && waitsOn(V, a, d.needs, seen)); };   // would b already (indirectly) wait on a?
  const baseHue = V => HUES[[...V.nodes.values()].filter(V.isRoot).length % HUES.length];

  // the model's fields as a patch for nodeBody, plus colours for any tags that are new (tried out on V, so the next new tag gets another colour)
  function patchFrom(V, a, cur) {
    const patch = {}, extra = [];
    if ('label' in a) { const l = String(a.label).trim(); if (!l) throw new ToolError('label can\'t be empty.'); patch.label = l; }
    if ('kind' in a) patch.kind = checkEnum(a.kind, ['tile', 'concept'], 'kind');
    if ('status' in a) patch.status = checkEnum(a.status, STATUSES, 'status');
    if ('notes' in a) patch.notes = String(a.notes);
    if ('link' in a) patch.link = String(a.link).trim();
    for (const k of ['w', 'h', 'r']) if (k in a) { const v = Number(a[k]); if (!Number.isFinite(v) || v < 0) throw new ToolError(k + ' must be a number of pixels, or 0 for the standard size.'); patch[k] = v || undefined; }
    if ('date' in a) Object.assign(patch, startPatch(cur, checkDate(a.date, 'date'), true));
    const start = 'date' in patch ? patch.date : cur.date;
    if ('time' in a) patch.time = checkTime(a.time, 'time');
    if ('endTime' in a) patch.endTime = checkTime(a.endTime, 'endTime');
    if ('endDate' in a) patch.endDate = clampEnd(start, checkDate(a.endDate, 'endDate'));
    if ('repeat' in a) patch.repeat = checkEnum(a.repeat, ['', 'weekly', 'monthly'], 'repeat');
    if ('tags' in a) {
      if (!Array.isArray(a.tags)) throw new ToolError('tags must be a list.');
      patch.tags = [];
      for (const raw of a.tags) {
        const v = String(raw).trim().replace(/\s+/g, ' ').slice(0, 40); if (!v) continue;
        const known = [...V.tagNames(), ...[...V.tagMeta.values()].map(m => m.name)].find(x => x.toLowerCase() === v.toLowerCase()), t = known || v;
        if (!patch.tags.includes(t)) patch.tags.push(t);
        if (!known) { const c = { coll: 'tagmeta', id: tagId(t), body: { name: t, hue: V.freeHue() } }; extra.push(c); V.apply([c]); }
      }
    }
    return { patch, extra };
  }
  // chips from a tool's arguments (parentId: the tile they go in)
  function chipsFrom(V, list, parentId, startOrder) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw new ToolError('chips must be a list.');
    let order = startOrder || 0;
    return list.map(ch => {
      const k = ch && ch.kind; if (!CHIP_KINDS[k]) throw new ToolError('A chip\'s kind is check, note, link or text.');
      const text = String(ch.text == null ? '' : ch.text).trim(), url = String(ch.url || '').trim();
      if (k === 'link' && !url) throw new ToolError('A link chip needs a url.');
      if (k !== 'link' && !text) throw new ToolError('A ' + k + ' chip needs text.');
      const tg = Array.isArray(ch.tags) ? patchFrom(V, { tags: ch.tags }, {}) : null;
      return [...(tg ? tg.extra : []), { coll: 'nodes', id: uid('c'), body: chipBody({ chip: k, label: text, url, done: !!ch.done, date: k === 'check' ? checkDate(ch.date || '', 'date') : '', tags: tg ? tg.patch.tags : [], parent: parentId, dock: true, order: ++order }) }];
    }).flat();
  }
  // a new tile's chips: its checklist (plain step texts) as check chips, then the chips as given
  const stepChips = (V, a, id, start) => chipsFrom(V, [...(Array.isArray(a.checklist) ? a.checklist.map(t => String(t).trim()).filter(Boolean).map(t => ({ kind: 'check', text: t })) : []), ...(Array.isArray(a.chips) ? a.chips : [])], id, start || 0);
  // notes or a link given for a tile become (or replace) its text chip at the top and its link chip; the tile keeps neither itself
  function tileTextChips(V, tileId, patch, fresh) {
    const out = [], docked = fresh ? [] : V.dockedOf(tileId), notes = String(patch.notes == null ? '' : patch.notes).trim(), link = String(patch.link || '').trim();
    delete patch.notes; delete patch.link;
    if (notes) { const t = docked.find(d => chipKind(d) === 'text');
      if (t) { if (t.label !== notes) out.push(C(t, { label: notes })); } else out.push({ coll: 'nodes', id: uid('c'), body: chipBody({ chip: 'text', label: notes, parent: tileId, dock: true, order: Math.min(0, ...docked.map(d => +d.order || 0)) - 1 }) }); }
    if (link) { const l = docked.find(d => chipKind(d) === 'link');
      if (l) { if (l.url !== link) out.push(C(l, { url: link })); } else out.push({ coll: 'nodes', id: uid('c'), body: chipBody({ chip: 'link', url: link, parent: tileId, dock: true, order: docked.reduce((m, d) => Math.max(m, +d.order || 0), 0) + 50 }) }); }
    return out;
  }
  // moving an item takes everything under it along
  const branchMoves = (V, n, x, y) => { const dx = Math.round(x - n.x), dy = Math.round(y - n.y); if (!dx && !dy) return []; return [n, ...V.descendants(n.id)].map(k => ({ id: k.id, x: k.x + dx, y: k.y + dy })); };
  const save = async (V, changes) => { if (changes.length) await ctx.write(changes); };

  return {
    async list_items(a) { const V = ctx.view(); return { result: outline(V, a.under), step: a.under ? 'Read ' + name(need(V, a.under)) : 'Read the board' }; },
    async get_items(a) {
      const V = ctx.view(), ids = Array.isArray(a.ids) ? a.ids : []; if (!ids.length) throw new ToolError('Give at least one id.');
      const list = ids.map(id => {
        const c = V.chips.get(id); if (c) { const p = V.nodes.get(c.parent); return { ...chipBody(c), ...chipInfo(c), in: c.parent, ...(p ? { path: V.pathName(p) } : {}), ...connectionsOf(V, id) }; }
        const n = V.nodes.get(id); if (!n) return { id, error: 'no such item' };
        return { id, ...nodeBody(n), chips: V.chipsOf(id).map(chipInfo), ...(ctx.extraInfo ? ctx.extraInfo(n) : {}), path: V.pathName(n), depth: V.ancestors(n).length, under: V.kidsOf(id).map(k => k.id), ...connectionsOf(V, id) };
      });
      return { result: list, step: 'Read ' + plural(ids.length, 'item', 'items') };
    },
    // the board exactly as it's stored: every field of every item, cross-link, dependency, rank pick and tag colour
    async get_board_json(a) {
      const V = ctx.view(), scope = a.under ? new Set([need(V, a.under).id, ...V.descendants(a.under).map(d => d.id)]) : null;
      const inS = id => !scope || scope.has(id) || (V.chips.has(id) && scope.has(V.chips.get(id).parent));
      const out = { nodes: {}, links: {}, deps: {}, ranks: {}, tagmeta: {} };
      for (const n of [...V.nodes.values(), ...V.chips.values()]) if (inS(n.id)) out.nodes[n.id] = nodeBody(n);
      for (const l of V.links.values()) if (inS(l.a) || inS(l.b)) out.links[l.id] = { a: l.a, b: l.b, label: l.label || '' };
      for (const d of V.deps.values()) if (inS(d.task) || inS(d.needs)) out.deps[d.id] = { task: d.task, needs: d.needs, why: d.why || '' };
      for (const r of V.ranks.values()) if (inS(r.a) && inS(r.b)) out.ranks[r.id] = { a: r.a, b: r.b, winner: r.winner || '', winner2: r.winner2 || '' };
      for (const m of V.tagMeta.values()) out.tagmeta[m.id] = { name: m.name, hue: m.hue, ...(m.shade ? { shade: m.shade } : {}) };
      return { result: out, step: a.under ? 'Read the stored data of ' + name(need(V, a.under)) : 'Read the stored data of the board' };
    },
    async search_items(a) {
      const V = ctx.view(), q = String(a.query || '').toLowerCase(); if (!q) throw new ToolError('Give some text to search for.');
      const found = [...V.nodes.values(), ...V.chips.values()].filter(n => [n.label, n.notes, n.url, ...tagsOf(n)].some(s => String(s || '').toLowerCase().includes(q)));
      return { result: found.slice(0, 60).map(n => n.kind === 'chip' ? { ...chipInfo(n), in: n.parent } : { id: n.id, kind: n.kind, label: n.label, path: V.pathName(n), status: n.status }), step: 'Searched for "' + a.query + '": ' + found.length + ' found' };
    },
    async create_item(a) {
      const V = ctx.view(), kind = isConceptKind(a.kind) ? 'concept' : 'tile', pid = String(a.parent == null ? '' : a.parent), parent = pid ? need(V, pid) : null;
      if (kind === 'concept' && ((Array.isArray(a.checklist) && a.checklist.length) || (Array.isArray(a.chips) && a.chips.length))) throw new ToolError(NO_CONCEPT_CHIPS);
      const info = hooks.createItem ? await hooks.createItem(V, parent) : null;
      const { patch, extra } = patchFrom(V, { ...a, kind }, { kind, date: '', parent: pid }); if (!patch.label) throw new ToolError('label is required.');
      const spot = parent ? place(V, parent) : rootSpot(V), id = uid(kind === 'concept' ? 'b' : 't');
      const inside = kind === 'tile' ? [...tileTextChips(V, id, patch, true), ...stepChips(V, a, id)] : [];
      await save(V, [...extra, { coll: 'nodes', id, body: nodeBody({ status: 'todo', ...(parent ? {} : { hue: baseHue(V) }), ...patch, kind, parent: pid, x: spot.x, y: spot.y }) }, ...inside]);
      if (hooks.createdItem) hooks.createdItem(id, info);
      return { result: { created: id }, step: 'Added ' + kind + ' "' + patch.label + '"' };
    },
    // a whole tree in one call, so a big plan doesn't take one round per tile; all of it or none of it
    async create_branch(a) {
      const V = ctx.view(), pid = String(a.parent == null ? '' : a.parent), parent = pid ? need(V, pid) : null;
      const roots = Array.isArray(a.items) ? a.items : []; if (!roots.length) throw new ToolError('Give at least one item.');
      const kindOf = it => isConceptKind(it.kind) ? 'concept' : 'tile', kidsIn = it => Array.isArray(it.children) ? it.children : [];
      if (hooks.branchStart) hooks.branchStart();
      // small models tend to send flat lists, so a flat list is refused with a reason they can act on
      if (roots.length > 3) throw new ToolError('That is ' + roots.length + ' separate top items. Make one tile for the whole thing, group the rest into 3 to 7 tiles by topic or stage under it, and send it again. Nothing was added.');
      let count = 0;
      const check = (it, depth) => {
        if (!it || typeof it !== 'object') throw new ToolError('Every item must be an object with a label.');
        const under = kidsIn(it);
        if (under.length > (depth === 0 ? 7 : 10)) throw new ToolError('"' + it.label + '" has ' + under.length + ' items directly under it. Group them into 3 to 7 tiles by topic or stage, and send it again. Nothing was added.');
        if (depth === 0 && under.length > 4 && !under.some(k => kidsIn(k).length)) throw new ToolError('"' + it.label + '" is a flat list of ' + under.length + ' items. Group them into tiles by topic or stage, with the items under those, and send it again. Nothing was added.');
        if (++count > 300) throw new ToolError('That is more than 300 items. Send it in smaller branches.');
        if (depth > 8) throw new ToolError('That goes more than 8 levels deep. Flatten it.');
        if (kindOf(it) === 'concept' && ((Array.isArray(it.checklist) && it.checklist.length) || (Array.isArray(it.chips) && it.chips.length))) throw new ToolError(NO_CONCEPT_CHIPS);
        if ('children' in it && !Array.isArray(it.children)) throw new ToolError('children must be a list.');
        if (!String(it.label || '').trim()) throw new ToolError('Every item needs a label.');
        for (const k of under) check(k, depth + 1);
      };
      for (const r of roots) check(r, 0);
      const W = 250, H = 300, widthOf = it => Math.max(W, kidsIn(it).reduce((s, k) => s + widthOf(k), 0)), depthOf = it => 1 + kidsIn(it).reduce((m, k) => Math.max(m, depthOf(k)), 0);
      const spot = parent ? place(V, parent) : rootSpot(V), changes = [], made = [];
      // slide right until the tree's footprint is clear of what's already on the board
      const treeW = roots.reduce((s, r) => s + widthOf(r), 0), treeH = Math.max(...roots.map(depthOf)) * H;
      let startX = spot.x - treeW / 2;
      const clash = x => [...V.nodes.values()].some(n => n.x > x - W && n.x < x + treeW + W && n.y > spot.y - H && n.y < spot.y + treeH);
      for (let i = 0; i < 400 && clash(startX); i++) startX += W;
      const put = (it, left, depth, under) => {
        const kind = kindOf(it), w = widthOf(it), id = uid(kind === 'concept' ? 'b' : 't');
        const { patch, extra } = patchFrom(V, { ...it, kind }, { kind, date: '', parent: under }); changes.push(...extra);
        const inside = kind === 'tile' ? [...tileTextChips(V, id, patch, true), ...stepChips(V, it, id)] : [];
        changes.push({ coll: 'nodes', id, body: nodeBody({ status: 'todo', ...(under ? {} : { hue: baseHue(V) }), ...patch, kind, parent: under, x: Math.round(left + w / 2), y: Math.round(spot.y + depth * H) }) }, ...inside);
        made.push({ id, label: patch.label });
        let cx = left; for (const k of kidsIn(it)) { put(k, cx, depth + 1, id); cx += widthOf(k); }
      };
      let cx = startX; for (const r of roots) { put(r, cx, 0, pid); cx += widthOf(r); }
      await save(V, changes);
      if (hooks.branchDone) hooks.branchDone();
      return { result: { created: made }, step: 'Added ' + plural(made.length, 'item', 'items') + (parent ? ' under ' + name(parent) : '') };
    },
    async update_items(a) {
      const V = ctx.view(), list = Array.isArray(a.items) ? a.items : []; if (!list.length) throw new ToolError('Give at least one item to change.');
      const changes = [], done = [], problems = [], names = [];
      for (const u of list) {
        try {
          const mine = [], c0 = V.chips.get(String(u.id));
          if (c0) {   // a chip given by its own id: its words, url, tick, date and tags
            const tg = 'tags' in u ? patchFrom(V, { tags: u.tags }, c0) : { patch: {}, extra: [] };
            mine.push(...tg.extra, C(c0, { ...('text' in u || 'label' in u ? { label: String('text' in u ? u.text : u.label).trim() } : {}), ...('url' in u ? { url: String(u.url).trim() } : {}), ...('done' in u ? { done: !!u.done } : {}), ...('date' in u ? { date: checkDate(u.date, 'date') } : {}), ...tg.patch }));
          } else {
            const n = need(V, u.id), { patch, extra } = patchFrom(V, u, n); mine.push(...extra);
            if (isConceptKind(u.kind || n.kind) && Array.isArray(u.chips_add) && u.chips_add.length) throw new ToolError(NO_CONCEPT_CHIPS);
            if (patch.kind === 'tile' && isConceptKind(n.kind) && !('notes' in patch)) mine.push(...notesChip(n, V.dockedOf(n.id)));   // a concept's notes become the tile's text chip
            if (!isConceptKind(patch.kind || n.kind)) mine.push(...tileTextChips(V, n.id, patch, false));
            mine.push(...stepChips(V, { chips: u.chips_add }, n.id, V.chipsOf(n.id).reduce((m, c) => Math.max(m, +c.order || 0), 0) + 10));
            for (const cu of Array.isArray(u.chips_update) ? u.chips_update : []) {
              const c = V.chips.get(cu.id); if (!c || c.parent !== n.id) throw new ToolError('No chip "' + cu.id + '" on this item.');
              if ('kind' in cu && !CHIP_KINDS[cu.kind]) throw new ToolError('A chip\'s kind is check, note, link or text.');
              const tg = 'tags' in cu ? patchFrom(V, { tags: cu.tags }, c) : null; if (tg) mine.push(...tg.extra);
              mine.push(C(c, { ...('kind' in cu ? { chip: cu.kind } : {}), ...('text' in cu ? { label: String(cu.text).trim() } : {}), ...('url' in cu ? { url: String(cu.url).trim() } : {}), ...('done' in cu ? { done: !!cu.done } : {}), ...('date' in cu ? { date: checkDate(cu.date, 'date') } : {}), ...(tg ? tg.patch : {}) }));
            }
            for (const cid of Array.isArray(u.chips_remove) ? u.chips_remove : []) { const c = V.chips.get(cid); if (!c || c.parent !== n.id) throw new ToolError('No chip "' + cid + '" on this item.'); mine.push({ coll: 'nodes', id: cid, body: null }); }
            // where it goes: an explicit position wins, otherwise a new parent means a free spot beside the parent's other children
            let moved = [];
            if ('parent' in u) {
              const p = String(u.parent == null ? '' : u.parent);
              if (p && p !== n.parent) { const par = need(V, p); if (p === n.id || V.descendants(n.id).some(d => d.id === p)) throw new ToolError(name(n) + ' can\'t sit under itself or something under it.');
                const s = place(V, par); moved = branchMoves(V, n, s.x, s.y); if (hooks.reparented) hooks.reparented(); }
              else if (!p && n.parent) { const s = rootSpot(V); moved = branchMoves(V, n, s.x, s.y); if (hooks.reparented) hooks.reparented(); }
              patch.parent = p;
              if (!p && n.parent && typeof n.hue !== 'number') patch.hue = baseHue(V);
            }
            if (typeof u.x === 'number' || typeof u.y === 'number') moved = branchMoves(V, n, typeof u.x === 'number' ? u.x : n.x, typeof u.y === 'number' ? u.y : n.y);
            const self = moved.find(m => m.id === n.id);
            mine.push(N(n, { ...patch, ...(self ? { x: self.x, y: self.y } : {}) }));
            for (const m of moved) if (m.id !== n.id) mine.push(N(V.nodes.get(m.id), { x: m.x, y: m.y }));
          }
          V.apply(mine); changes.push(...mine); done.push(u.id); names.push(name(V.get(String(u.id))));
        } catch (e) { if (!(e instanceof ToolError)) throw e; problems.push({ id: u.id, error: e.message }); }
      }
      if (!done.length) throw new ToolError(JSON.stringify(problems));
      await save(V, changes);
      return { result: { updated: done, ...(problems.length ? { problems } : {}) }, step: (names.length === 1 ? 'Changed ' + names[0] : 'Changed ' + names.length + ' items') + (problems.length ? ' (' + problems.length + ' failed)' : ''), bad: problems.length > 0 };
    },
    // deleting moves what's under an item up a level; a tile's chips, and the cross-links, dependencies and rank picks go with it (the cascade)
    async delete_items(a) {
      const V = ctx.view(), all = (Array.isArray(a.ids) ? a.ids : []).map(String), chipIds = all.filter(id => V.chips.has(id)), ids = all.filter(id => V.nodes.has(id));
      if (!ids.length && !chipIds.length) throw new ToolError('None of those ids exist.');
      const gone = new Set(ids), changes = [], upTo = n => { let p = n.parent; while (p && gone.has(p)) p = (V.nodes.get(p) || {}).parent; return p || ''; };
      for (const n of V.nodes.values()) if (!gone.has(n.id) && gone.has(n.parent)) changes.push(N(n, { parent: upTo(n), ...(upTo(n) ? {} : { hue: V.hueOf(n) }) }));
      for (const id of [...ids, ...chipIds]) changes.push({ coll: 'nodes', id, body: null });
      const labels = [...ids, ...chipIds].map(id => name(V.get(id)));
      await save(V, changes);
      const missing = all.filter(id => !gone.has(id) && !chipIds.includes(id));
      return { result: { deleted: [...ids, ...chipIds], ...(missing.length ? { notFound: missing } : {}) }, step: labels.length === 1 ? 'Removed ' + labels[0] : 'Removed ' + labels.length + ' items' };
    },
    async create_links(a) {
      const V = ctx.view(), list = Array.isArray(a.links) ? a.links : []; if (!list.length) throw new ToolError('Give at least one link.');
      const ch = list.map(l => { const A = needAny(V, l.a), B = needAny(V, l.b); if (A.id === B.id) throw new ToolError('A cross-link joins two different items.'); return { coll: 'links', id: uid('l'), body: { a: A.id, b: B.id, label: String(l.label || '').trim() } }; });
      await save(V, ch); if (hooks.linked) hooks.linked();
      return { result: { created: ch.map(c => c.id), note: 'Cross-links show in Life Web when Filter › Relationships › Cross-links is on.' }, step: 'Cross-linked ' + plural(ch.length, 'pair', 'pairs') };
    },
    async create_dependencies(a) {
      const V = ctx.view(), list = Array.isArray(a.dependencies) ? a.dependencies : []; if (!list.length) throw new ToolError('Give at least one dependency.');
      const ch = list.map(d => { const t = needAny(V, d.task), nd = needAny(V, d.needs); if (t.id === nd.id) throw new ToolError('Something can\'t wait on itself.');
        if (waitsOn(V, t.id, nd.id)) throw new ToolError(name(nd) + ' already waits on ' + name(t) + ', so that would go round in a loop.');
        const c = { coll: 'deps', id: uid('d'), body: { task: t.id, needs: nd.id, why: String(d.why || '').trim() } }; V.apply([c]); return c; });
      await save(V, ch); if (hooks.depended) hooks.depended();
      return { result: { created: ch.map(c => c.id), note: 'Dependencies show in Life Web when Filter › Relationships › Dependencies is on.' }, step: 'Added ' + plural(ch.length, 'dependency', 'dependencies') };
    },
    async update_connections(a) {
      const V = ctx.view(), list = Array.isArray(a.items) ? a.items : []; if (!list.length) throw new ToolError('Give at least one.');
      const ch = list.map(u => { const l = V.links.get(u.id), d = V.deps.get(u.id);
        if (l) return { coll: 'links', id: l.id, body: { a: l.a, b: l.b, label: 'label' in u ? String(u.label).trim() : l.label || '' } };
        if (d) return { coll: 'deps', id: d.id, body: { task: d.task, needs: d.needs, why: 'why' in u ? String(u.why).trim() : d.why || '' } };
        throw new ToolError('No cross-link or dependency has the id "' + u.id + '".'); });
      await save(V, ch);
      return { result: { updated: ch.map(c => c.id) }, step: 'Changed ' + plural(ch.length, 'connection', 'connections') };
    },
    async delete_connections(a) {
      const V = ctx.view(), ids = Array.isArray(a.ids) ? a.ids : [], good = ids.filter(id => V.links.has(id) || V.deps.has(id));
      if (!good.length) throw new ToolError('None of those are cross-links or dependencies.');
      await save(V, good.map(id => ({ coll: V.links.has(id) ? 'links' : 'deps', id, body: null })));
      return { result: { deleted: good, ...(good.length < ids.length ? { notFound: ids.filter(i => !good.includes(i)) } : {}) }, step: 'Removed ' + plural(good.length, 'connection', 'connections') };
    },
    async set_tag_colors(a) {
      const V = ctx.view(), list = Array.isArray(a.tags) ? a.tags : []; if (!list.length) throw new ToolError('Give at least one tag.');
      const ch = list.map(t => { const nm = V.tagNames().find(x => x.toLowerCase() === String(t.name || '').trim().toLowerCase()); if (!nm) throw new ToolError('Nothing has the tag "' + t.name + '".');
        const hue = Math.round(+t.hue); if (!Number.isFinite(hue) || hue < 0 || hue > 359) throw new ToolError('hue is 0 to 359.');
        const m = [...V.tagMeta.values()].find(x => x.name === nm), shade = t.shade == null ? (m && m.shade) || 0 : Math.max(-100, Math.min(100, Math.round(+t.shade) || 0));
        return { coll: 'tagmeta', id: m ? m.id : tagId(nm), body: { name: nm, hue, ...(shade ? { shade } : {}) } }; });
      await save(V, ch);
      return { result: { colored: ch.map(c => c.body.name) }, step: 'Recoloured ' + plural(ch.length, 'tag', 'tags') };
    }
  };
}

module.exports = { makeTools, outline, ToolError, checkDate, checkTime, checkEnum, startPatch, clampEnd, NO_CONCEPT_CHIPS };
