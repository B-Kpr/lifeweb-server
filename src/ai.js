/* The Assistant through the owner's LM Studio (LIFEWEB_LMSTUDIO), so people the owner invites need nothing set up.
     GET  /api/ai              -> { available, allowed }
     GET  /api/ai/models       -> { models: [{ id, loaded, tools, context }] }
     POST /api/ai/chat { body } -> { content, reasoning, tool_calls, finish_reason }   (an OpenAI-style chat body, sent on unstreamed) */
'use strict';
function aiRoutes({ req, parts, send, body, LMSTUDIO, allowed }) {
  if (parts.length === 2 && req.method === 'GET') return send(200, { available: !!LMSTUDIO, allowed });
  if (!LMSTUDIO) return send(503, { error: 'The owner hasn’t connected an Assistant to Life Web Cloud.' });
  if (!allowed) return send(403, { error: 'The owner has turned the Assistant off for you.' });
  const lm = async (route, opts, ms) => { const r = await fetch(LMSTUDIO + route, { ...opts, signal: AbortSignal.timeout(ms) }); let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j }; };
  const down = e => send(502, { error: 'The owner’s LM Studio isn’t answering (' + (e && e.name === 'TimeoutError' ? 'timed out' : 'not reachable') + '). It may be switched off.' });
  if (parts[2] === 'models' && req.method === 'GET') return (async () => {
    try {
      const n = await lm('/api/v0/models', {}, 8000);
      if (n.status === 200 && n.j && Array.isArray(n.j.data)) return send(200, { models: n.j.data.filter(m => m.type === 'llm' || m.type === 'vlm').map(m => ({ id: m.id, loaded: m.state === 'loaded', tools: (m.capabilities || []).includes('tool_use'), context: m.loaded_context_length || 0 })) });
      const o = await lm('/v1/models', {}, 8000);
      if (o.status === 200 && o.j && Array.isArray(o.j.data)) return send(200, { models: o.j.data.map(m => ({ id: m.id, loaded: true, tools: true, context: 0 })) });
      send(502, { error: 'LM Studio answered ' + o.status });
    } catch (e) { down(e); }
  })();
  if (parts[2] === 'chat' && req.method === 'POST') return body(async m => {
    if (!m.body || !Array.isArray(m.body.messages)) return send(400, { error: 'No messages' });
    try {
      const r = await lm('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...m.body, stream: false }) }, 30 * 60000);
      if (r.status !== 200) return send(502, { error: 'LM Studio: ' + String((r.j && r.j.error && (r.j.error.message || r.j.error)) || 'HTTP ' + r.status).slice(0, 500) });
      const c = (r.j.choices && r.j.choices[0]) || {}, msg = c.message || {};
      const tool_calls = (msg.tool_calls || []).map(t => ({ id: t.id || '', type: 'function', function: { name: (t.function && t.function.name) || '', arguments: typeof (t.function && t.function.arguments) === 'string' ? t.function.arguments : JSON.stringify((t.function && t.function.arguments) || {}) } }));
      send(200, { content: msg.content || '', reasoning: msg.reasoning_content || msg.reasoning || '', tool_calls, finish_reason: c.finish_reason || 'stop' });
    } catch (e) { down(e); }
  });
  send(404, { error: 'Not found' });
}
module.exports = { aiRoutes };
