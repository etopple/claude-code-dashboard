'use strict';

/* CC·SCOPE live console — streams thinking / tool calls / results / text
   token-by-token as each proxied turn happens. Driven by the shared /events SSE. */

const $ = (id) => document.getElementById(id);
const feed = $('feed');

const state = {
  turns: new Map(),       // turn id -> { card, blocks: Map<index,{bodyEl,kind,startTs,toolId}>, footEl }
  tools: new Map(),       // toolId -> { statusEl } (cross-turn, for result correlation)
  suppressed: new Set(),  // ids of housekeeping turns (title-gen, quota) we don't render
  turnNo: 0,
  active: null,
  idleTimer: null,
};

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function clockNow() { return new Date().toLocaleTimeString('en-US', { hour12: false }); }
function fmtTok(n) {
  if (n == null) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function nearBottom() {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
}
function maybeScroll(force) {
  if ($('autoScroll').checked && (force || nearBottom())) {
    feed.scrollTop = feed.scrollHeight;
  }
}

// ------------------------------------------------------------------ SSE
function connect() {
  const es = new EventSource('/events');
  es.onopen = () => { $('connState').textContent = 'live'; $('connState').className = 'conn ok'; $('liveDot').classList.add('live'); };
  es.onerror = () => { $('connState').textContent = 'reconnecting…'; $('connState').className = 'conn bad'; $('liveDot').classList.remove('live'); };
  es.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'live') handleLive(msg.ev);
  };
}

function markStreaming() {
  $('streamState').textContent = '● streaming';
  $('streamState').className = 'conn streaming';
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    $('streamState').textContent = 'idle';
    $('streamState').className = 'conn';
  }, 4000);
}

// ------------------------------------------------------------------ render
function handleLive(ev) {
  // Drop Claude Code housekeeping turns (title generation, quota pings) — they
  // offer zero tools, unlike real agent turns which always carry the full set.
  if (ev.t === 'turn_start' && ev.tools === 0) { state.suppressed.add(ev.id); return; }
  if (ev.id && state.suppressed.has(ev.id)) return;

  const w = $('waiting');
  if (w) w.remove();
  markStreaming();

  switch (ev.t) {
    case 'turn_start': return turnStart(ev);
    case 'user': return userLine(ev);
    case 'tool_results': return toolResults(ev);
    case 'block': return blockStart(ev);
    case 'delta': return delta(ev);
    case 'block_stop': return blockStop(ev);
    case 'turn_meta': return turnMeta(ev);
    case 'turn_end':
    case 'turn_done': return turnEnd(ev);
    case 'error': return turnError(ev);
  }
}

function turnStart(ev) {
  state.turnNo++;
  const card = document.createElement('section');
  card.className = 'turn-card';
  const model = (ev.model || '').replace('claude-', '');
  const ctxTok = Math.round((ev.systemChars || 0) / 4);
  card.innerHTML = `
    <div class="turn-head">
      <span class="turn-no">turn ${state.turnNo}</span>
      <span class="turn-model">${escapeHtml(model)}</span>
      <span class="turn-ctx">${ev.messages} msgs · ${ev.tools} tools · ~${fmtTok(ctxTok)} sys</span>
      <span class="turn-time">${clockNow()}</span>
    </div>
    <div class="turn-body"></div>
    <div class="turn-foot"></div>`;
  feed.appendChild(card);
  const rec = {
    card,
    body: card.querySelector('.turn-body'),
    foot: card.querySelector('.turn-foot'),
    blocks: new Map(),
  };
  state.turns.set(ev.id, rec);
  state.active = rec;
  maybeScroll(true);
}

function activeRec(id) { return state.turns.get(id) || state.active; }

function userLine(ev) {
  const rec = activeRec(ev.id);
  if (!rec) return;
  const el = document.createElement('div');
  el.className = 'ln ln-user';
  el.innerHTML = `<span class="glyph">👤</span><span class="body">${escapeHtml(ev.text).slice(0, 4000)}</span>`;
  rec.body.appendChild(el);
  maybeScroll();
}

function toolResults(ev) {
  // Results of the previous turn's tool calls arrive in this turn's request.
  for (const r of ev.results) {
    const tool = state.tools.get(r.toolUseId);
    if (tool) {
      tool.statusEl.textContent = `${r.isError ? '✗' : '✓'} ${r.chars.toLocaleString()} chars`;
      tool.statusEl.className = 'tool-status ' + (r.isError ? 'err' : 'ok');
    }
  }
  maybeScroll();
}

function blockStart(ev) {
  const rec = activeRec(ev.id);
  if (!rec) return;
  const el = document.createElement('div');
  if (ev.blockType === 'thinking') {
    el.className = 'ln ln-think';
    el.innerHTML = `<span class="glyph">🧠</span><span class="body"></span><span class="cursor">▏</span>`;
  } else if (ev.blockType === 'text') {
    el.className = 'ln ln-text';
    el.innerHTML = `<span class="glyph">💬</span><span class="body"></span><span class="cursor">▏</span>`;
  } else if (ev.blockType === 'tool_use') {
    el.className = 'ln ln-tool';
    el.innerHTML = `<span class="glyph">🔧</span><span class="tool-name">${escapeHtml(ev.name || '?')}</span><span class="tool-args body"></span><span class="tool-status">running…</span>`;
  } else {
    el.className = 'ln ln-other';
    el.innerHTML = `<span class="glyph">·</span><span class="body">${escapeHtml(ev.blockType || '')}</span>`;
  }
  rec.body.appendChild(el);
  const block = {
    el,
    bodyEl: el.querySelector('.body'),
    kind: ev.blockType,
    startTs: Date.now(),
    toolId: ev.toolId,
    statusEl: el.querySelector('.tool-status'),
  };
  rec.blocks.set(ev.index, block);
  if (ev.blockType === 'tool_use' && ev.toolId) {
    state.tools.set(ev.toolId, { statusEl: block.statusEl });
  }
  maybeScroll();
}

function delta(ev) {
  const rec = activeRec(ev.id);
  if (!rec) return;
  const block = rec.blocks.get(ev.index);
  if (!block || !block.bodyEl) return;
  block.bodyEl.textContent += ev.text;
  maybeScroll();
}

function blockStop(ev) {
  const rec = activeRec(ev.id);
  if (!rec) return;
  const block = rec.blocks.get(ev.index);
  if (!block) return;
  const cursor = block.el.querySelector('.cursor');
  if (cursor) cursor.remove();
  const secs = ((Date.now() - block.startTs) / 1000).toFixed(1);
  if (block.kind === 'thinking' && !block.bodyEl.textContent) {
    // display:"omitted" — no summary text, but we still show it thought + how long
    block.bodyEl.innerHTML = `<span class="muted">thought for ${secs}s (summary omitted)</span>`;
  } else if (block.kind === 'thinking') {
    const tag = document.createElement('span');
    tag.className = 'block-secs';
    tag.textContent = `  ${secs}s`;
    block.el.appendChild(tag);
  }
  if (block.kind === 'tool_use' && block.statusEl && block.statusEl.textContent === 'running…') {
    block.statusEl.textContent = 'awaiting result…';
    block.statusEl.className = 'tool-status pending';
  }
  maybeScroll();
}

function turnMeta(ev) {
  const rec = activeRec(ev.id);
  if (!rec) return;
  rec.stopReason = ev.stopReason;
  rec.usage = ev.usage;
}

function turnEnd(ev) {
  const rec = state.turns.get(ev.id);
  if (!rec || rec.done) return;
  rec.done = true;
  for (const c of rec.card.querySelectorAll('.cursor')) c.remove();
  const u = rec.usage || {};
  const parts = [];
  if (rec.stopReason) parts.push(`stop: ${rec.stopReason}`);
  if (u.output_tokens != null) parts.push(`out ${fmtTok(u.output_tokens)} tok`);
  if (u.input_tokens != null) parts.push(`in ${fmtTok(u.input_tokens)}`);
  if (u.cache_read_input_tokens != null) parts.push(`cache-r ${fmtTok(u.cache_read_input_tokens)}`);
  rec.foot.textContent = parts.join('  ·  ');
  maybeScroll();
}

function turnError(ev) {
  const rec = activeRec(ev.id);
  if (!rec) return;
  const el = document.createElement('div');
  el.className = 'ln ln-err';
  el.innerHTML = `<span class="glyph">⚠</span><span class="body">${escapeHtml((ev.error && ev.error.message) || 'error')}</span>`;
  rec.body.appendChild(el);
  maybeScroll(true);
}

// ------------------------------------------------------------------ boot
$('clearFeed').addEventListener('click', () => {
  feed.innerHTML = '';
  state.turns.clear();
  state.tools.clear();
  state.turnNo = 0;
  state.active = null;
});

// Dev hook: ?replay=<same-origin jsonl url> renders a captured stream statically
// instead of connecting live. Inert in normal use.
const replay = new URLSearchParams(location.search).get('replay');
if (replay) {
  fetch(replay).then((r) => r.text()).then((txt) => {
    for (const line of txt.trim().split('\n')) { try { handleLive(JSON.parse(line)); } catch { /* skip */ } }
  });
} else {
  connect();
}
