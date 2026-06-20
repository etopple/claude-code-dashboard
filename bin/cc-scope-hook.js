#!/usr/bin/env node
'use strict';

// cc-scope hook bridge — wire Claude Code hooks to the dashboard's live feed.
// Reads the hook JSON on stdin, shapes a compact event, POSTs it to the
// dashboard /ingest endpoint, and ALWAYS exits 0 fast so it can never block or
// fail the agent. If the server is down, it silently no-ops.
//
// Settings wiring (any subset — PostToolUse is the useful one):
//   PostToolUse / Stop / SubagentStop / UserPromptSubmit / Notification
//     -> command: node "<repo>/bin/cc-scope-hook.js"
// Honors CCSCOPE_DASH_PORT (default 4001).

const http = require('node:http');

const HARD_EXIT = setTimeout(() => process.exit(0), 800);
HARD_EXIT.unref();

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { data += c; });
process.stdin.on('end', () => {
  let h = {};
  try { h = JSON.parse(data); } catch { return done(); }
  const ev = shape(h);
  if (!ev) return done();
  post(ev);
});
process.stdin.on('error', done);

function done() { clearTimeout(HARD_EXIT); process.exit(0); }
function trunc(v, n) { const s = typeof v === 'string' ? v : JSON.stringify(v ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; }

function shape(h) {
  const name = h.hook_event_name || '';
  const base = { sessionId: h.session_id || '', cwd: h.cwd || '', ts: Date.now() };
  if (name === 'PostToolUse') {
    const tr = h.tool_response;
    const txt = typeof tr === 'string' ? tr : JSON.stringify(tr ?? '');
    const isError = !!(tr && typeof tr === 'object' && (tr.is_error || tr.error || (tr.stderr && !tr.stdout && tr.interrupted)))
      || (typeof tr === 'string' && /\b(error|failed|not found|denied|exception)\b/i.test(tr));
    return { ...base, kind: 'tool', tool: h.tool_name || '?', inputPreview: trunc(h.tool_input, 200), isError, resultPreview: trunc(txt, 300) };
  }
  if (name === 'UserPromptSubmit') return { ...base, kind: 'prompt', text: trunc(h.prompt, 300) };
  if (name === 'Stop') return { ...base, kind: 'stop' };
  if (name === 'SubagentStop') return { ...base, kind: 'subagent_stop' };
  if (name === 'Notification') return { ...base, kind: 'notification', text: trunc(h.message, 200) };
  return null;
}

function post(ev) {
  const body = JSON.stringify(ev);
  const req = http.request({
    host: '127.0.0.1',
    port: Number(process.env.CCSCOPE_DASH_PORT || 4001),
    path: '/ingest',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    timeout: 500,
  }, (res) => { res.resume(); res.on('end', done); });
  req.on('error', done);
  req.on('timeout', () => { req.destroy(); done(); });
  req.write(body);
  req.end();
}
