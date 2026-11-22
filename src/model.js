/* Life Web's board model, written once. What each kind of item stores, the time stamps, what deleting something takes with it, tag
   colours nobody uses any more, a quick check of what a client sends, and a view of one board with fast lookups.
   Life Web Cloud requires this file; the app's bundle imports it (web/src and the Assistant), so the server and the app always agree.
   Board format 2: concepts, tiles and chips (see docs/COMPATIBILITY.md). */
'use strict';

const FORMAT = 2;
const COLLS = ['nodes', 'links', 'deps', 'ranks', 'tagmeta'];
const ROOT_R = 86, SUB_R = 60, TILE_W = 220;
const HUES = [205, 32, 150, 345, 265, 185, 10, 95], TAG_HUES = [0, 22, 45, 62, 95, 140, 170, 195, 220, 255, 285, 320];
const CHIP_KINDS = { check: 'Check', note: 'Note', link: 'Link', text: 'Text' };
const STATUSES = ['todo', 'doing', 'done', 'reference'];

const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v);
const tagId = t => 'g-' + String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + [...String(t)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);
const tagsOf = n => Array.isArray(n && n.tags) ? n.tags : [];
const chipKind = c => CHIP_KINDS[c && c.chip] ? c.chip : 'note';
const isConceptKind = k => k === 'concept';
const times = o => ({ ...(o.created ? { created: +o.created } : {}), ...(o.modified ? { modified: +o.modified } : {}), ...(o.date && o.schedAt ? { schedAt: +o.schedAt } : {}) });

/* ---------------------------------------------------------------- what is stored for each kind of item */
const chipBody = c => {
  const k = chipKind(c), loose = !c.dock;
  return { kind: 'chip', chip: k, label: c.label || '', parent: c.parent || '', dock: !!c.dock, order: +c.order || 0,
    ...(loose ? { x: Math.round(c.x || 0), y: Math.round(c.y || 0) } : {}),
    ...(k === 'check' ? { done: !!c.done, date: c.date || '', time: c.time || '', endDate: c.date ? (c.endDate || '') : '', endTime: c.date ? (c.endTime || '') : '', ...(c.mxOut ? { mxOut: true } : {}) } : {}),
    ...(k === 'link' ? { url: String(c.url || '').trim() } : {}),
    tags: tagsOf(c).slice(),
    ...(loose && +c.w > 0 ? { w: Math.round(Math.min(900, Math.max(80, +c.w))) } : {}), ...(+c.h > 0 ? { h: Math.round(Math.min(1400, Math.max(24, +c.h))) } : {}),
    ...(typeof c.hue === 'number' ? { hue: c.hue } : {}), ...times(c) };
};
// a concept or a tile (a tile keeps its notes and link in chips, never on itself)
const nodeBody = n => n.kind === 'chip' ? chipBody(n) : ({ kind: isConceptKind(n.kind) ? 'concept' : 'tile', label: n.label || '', parent: n.parent || '', x: Math.round(n.x || 0), y: Math.round(n.y || 0),
  status: n.status || 'todo', ...(isConceptKind(n.kind) ? { notes: n.notes || '' } : {}), date: n.date || '', time: n.time || '', endDate: n.date ? (n.endDate || '') : '', endTime: n.date ? (n.endTime || '') : '', repeat: n.date ? (n.repeat || '') : '',
  tags: tagsOf(n).slice(), ...(typeof n.hue === 'number' ? { hue: n.hue } : {}), ...(typeof n.hue === 'number' && n.shade ? { shade: Math.max(-100, Math.min(100, Math.round(n.shade))) } : {}),
  ...(typeof n.hue === 'number' && n.hueLock ? { hueLock: n.hueLock === 'one' ? 'one' : 'branch' } : {}), ...(n.mxOut ? { mxOut: true } : {}),
  ...(isConceptKind(n.kind) ? (+n.r > 0 ? { r: Math.round(Math.min(400, Math.max(28, +n.r))) } : {}) : { ...(+n.w > 0 ? { w: Math.round(Math.min(900, Math.max(120, +n.w))) } : {}), ...(+n.h > 0 ? { h: Math.round(Math.min(1400, Math.max(40, +n.h))) } : {}) }), ...times(n) });
const N = (n, patch) => ({ coll: 'nodes', id: n.id, body: { ...nodeBody(n), ...(patch || {}) } });
const C = (c, patch) => ({ coll: 'nodes', id: c.id, body: chipBody({ ...c, ...(patch || {}) }) });

/* what a client sends, checked before Life Web Cloud keeps it: the kinds this format knows, and none of the older format's fields.
   Fields it doesn't know are left alone, so a newer app of the same format can add some. Returns what's wrong, or ''. */
function checkItem(coll, b) {
  if (b == null) return '';
  const str = k => b[k] === undefined || typeof b[k] === 'string';
  if (coll === 'nodes') {
    if (!['concept', 'tile', 'chip'].includes(b.kind)) return 'An item is a concept, a tile or a chip (format ' + FORMAT + '), not "' + b.kind + '".';
    if (!str('label') || !str('parent')) return 'An item\'s label and parent are text.';
    if (b.kind === 'tile' && ('notes' in b || 'link' in b || 'checklist' in b)) return 'A tile keeps its notes, link and steps in chips (format ' + FORMAT + ').';
    if (b.kind === 'chip' && !CHIP_KINDS[b.chip]) return 'A chip is a check, a note, a link or text.';
    if (b.tags !== undefined && !Array.isArray(b.tags)) return 'tags is a list.';
  } else if (coll === 'links' || coll === 'ranks') {
    if (typeof b.a !== 'string' || typeof b.b !== 'string' || !b.a || !b.b) return 'A ' + (coll === 'links' ? 'cross-link' : 'rank pick') + ' joins two item ids (a and b).';
  } else if (coll === 'deps') {
    if (typeof b.task !== 'string' || typeof b.needs !== 'string' || !b.task || !b.needs) return 'A dependency has a task and what it needs, both item ids.';
    if ('taskItem' in b || 'needsItem' in b) return 'A dependency joins item ids; a step is a chip with its own id (format ' + FORMAT + ').';
  } else if (coll === 'tagmeta') {
    if (typeof b.name !== 'string' || !b.name) return 'A tag colour needs the tag\'s name.';
  }
  return '';
}

/* the time stamps: new things get created, real changes (not moving them about) get modified, a first date gets schedAt.
   old: the item's stored body before this change (or null) */
function stampTimes(c, old, now = Date.now()) {
  if (c.coll !== 'nodes' || !c.body) return c;
  const nw = { ...c.body };
  const bare = o => { const { x, y, order, created, modified, schedAt, ...r } = o; return stable(r); };
  if (!old) { nw.created = +nw.created || now; nw.modified = +nw.modified || nw.created; if (nw.date) nw.schedAt = +nw.schedAt || now; }
  else { nw.created = +old.created || +nw.created || undefined; nw.modified = bare(old) !== bare(nw) ? now : +old.modified || undefined; if (nw.date) nw.schedAt = old.date ? (+old.schedAt || undefined) : now; }
  for (const k of ['created', 'modified', 'schedAt']) if (!nw[k]) delete nw[k];
  if (!nw.date) delete nw.schedAt;
  return { ...c, body: nw };
}

/* ---------------------------------------------------------------- two devices changing one item
   A device sends the item as it has it (mine) with the version it started from (base); the server has its own (theirs). Every field
   only one side changed is kept from that side, so a tick on the phone and a move on the desktop both survive. The same field changed
   differently on both, or the item deleted on one side and changed on the other, is a clash: the server keeps its own and says so.
   The time stamps never clash (the later one is kept). Returns { body } or { clash: [fields] }. */
const TIME_KEYS = ['created', 'modified', 'schedAt'];
function mergeBodies(base, mine, theirs) {
  if (stable(theirs) === stable(base) || stable(mine) === stable(theirs)) return { body: mine };
  if (mine == null || theirs == null || base == null) return { clash: [mine == null ? 'deleted here, changed on another device' : theirs == null ? 'deleted on another device' : 'made on two devices'] };
  const out = {}, clash = [];
  for (const k of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
    if (TIME_KEYS.includes(k)) continue;
    const b = stable(base[k]), m = stable(mine[k]), t = stable(theirs[k]);
    const v = m !== b ? (t !== b && t !== m ? (clash.push(k), mine[k]) : mine[k]) : theirs[k];
    if (v !== undefined) out[k] = v;
  }
  if (clash.length) return { clash };
  for (const k of TIME_KEYS) { const v = Math.max(+mine[k] || 0, +theirs[k] || 0); if (v) out[k] = v; }
  return { body: out };
}

/* ---------------------------------------------------------------- what History keeps for a change
   An item edited keeps only the fields that changed, before and after, plus a few small ones that name it (kind, chip, label, url, dock);
   x and y travel together, and so do w, h and r, so a line can say where something moved to and how big it is. A field that wasn't there
   on one side is listed in that side's $gone. New and deleted items keep their whole body (As it was needs it to bring them back). */
const NAMING = ['kind', 'chip', 'label', 'url', 'dock'], TOGETHER = [['x', 'y'], ['w', 'h', 'r'], ['order', 'dock']];
function diffBodies(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter(k => !(k in a && k in b && stable(a[k]) === stable(b[k]))));
  for (const g of TOGETHER) if (g.some(k => keys.has(k))) for (const k of g) if (k in a || k in b) keys.add(k);
  if (!keys.size) return null;
  for (const k of NAMING) if (k in a || k in b) keys.add(k);
  const before = {}, after = {}, goneB = [], goneA = [];
  for (const k of keys) { if (k in a) before[k] = a[k]; else goneB.push(k); if (k in b) after[k] = b[k]; else goneA.push(k); }
  if (goneB.length) before.$gone = goneB; if (goneA.length) after.$gone = goneA;
  return { before, after };
}
// a body with one side of a diff put on it (undoDiff(now, before) is the item as it was before the change)
const onto = (body, side) => { const o = { ...(body || {}) }; for (const [k, v] of Object.entries(side || {})) if (k !== '$gone') o[k] = v; for (const k of (side && side.$gone) || []) delete o[k]; return o; };
// one side of a diff as the fields it describes (what History's describer reads)
const sideFields = side => { const o = { ...(side || {}) }; delete o.$gone; return o; };

/* ---------------------------------------------------------------- one board, with fast lookups
   maps: { nodes, chips, links, deps, ranks, tagMeta }, each a Map of id -> item (with its id). The view keeps its own copies, so
   apply() can try changes out without touching the originals; its lookups (children, chips) are indexed and rebuilt when it changes. */
function makeView(maps) {
  const copy = m => new Map([...(m || new Map())].map(([k, v]) => [k, v]));
  const V = { nodes: copy(maps.nodes), chips: copy(maps.chips), links: copy(maps.links), deps: copy(maps.deps), ranks: copy(maps.ranks), tagMeta: copy(maps.tagMeta) };
  let kids = null, chipIx = null;
  const index = () => {
    if (kids) return;
    kids = new Map(); chipIx = new Map();
    for (const n of V.nodes.values()) { if (!kids.has(n.parent || '')) kids.set(n.parent || '', []); if (n.parent !== n.id) kids.get(n.parent || '').push(n); }
    for (const c of V.chips.values()) { if (!chipIx.has(c.parent || '')) chipIx.set(c.parent || '', []); chipIx.get(c.parent || '').push(c); }
    for (const l of chipIx.values()) l.sort((a, b) => (+a.order || 0) - (+b.order || 0) || String(a.id).localeCompare(String(b.id)));
  };
  V.kidsOf = id => { index(); return (kids.get(id) || []).slice(); };
  V.chipsOf = id => { index(); return (chipIx.get(id) || []).slice(); };
  V.dockedOf = id => V.chipsOf(id).filter(c => c.dock);
  V.isRoot = n => !n.parent || !V.nodes.has(n.parent);
  V.isTile = n => !!n && n.kind === 'tile';
  V.get = id => V.nodes.get(id) || V.chips.get(id);
  V.ancestors = n => { const out = []; let p = n.parent, g = 0; while (p && V.nodes.has(p) && g++ < 40) { out.push(p); p = V.nodes.get(p).parent; } return out; };
  V.descendants = id => { const out = []; const walk = (x, g) => { if (g > 40) return; for (const k of V.kidsOf(x)) { out.push(k); walk(k.id, g + 1); } }; walk(id, 0); return out; };
  V.hueOf = n => { let c = n, g = 0; while (c && g++ < 40) { if (typeof c.hue === 'number') return c.hue; c = V.nodes.get(c.parent); } return 220; };
  V.radiusOf = n => +n.r > 0 ? +n.r : V.isRoot(n) ? ROOT_R : SUB_R;
  V.pathName = n => [...V.ancestors(n).reverse().map(id => V.nodes.get(id).label), n.label].join(' › ');
  V.tagNames = () => { const s = new Set(); for (const n of [...V.nodes.values(), ...V.chips.values()]) for (const t of tagsOf(n)) s.add(t); return [...s].sort((a, b) => a.localeCompare(b)); };
  V.tagHue = t => { const m = [...V.tagMeta.values()].find(x => x.name === t); if (m && typeof m.hue === 'number') return m.hue; let h = 0; for (const c of String(t).toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0; return TAG_HUES[h % TAG_HUES.length]; };
  V.freeHue = () => { const names = [...new Set([...V.tagNames(), ...[...V.tagMeta.values()].map(m => m.name)])], used = new Set(names.map(V.tagHue)); return TAG_HUES.find(h => !used.has(h)) ?? TAG_HUES[names.length % TAG_HUES.length]; };
  // a tile's or concept's size, as near as can be told without drawing it
  V.sizeOf = n => { if (isConceptKind(n.kind)) { const r = V.radiusOf(n); return { w: Math.round(r * 2.9), h: Math.round(r * 1.2) }; }
    const w = +n.w > 0 ? +n.w : TILE_W, per = Math.max(18, Math.floor((w - 30) / 7.5));
    const lines = Math.ceil(Math.max(1, String(n.label || '').length) / per) + V.dockedOf(n.id).reduce((t, c) => t + Math.max(1, Math.ceil(String(c.label || c.url || '').length / per)), 0) + (n.date ? 1 : 0) + (tagsOf(n).length ? 1 : 0) + 1;
    return { w, h: Math.max(+n.h || 0, 34 + lines * 20) }; };
  // try changes out on the view
  V.apply = changes => { for (const c of changes) {
    const m = c.coll === 'nodes' ? null : V[{ links: 'links', deps: 'deps', ranks: 'ranks', tagmeta: 'tagMeta' }[c.coll]];
    if (c.coll === 'nodes') { V.nodes.delete(c.id); V.chips.delete(c.id); if (c.body) (c.body.kind === 'chip' ? V.chips : V.nodes).set(c.id, { id: c.id, ...c.body }); }
    else if (m) { if (c.body) m.set(c.id, { id: c.id, ...c.body }); else m.delete(c.id); }
  } kids = chipIx = null; };
  return V;
}
// a stored board ({ nodes: {id: body}, links, deps, ranks, tagmeta }) as a view
function viewOf(snap) {
  const all = Object.entries((snap && snap.nodes) || {}).map(([id, b]) => [id, { id, ...b }]), m = c => new Map(Object.entries((snap && snap[c]) || {}).map(([id, b]) => [id, { id, ...b }]));
  return makeView({ nodes: new Map(all.filter(([, b]) => b.kind !== 'chip')), chips: new Map(all.filter(([, b]) => b.kind === 'chip')), links: m('links'), deps: m('deps'), ranks: m('ranks'), tagMeta: m('tagmeta') });
}

/* ---------------------------------------------------------------- what saving changes brings with it
   cascade: deleting a tile deletes the chips docked in it; loose chips under anything deleted move up to what that sat under; the
   cross-links, dependencies and rank picks of whatever goes, go too. */
function cascade(changes, V) {
  const out = [...changes], touched = new Set(changes.filter(c => c.coll === 'nodes').map(c => c.id)), gone = new Set();
  for (const c of changes) {
    if (c.coll !== 'nodes' || c.body) continue;
    gone.add(c.id);
    const n = V.nodes.get(c.id); if (!n) continue;
    for (const ch of V.chipsOf(n.id)) { if (touched.has(ch.id)) continue; touched.add(ch.id);
      if (ch.dock && V.isTile(n)) { out.push({ coll: 'nodes', id: ch.id, body: null }); gone.add(ch.id); }
      else out.push(C(ch, { parent: n.parent && V.nodes.has(n.parent) ? n.parent : '', dock: false, x: ch.x || n.x, y: ch.y || n.y + 120 })); }
  }
  if (gone.size) {
    const have = new Set(out.map(c => c.coll + '/' + c.id));
    for (const [coll, map, ends] of [['links', V.links, ['a', 'b']], ['deps', V.deps, ['task', 'needs']], ['ranks', V.ranks, ['a', 'b']]])
      for (const x of map.values()) if (ends.some(k => gone.has(x[k])) && !have.has(coll + '/' + x.id)) { have.add(coll + '/' + x.id); out.push({ coll, id: x.id, body: null }); }
  }
  return out;
}
// tag colours nobody uses any more (on any concept, tile or chip) go with the change that took the last use away
function tagCleanup(changes, V) {
  if (!changes.some(c => c.coll === 'nodes')) return changes;
  const after = new Map([...V.nodes, ...V.chips]); for (const c of changes) if (c.coll === 'nodes') { if (c.body) after.set(c.id, { id: c.id, ...c.body }); else after.delete(c.id); }
  const used = new Set(); for (const n of after.values()) for (const t of tagsOf(n)) used.add(String(t).toLowerCase());
  const touched = new Set(changes.filter(c => c.coll === 'tagmeta').map(c => c.id));
  const gone = [...V.tagMeta.values()].filter(m => !touched.has(m.id) && !used.has(String(m.name || '').toLowerCase())).map(m => ({ coll: 'tagmeta', id: m.id, body: null }));
  return gone.length ? [...changes, ...gone] : changes;
}

/* ---------------------------------------------------------------- placing new things */
function autoPlace(V, p) {
  let ang; const gp = V.nodes.get(p.parent);
  if (gp) ang = Math.atan2(p.y - gp.y, p.x - gp.x);
  else { const others = [...V.nodes.values()].filter(n => V.isRoot(n) && n.id !== p.id); if (others.length) { const cx = others.reduce((s, n) => s + n.x, 0) / others.length, cy = others.reduce((s, n) => s + n.y, 0) / others.length; ang = Math.atan2(p.y - cy, p.x - cx); } else ang = -Math.PI / 2; }
  const k = V.kidsOf(p.id).length, off = Math.ceil(k / 2) * 0.5 * (k % 2 ? 1 : -1), dist = (isConceptKind(p.kind) ? V.radiusOf(p) : 90) + 210;
  return { x: Math.round(p.x + Math.cos(ang + off) * dist), y: Math.round(p.y + Math.sin(ang + off) * dist) };
}
const rootSpot = V => { const roots = [...V.nodes.values()].filter(V.isRoot); return roots.length ? { x: Math.max(...roots.map(r => r.x)) + 700, y: roots[0].y } : { x: 0, y: 0 }; };

module.exports = { FORMAT, COLLS, ROOT_R, SUB_R, TILE_W, HUES, TAG_HUES, CHIP_KINDS, STATUSES, uid, stable, tagId, tagsOf, chipKind, isConceptKind, times,
  chipBody, nodeBody, N, C, checkItem, stampTimes, mergeBodies, diffBodies, onto, sideFields, makeView, viewOf, cascade, tagCleanup, autoPlace, rootSpot };
