/* What Claude's connector on Life Web Cloud adds to the shared board tools (board-tools.js): the tool list and instructions from the
   shared guide, and Tidy without the app. The board rules are in model.js, the tools themselves in board-tools.js. */
'use strict';
const VIA = 'Claude connector';

/* Tidy, without the app: each item's children hang in a row under it, branches side by side, base items left to right.
   Sizes are estimated, so it is roomy; Tidy web in Life Web makes it compact. V: a model view */
function treeTargets(V, tops) {
  const out = new Map(), GX = 40, GY = 90;
  const lay = n => { const s = V.sizeOf(n), kids = V.kidsOf(n.id).sort((a, b) => a.x - b.x || a.y - b.y).map(lay);
    const kw = kids.reduce((t, k) => t + k.w, 0) + GX * Math.max(0, kids.length - 1), w = Math.max(s.w, kw);
    return { n, s, kids, w, h: s.h + (kids.length ? GY + Math.max(...kids.map(k => k.h)) : 0) }; };
  const place = (L, left, top) => { out.set(L.n.id, { x: Math.round(left + L.w / 2), y: Math.round(top + L.s.h / 2) });
    let x = left + (L.w - (L.kids.reduce((t, k) => t + k.w, 0) + GX * Math.max(0, L.kids.length - 1))) / 2;
    for (const k of L.kids) { place(k, x, top + L.s.h + GY); x += k.w + GX; } };
  if (tops) { for (const n of tops) { const L = lay(n); place(L, n.x - L.w / 2, n.y - L.s.h / 2); } return out; }
  const roots = [...V.nodes.values()].filter(V.isRoot).sort((a, b) => a.x - b.x || a.y - b.y);
  let x = roots.length ? Math.min(...roots.map(r => r.x)) : 0; const top = roots.length ? Math.min(...roots.map(r => r.y - V.sizeOf(r).h / 2)) : 0;
  for (const r of roots) { const L = lay(r); place(L, x, top); x += L.w + 160; }
  return out;
}

/* the tool list and the instructions, from the shared guide (MCP shape) */
const GUIDE = require('./guide');
const TOOLS = GUIDE.tools('cloud').map(t => ({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.properties, ...(t.required ? { required: t.required } : {}) } }));
const INTRO = GUIDE.instructions();

module.exports = { TOOLS, INTRO, GUIDE, VIA, treeTargets };
