'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const { createProxy } = require('./lib/proxy');
const { parseSSE, reconstructMessage } = require('./lib/sse');
const { TranscriptWatcher } = require('./lib/transcripts');
const { Store } = require('./lib/store');
const { LiveSession } = require('./lib/livestream');
const { getAccountUsage } = require('./lib/usage');
const { buildCatalog } = require('./lib/skills');
const { buildRoster } = require('./lib/agents');

const ADMIN_KEY = process.env.CCSCOPE_ADMIN_KEY || '';

const PROXY_PORT = Number(process.env.CCSCOPE_PROXY_PORT || 4000);
const DASH_PORT = Number(process.env.CCSCOPE_DASH_PORT || 4001);
const UPSTREAM_HOST = process.env.CCSCOPE_UPSTREAM || 'api.anthropic.com';
// Default 0 = load ALL local transcript history. Set CCSCOPE_BACKFILL_HOURS=24 to limit.
const BACKFILL_MS = Number(process.env.CCSCOPE_BACKFILL_HOURS || 0) * 60 * 60 * 1000;
const ROOT = __dirname;
const LOG_ROOT = path.join(ROOT, 'logs');
const PUBLIC_DIR = path.join(ROOT, 'public');
const TRANSCRIPT_ROOT = process.env.CCSCOPE_TRANSCRIPT_ROOT
  ? path.resolve(process.env.CCSCOPE_TRANSCRIPT_ROOT)
  : path.join(os.homedir(), '.claude', 'projects');
const TRANSCRIPT_ROOT_LABEL = displayPathForUi(TRANSCRIPT_ROOT);

function displayPathForUi(value) {
  const insideRepo = path.relative(ROOT, value);
  if (insideRepo && !insideRepo.startsWith('..') && !path.isAbsolute(insideRepo)) return insideRepo.replace(/\\/g, '/');
  if (!insideRepo) return '.';

  const home = os.homedir();
  const insideHome = path.relative(home, value);
  if (insideHome && !insideHome.startsWith('..') && !path.isAbsolute(insideHome)) return ('~/' + insideHome).replace(/\\/g, '/');
  if (!insideHome) return '~';

  return value.replace(/\\/g, '/');
}

// ---------------------------------------------------------------- scrubbing
const SCRUB_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'set-cookie']);
function scrubHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SCRUB_HEADERS.has(k.toLowerCase()) ? '<redacted>' : v;
  }
  return out;
}

// ---------------------------------------------------------------- wire log
// Full round-trips go to logs/<date>/wire.jsonl; memory keeps only summaries
// plus a byte-range index so the inspector can read full records from disk.
let wireSeq = 0;
const wireIndex = new Map(); // id -> { file, offset, length }

function wireLogFile() {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(LOG_ROOT, day);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'wire.jsonl');
}

function persistWire(record) {
  const file = wireLogFile();
  const line = JSON.stringify(record) + '\n';
  let offset = 0;
  try { offset = fs.statSync(file).size; } catch { offset = 0; }
  fs.appendFileSync(file, line);
  wireIndex.set(record.id, { file, offset, length: Buffer.byteLength(line) });
}

function readWire(id) {
  const loc = wireIndex.get(id);
  if (!loc) return null;
  const fd = fs.openSync(loc.file, 'r');
  try {
    const buf = Buffer.alloc(loc.length);
    fs.readSync(fd, buf, 0, loc.length, loc.offset);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------- capture
const store = new Store();

function decodeBody(body, headers) {
  const enc = String(headers['content-encoding'] || '').toLowerCase();
  try {
    if (enc === 'gzip') return zlib.gunzipSync(body);
    if (enc === 'br') return zlib.brotliDecompressSync(body);
    if (enc === 'deflate') return zlib.inflateSync(body);
  } catch { /* fall through to raw */ }
  return body;
}

function onCapture(cap) {
  const resBody = decodeBody(cap.responseBody, cap.responseHeaders);
  const contentType = String(cap.responseHeaders['content-type'] || '');

  let requestJson = null;
  try { requestJson = JSON.parse(cap.requestBody.toString('utf8')); } catch { /* non-JSON request */ }

  const response = { headers: scrubHeaders(cap.responseHeaders) };
  if (contentType.includes('text/event-stream')) {
    const { message, error, eventCounts } = reconstructMessage(parseSSE(resBody.toString('utf8')));
    response.message = message;
    response.error = error;
    response.eventCounts = eventCounts;
  } else {
    try { response.body = JSON.parse(resBody.toString('utf8')); }
    catch { response.bodyText = resBody.toString('utf8').slice(0, 20000); }
  }

  const requestId = cap.responseHeaders['request-id'] || cap.responseHeaders['x-request-id'] || null;
  const record = {
    id: 'w' + (++wireSeq) + '-' + cap.startedAt.toString(36),
    ts: new Date(cap.startedAt).toISOString(),
    durationMs: cap.endedAt - cap.startedAt,
    ttfbMs: cap.ttfbMs,
    method: cap.method,
    path: cap.path,
    status: cap.status,
    requestId,
    request: {
      headers: scrubHeaders(cap.requestHeaders),
      body: requestJson ?? cap.requestBody.toString('utf8').slice(0, 20000),
    },
    response,
  };

  try { persistWire(record); }
  catch (err) { console.error('[wire] persist failed:', err.message); }

  const msg = response.message || response.body || {};
  store.addWire({
    id: record.id,
    ts: record.ts,
    startedAt: cap.startedAt,
    durationMs: record.durationMs,
    ttfbMs: record.ttfbMs,
    method: cap.method,
    path: cap.path,
    status: cap.status,
    requestId,
    model: (requestJson && requestJson.model) || msg.model || null,
    stream: !!(requestJson && requestJson.stream),
    messagesInRequest: requestJson && Array.isArray(requestJson.messages) ? requestJson.messages.length : null,
    toolsOffered: requestJson && Array.isArray(requestJson.tools) ? requestJson.tools.length : null,
    systemChars: requestJson && requestJson.system ? JSON.stringify(requestJson.system).length : 0,
    stopReason: msg.stop_reason || null,
    usage: msg.usage || null,
    error: response.error || (cap.status >= 400 ? (response.body || response.bodyText) : null) || null,
  });
}

// ---------------------------------------------------------------- dashboard
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

// Shape a raw Claude Code hook payload into a compact feed event. Mirrors
// bin/cc-scope-hook.js so the native `http` hook can POST straight here.
function normalizeHook(h) {
  const trunc = (v, n) => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
  const base = { sessionId: h.session_id || '', cwd: h.cwd || '', ts: Date.now() };
  switch (h.hook_event_name) {
    case 'PostToolUse': {
      const tr = h.tool_response;
      const txt = typeof tr === 'string' ? tr : JSON.stringify(tr ?? '');
      const isError = !!(tr && typeof tr === 'object' && (tr.is_error || tr.error || (tr.stderr && !tr.stdout && tr.interrupted)))
        || (typeof tr === 'string' && /\b(error|failed|not found|denied|exception)\b/i.test(tr));
      return { ...base, kind: 'tool', tool: h.tool_name || '?', inputPreview: trunc(h.tool_input, 200), isError, resultPreview: trunc(txt, 300) };
    }
    case 'UserPromptSubmit': return { ...base, kind: 'prompt', text: trunc(h.prompt, 300) };
    case 'Stop': return { ...base, kind: 'stop' };
    case 'SubagentStop': return { ...base, kind: 'subagent_stop' };
    case 'Notification': return { ...base, kind: 'notification', text: trunc(h.message, 200) };
    default: return null;
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

const sseClients = new Set();
store.on('event', (ev) => {
  if (sseClients.size === 0) return;
  const frame = `data: ${JSON.stringify(ev)}\n\n`;
  for (const client of sseClients) client.write(frame);
});

const dashboard = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/api/ping') return sendJson(res, 200, { ok: true, wireCount: store.wireCount, sessions: store.sessions.size, transcriptRoot: TRANSCRIPT_ROOT_LABEL });

  if (p === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', sessions: store.listSessions(), wireCount: store.wireCount, transcriptRoot: TRANSCRIPT_ROOT_LABEL })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Hook sink — Claude Code hooks POST events here for the universal live feed.
  // Accepts the RAW hook JSON (native `http` hook type — zero process spawn) and
  // normalizes server-side, OR a pre-shaped event (legacy bin/cc-scope-hook.js).
  // Replies fast, never blocks the agent. Localhost-only; previews are redacted
  // + truncated in the store.
  if (p === '/ingest' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        const ev = j.hook_event_name ? normalizeHook(j) : j; // raw vs pre-shaped
        if (ev) store.addHookEvent(ev);
      } catch { /* ignore malformed hook */ }
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  if (p === '/api/sessions') return sendJson(res, 200, store.listSessions());

  if (p === '/api/errors') return sendJson(res, 200, store.errorRollup());

  if (p === '/api/skills') {
    try { return sendJson(res, 200, buildCatalog(store.errorRollup())); }
    catch (err) { return sendJson(res, 200, { error: err.message, skills: [], commands: [], needed: [], tools: [], counts: {} }); }
  }

  if (p === '/api/livefeed') return sendJson(res, 200, store.getLiveFeed());

  if (p === '/api/agents') {
    try { return sendJson(res, 200, buildRoster()); }
    catch (err) { return sendJson(res, 200, { error: err.message, roster: [], counts: {}, totalRuns: 0 }); }
  }

  if (p === '/api/daily') return sendJson(res, 200, store.dailyRollup());

  if (p === '/api/roi') return sendJson(res, 200, store.roiRollup());

  if (p === '/api/account-usage') {
    const days = Math.min(180, Math.max(1, Number(url.searchParams.get('days')) || 30));
    getAccountUsage({ key: ADMIN_KEY, days })
      .then((data) => sendJson(res, 200, data))
      .catch((err) => sendJson(res, 200, { configured: true, error: err.message }));
    return;
  }

  if (p.startsWith('/api/session/')) {
    const id = decodeURIComponent(p.slice('/api/session/'.length));
    const detail = store.sessionDetail(id);
    return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: 'unknown session' });
  }

  if (p.startsWith('/api/wire/')) {
    const id = decodeURIComponent(p.slice('/api/wire/'.length));
    let raw = null;
    try { raw = readWire(id); } catch (err) { return sendJson(res, 500, { error: err.message }); }
    if (raw == null) return sendJson(res, 404, { error: 'unknown wire record' });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(raw);
  }

  // static files
  let rel = p === '/' ? 'index.html' : (p === '/live' ? 'live.html' : p.slice(1));
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------------------------------------------------------- start
const watcher = new TranscriptWatcher(TRANSCRIPT_ROOT);
watcher.on('entry', ({ entry }) => {
  try { store.addTranscriptEntry(entry); }
  catch (err) { console.error('[store] entry error:', err.message); }
});

// Live stream-of-consciousness: forward SSE deltas to the console view as they
// arrive. One LiveSession per proxied /v1/messages stream.
const liveTrackers = new Map();
function pushLive(ev) {
  if (sseClients.size === 0) return;
  const frame = `data: ${JSON.stringify({ type: 'live', ev })}\n\n`;
  for (const client of sseClients) client.write(frame);
}
const onLive = {
  start({ id, body }) {
    const tracker = new LiveSession(id, pushLive);
    let reqJson = null;
    try { reqJson = JSON.parse(body.toString('utf8')); } catch { /* non-JSON */ }
    tracker.request(reqJson);
    liveTrackers.set(id, tracker);
    if (liveTrackers.size > 64) liveTrackers.delete(liveTrackers.keys().next().value);
  },
  responseStart({ id, headers }) {
    const tracker = liveTrackers.get(id);
    if (!tracker) return;
    if (String(headers['content-type'] || '').includes('event-stream')) tracker.begin();
    else liveTrackers.delete(id); // non-stream (e.g. JSON reply) — nothing to show
  },
  chunk({ id }, chunk) {
    const tracker = liveTrackers.get(id);
    if (tracker) tracker.push(chunk.toString('utf8'));
  },
  end({ id }) {
    const tracker = liveTrackers.get(id);
    if (tracker) { tracker.end(); liveTrackers.delete(id); }
  },
};

const proxy = createProxy({ upstreamHost: UPSTREAM_HOST, onCapture, onLive });

proxy.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`[cc-scope] proxy     http://127.0.0.1:${PROXY_PORT}  ->  https://${UPSTREAM_HOST}`);
});
dashboard.listen(DASH_PORT, '127.0.0.1', () => {
  console.log(`[cc-scope] dashboard http://127.0.0.1:${DASH_PORT}`);
});
watcher.start({ backfillMs: BACKFILL_MS });
console.log(`[cc-scope] tailing   ${TRANSCRIPT_ROOT} (backfill ${BACKFILL_MS > 0 ? BACKFILL_MS / 3600000 + 'h' : 'all history'})`);
