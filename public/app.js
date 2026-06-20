'use strict';

/* CC·SCOPE dashboard — vanilla JS, no build step. */

const $ = (id) => document.getElementById(id);

const state = {
  sessions: [],
  currentId: null,
  detail: null,        // { summary, turns, timeline, toolCounts, repeats }
  pricing: null,
  wireCount: 0,
  es: null,
  wireCache: new Map(),
  renderQueued: false,
  daily: null,
  roi: null,
  errors: null,
  errFocus: { kind: null, key: null }, // {kind:'class'|'tool', key}
  feed: [],
  skills: null,
  skillFocus: null,
};

// ------------------------------------------------------------------ utils
const fmtInt = (n) => (n == null ? '—' : n.toLocaleString('en-US'));
const fmtTok = (n) => {
  if (n == null) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
};
const fmtDur = (ms) => {
  if (ms == null) return '—';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
  if (m < 60) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${(m % 60)}m`;
};
const fmtClock = (ts) => new Date(ts).toLocaleTimeString('en-US', { hour12: false });

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => { state.renderQueued = false; render(); });
}

// ------------------------------------------------------------------ data
async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function loadSessions() {
  state.sessions = await fetchJson('/api/sessions');
  renderPicker();
}

async function selectSession(id) {
  state.currentId = id;
  state.detail = await fetchJson('/api/session/' + encodeURIComponent(id));
  renderPicker();
  scheduleRender();
}

function connectSSE() {
  const es = new EventSource('/events');
  state.es = es;
  es.onopen = () => setConn('live', 'ok');
  es.onerror = () => setConn('reconnecting…', 'bad');
  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    handleEvent(ev);
  };
}

function setConn(text, cls) {
  const el = $('connState');
  el.textContent = text;
  el.className = 'conn ' + cls;
  $('liveDot').classList.toggle('live', cls === 'ok');
}

function upsertSession(summary) {
  const i = state.sessions.findIndex((s) => s.id === summary.id);
  if (i >= 0) state.sessions[i] = summary;
  else state.sessions.unshift(summary);
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'snapshot':
      state.sessions = ev.sessions;
      state.wireCount = ev.wireCount || 0;
      renderPicker();
      autoFollow();
      scheduleRender();
      break;
    case 'session':
      upsertSession(ev.session);
      renderPicker();
      autoFollow();
      break;
    case 'turn': {
      if (ev.sessionId !== state.currentId || !state.detail) { refreshSummaries(); break; }
      const turns = state.detail.turns;
      const i = turns.findIndex((t) => t.messageId === ev.turn.messageId);
      if (i >= 0) turns[i] = ev.turn;
      else turns.push(ev.turn);
      rebuildDerived(ev.turn);
      refreshSummaries();
      scheduleRender();
      break;
    }
    case 'user':
      if (ev.sessionId === state.currentId && state.detail) {
        state.detail.timeline.push({ kind: 'user', ts: ev.ts, preview: ev.preview });
        refreshSummaries();
        scheduleRender();
      } else refreshSummaries();
      break;
    case 'wire':
      state.wireCount++;
      $('wireCount').textContent = fmtInt(state.wireCount) + ' wire captures';
      break;
    case 'hook':
      state.feed.push(ev.ev);
      if (state.feed.length > 600) state.feed.shift();
      if (document.body.classList.contains('feed')) appendFeedRow(ev.ev);
      break;
  }
  refreshDailyMaybe();
}

// keep tool counts / repeats in sync with incoming turns (cheap recompute)
function rebuildDerived() {
  if (!state.detail) return;
  const counts = new Map();
  const repeats = new Map();
  for (const t of state.detail.turns) {
    for (const c of t.tools || []) {
      counts.set(c.name, (counts.get(c.name) || 0) + 1);
      const r = repeats.get(c.hash) || { name: c.name, count: 0, inputPreview: c.inputPreview };
      r.count++;
      repeats.set(c.hash, r);
    }
  }
  state.detail.toolCounts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  state.detail.repeats = [...repeats.values()].filter((r) => r.count >= 2).sort((a, b) => b.count - a.count).slice(0, 30);
}

// pull latest session summaries into the picker + banner without a full refetch
let summaryTimer = null;
function refreshSummaries() {
  if (summaryTimer) return;
  summaryTimer = setTimeout(async () => {
    summaryTimer = null;
    try {
      state.sessions = await fetchJson('/api/sessions');
      renderPicker();
      if (state.detail) {
        const s = state.sessions.find((x) => x.id === state.currentId);
        if (s) { state.detail.summary = s; scheduleRender(); }
      }
    } catch { /* server briefly busy */ }
  }, 700);
}

function autoFollow() {
  if (!$('followLive').checked || !state.sessions.length) return;
  const active = state.sessions.find((s) => s.active);
  if (active && active.id !== state.currentId) selectSession(active.id).catch(console.error);
}

// ------------------------------------------------------------------ picker
function renderPicker() {
  const sel = $('sessionPicker');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const s of state.sessions) {
    const opt = document.createElement('option');
    const dir = (s.cwd || '?').split(/[\\/]/).pop() || s.cwd;
    const when = s.firstTs ? new Date(s.firstTs).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '?';
    opt.value = s.id;
    opt.textContent = `${s.active ? '● ' : ''}${dir} · ${when} · ${s.turns} turns · ${s.id.slice(0, 8)}`;
    sel.appendChild(opt);
  }
  sel.value = state.currentId || prev || (state.sessions[0] && state.sessions[0].id) || '';
  renderGallery();
}

// ------------------------------------------------------------------ render
function render() {
  renderGallery();
  if (!state.detail) return;
  const sum = state.detail.summary;

  // autonomy banner
  $('streakNow').textContent = sum.autonomousTurns;
  $('streakMax').textContent = sum.maxAutonomousStreak;
  $('userInputs').textContent = sum.userInputs;
  $('subagents').textContent = sum.subagentSpawns;
  $('sidechain').textContent = sum.sidechainTurns;

  const topRepeat = (state.detail.repeats || [])[0];
  const repEl = $('repeatMax');
  if (topRepeat) {
    repEl.textContent = `${topRepeat.count}× ${topRepeat.name}`;
    repEl.classList.toggle('hot', topRepeat.count >= 5);
  } else { repEl.textContent = '—'; repEl.classList.remove('hot'); }

  const status = $('autonomyStatus');
  const streak = sum.autonomousTurns;
  if (!sum.active && streak === 0) { status.textContent = 'idle'; status.className = 'autonomy-status'; }
  else if (streak >= 25) { status.textContent = 'long autonomous run'; status.className = 'autonomy-status hot'; }
  else if (streak >= 8) { status.textContent = 'autonomous run'; status.className = 'autonomy-status warn'; }
  else { status.textContent = sum.active ? 'interactive' : 'idle'; status.className = 'autonomy-status'; }

  // metrics
  const totTools = (state.detail.toolCounts || []).reduce((a, t) => a + t.count, 0);
  $('mTurns').textContent = fmtInt(sum.turns);
  $('mTools').textContent = fmtInt(totTools);
  $('mDuration').textContent = sum.firstTs && sum.lastTs ? fmtDur(sum.lastTs - sum.firstTs) : '—';
  $('mIn').textContent = fmtTok(sum.usage.input);
  $('mOut').textContent = fmtTok(sum.usage.output);
  $('mCacheR').textContent = fmtTok(sum.usage.cacheRead);
  $('mCacheW').textContent = fmtTok(sum.usage.cacheWrite);
  const denom = sum.usage.input + sum.usage.cacheRead + sum.usage.cacheWrite;
  $('mHit').textContent = denom ? Math.round((sum.usage.cacheRead / denom) * 100) + '%' : '—';
  $('mCost').textContent = estimateCost(sum);

  renderToolBars();
  renderRepeats();
  renderTokenChart();
  $('wireCount').textContent = fmtInt(state.wireCount) + ' wire captures';
}

// USD for a {input,output,cacheRead,cacheWrite} usage object under a model id.
// Returns null when pricing is unknown so callers can show '—' / skip.
function costUsd(usage, model) {
  if (!state.pricing || !model || !usage) return null;
  const key = Object.keys(state.pricing).find((k) => model.startsWith(k));
  if (!key) return null;
  const p = state.pricing[key];
  return (usage.input * p.input + usage.output * p.output
    + usage.cacheWrite * p.cacheWrite + usage.cacheRead * p.cacheRead) / 1e6;
}

function estimateCost(sum) {
  const usd = costUsd(sum.usage, sum.model);
  return usd == null ? '—' : '$' + usd.toFixed(usd >= 10 ? 2 : 3);
}

function renderToolBars() {
  const counts = state.detail.toolCounts || [];
  const max = counts.length ? counts[0].count : 1;
  $('toolTotal').textContent = counts.length + ' distinct tools';
  $('toolBars').innerHTML = counts.slice(0, 25).map((t) => `
    <div class="tb">
      <span class="name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
      <span class="bar"><i style="width:${Math.max(2, (t.count / max) * 100)}%"></i></span>
      <span class="n">${t.count}</span>
    </div>`).join('');
}

// ------------------------------------------------------------------ account-wide usage
async function loadAccountUsage() {
  let data;
  try { data = await fetchJson('/api/account-usage?days=30'); }
  catch (e) { data = { configured: true, error: e.message }; }
  renderAccount(data);
}

function renderAccount(d) {
  const host = $('acct');
  const range = $('acctRange');
  if (!host) return;
  if (!d.configured) {
    range.textContent = 'not set up';
    host.innerHTML = `<div class="acct-setup">
      <p><b>Account-wide</b> usage from the Anthropic Console — separate from the local view below.</p>
      <p>Set <code>CCSCOPE_ADMIN_KEY</code> to an Admin API key (<code>sk-ant-admin…</code>) from console.anthropic.com → Settings → Admin keys, then restart the server.</p>
      <p class="muted">Reports <b>API organization</b> usage. A Claude.ai Pro/Max subscription is billed separately and isn't exposed by this API.</p>
    </div>`;
    return;
  }
  if (d.error) {
    range.textContent = 'error';
    const hint = (d.status === 401 || d.status === 403)
      ? ' — key rejected. Needs a Console Admin key with usage access; Claude Code subscription auth won\'t work here.'
      : '';
    host.innerHTML = `<div class="acct-setup"><p class="err">${escapeHtml(d.error)}${escapeHtml(hint)}</p></div>`;
    return;
  }
  range.textContent = `last ${d.days}d`;
  const max = d.byModel.length ? d.byModel[0].usd : 1;
  const bars = d.byModel.slice(0, 8).map((m) => `
    <div class="tb">
      <span class="name" title="${escapeHtml(m.key)}">${escapeHtml(m.key.replace('claude-', ''))}</span>
      <span class="bar"><i style="width:${Math.max(2, (m.usd / max) * 100)}%"></i></span>
      <span class="n">$${m.usd.toFixed(2)}</span>
    </div>`).join('');
  host.innerHTML = `
    <div class="acct-total"><span class="v">$${d.totalUsd.toFixed(2)}</span><span class="k">total · ${d.days} days · all Console usage</span></div>
    <div class="acct-bars">${bars || '<div class="none">no usage in range</div>'}</div>`;
}

function renderRepeats() {
  const reps = state.detail.repeats || [];
  $('repeats').innerHTML = reps.length
    ? reps.map((r) => `
      <div class="rep ${r.count >= 5 ? 'hot' : ''}">
        <span class="count">${r.count}×</span>
        <span class="what"><b>${escapeHtml(r.name)}</b> ${escapeHtml(r.inputPreview || '')}</span>
      </div>`).join('')
    : '<div class="none">no identical tool calls repeated — no loop signature</div>';
}

// ------------------------------------------------------------------ session gallery
const BAR_COLORS = { t: '#ffb000', e: '#7dd87d', s: '#57c7d4', x: '#ff8c2b', r: '#ff5c45', o: '#978f74' };
const BAR_LABEL = { t: 'tool call', e: 'answer', s: 'sub-agent', x: 'tool error', r: 'api error', o: 'other' };
const GROUPS = [
  { key: 'marathon', title: 'MARATHON', sub: 'long sessions' },
  { key: 'autonomous', title: 'AUTONOMOUS', sub: 'long unbroken chains — loop-watch tier' },
  { key: 'mixed', title: 'MIXED WORK', sub: 'human-guided, alternating chains' },
  { key: 'quick', title: 'QUICK', sub: 'short sessions' },
];

function classify(s) {
  if (s.turns >= 60) return 'marathon';
  if ((s.maxAutonomousStreak || 0) >= 15) return 'autonomous';
  if (s.userInputs >= 3) return 'mixed';
  return 'quick';
}

function galleryCost(s) {
  const usd = costUsd(s.usage, s.model);
  return usd == null ? '' : '$' + usd.toFixed(usd >= 1 ? 2 : 3);
}

function renderGallery() {
  const host = $('gallery');
  if (!host) return;
  const scroll = host.scrollTop;
  const sessions = state.sessions || [];
  if (!sessions.length) { host.innerHTML = '<div class="gal-empty">no sessions yet — run Claude Code (any session shows here; run via ccspy for wire detail)</div>'; return; }

  const groups = {};
  for (const s of sessions) { const k = classify(s); (groups[k] = groups[k] || []).push(s); }

  let html = '';
  for (const g of GROUPS) {
    const list = groups[g.key];
    if (!list || !list.length) continue;
    const maxChain = Math.max(0, ...list.map((s) => s.maxAutonomousStreak || 0));
    const extra = (g.key === 'autonomous' || g.key === 'marathon') ? ` · max chain ${maxChain}` : '';
    html += `<div class="gal-group-head">${g.title}<span> · ${list.length} session${list.length > 1 ? 's' : ''} · ${g.sub}${extra}</span></div>`;
    html += '<div class="gal-grid">' + list.map(card).join('') + '</div>';
  }
  host.innerHTML = html;
  for (const cv of host.querySelectorAll('canvas.bars')) drawBars(cv);
  host.scrollTop = scroll;
}

function card(s) {
  const dir = (s.cwd || '?').split(/[\\/]/).pop() || s.cwd || '?';
  const when = s.firstTs ? new Date(s.firstTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const cost = galleryCost(s);
  const sel = s.id === state.currentId ? ' sel' : '';
  const model = (s.model || '').replace('claude-', '').replace(/-\d{8}$/, '');
  const pill = s.active ? '<span class="pill live">live</span>' : `<span class="pill">${escapeHtml(model || '?')}</span>`;
  return `<div class="scard${sel}" data-id="${escapeHtml(s.id)}">
    <canvas class="bars" data-bars="${escapeHtml(s.bars || '')}"></canvas>
    <div class="scard-label"><span class="dir">${escapeHtml(dir)}</span> <span class="msg">${escapeHtml(s.firstUser || '')}</span></div>
    <div class="scard-meta"><span class="mleft">${s.turns} turns · chain ${s.maxAutonomousStreak || 0}${cost ? ` · ${cost}` : ''}${when ? ` · ${when}` : ''}</span>${pill}</div>
  </div>`;
}

function drawBars(cv) {
  const bars = cv.dataset.bars || '';
  const cssW = Math.max(40, cv.parentElement.clientWidth);
  const cssH = 30;
  const dpr = window.devicePixelRatio || 1;
  cv.width = cssW * dpr; cv.height = cssH * dpr;
  cv.style.width = '100%'; cv.style.height = cssH + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (!bars.length) return;
  const bw = cssW / bars.length;
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i];
    const x = i * bw;
    if (c === '|') { // human input — dark gap + faint tick
      ctx.fillStyle = '#0b0a08'; ctx.fillRect(x, 0, Math.max(1, bw), cssH);
      ctx.fillStyle = 'rgba(232,224,201,0.55)'; ctx.fillRect(x, 0, Math.min(bw, 2), cssH);
      continue;
    }
    ctx.fillStyle = BAR_COLORS[c] || BAR_COLORS.o;
    ctx.fillRect(x, 0, Math.max(0.6, bw - 0.3), cssH);
  }
}

function barAt(cv, e) {
  const bars = cv.dataset.bars || '';
  if (!bars.length) return null;
  const rect = cv.getBoundingClientRect();
  const i = Math.floor(((e.clientX - rect.left) / rect.width) * bars.length);
  if (i < 0 || i >= bars.length) return null;
  let turnIdx = 0;
  for (let k = 0; k < i; k++) if (bars[k] !== '|') turnIdx++;
  return { i, char: bars[i], turnIdx };
}

function bindGallery() {
  const host = $('gallery');
  const tip = $('galTip');
  host.addEventListener('mousemove', (e) => {
    const cv = e.target.closest && e.target.closest('canvas.bars');
    if (!cv) { tip.hidden = true; return; }
    const hit = barAt(cv, e);
    if (!hit) { tip.hidden = true; return; }
    tip.hidden = false;
    const r = host.getBoundingClientRect();
    tip.style.left = Math.min(e.clientX - r.left + 14, r.width - 200) + 'px';
    tip.style.top = (e.clientY - r.top + 12) + 'px';
    tip.textContent = hit.char === '|' ? 'human input' : `turn ${hit.turnIdx + 1} · ${BAR_LABEL[hit.char] || 'turn'}`;
  });
  host.addEventListener('mouseleave', () => { tip.hidden = true; });
  host.addEventListener('click', async (e) => {
    const cardEl = e.target.closest && e.target.closest('.scard');
    if (!cardEl) return;
    const id = cardEl.dataset.id;
    $('followLive').checked = false; // manual pick — stop yanking to the live session
    const cv = e.target.closest('canvas.bars');
    const hit = cv ? barAt(cv, e) : null;
    await selectSession(id);
    if (hit && hit.char !== '|' && state.detail && state.detail.turns[hit.turnIdx]) {
      openInspector(state.detail.turns[hit.turnIdx]);
    }
  });
}

// ------------------------------------------------------------------ token chart
function renderTokenChart() {
  const canvas = $('tokenChart');
  const turns = state.detail.turns.slice(-120);
  const cssW = canvas.parentElement.clientWidth - 28;
  const cssH = 120;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  canvas.style.margin = '10px 14px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (!turns.length) return;
  const maxOut = Math.max(...turns.map((t) => (t.usage ? t.usage.output_tokens || 0 : 0)), 1);
  const bw = Math.max(2, cssW / turns.length - 1);
  turns.forEach((t, i) => {
    const out = t.usage ? t.usage.output_tokens || 0 : 0;
    const h = (out / maxOut) * (cssH - 16);
    ctx.fillStyle = t.isSidechain ? '#57c7d4' : '#ffb000';
    ctx.fillRect(i * (bw + 1), cssH - h, bw, h);
  });
  ctx.fillStyle = '#5d5742';
  ctx.font = '10px "Spline Sans Mono"';
  ctx.fillText(`output tokens / turn · peak ${fmtTok(maxOut)}`, 2, 10);
}

// ------------------------------------------------------------------ daily roll-up
function setView(view) {
  for (const v of ['daily', 'roi', 'errors', 'feed', 'skills']) document.body.classList.toggle(v, view === v);
  for (const b of document.querySelectorAll('#viewtabs button')) b.classList.toggle('on', b.dataset.view === view);
  if (view === 'daily') loadDaily().catch(console.error);
  if (view === 'roi') loadRoi().catch(console.error);
  if (view === 'errors') loadErrors().catch(console.error);
  if (view === 'feed') { loadLiveFeed().catch(console.error); renderFeed(); }
  if (view === 'skills') loadSkills().catch(console.error);
}

let dailyTimer = null;
function refreshDailyMaybe() {
  if (dailyTimer) return;
  const b = document.body.classList;
  if (!b.contains('daily') && !b.contains('roi') && !b.contains('errors')) return;
  dailyTimer = setTimeout(() => {
    dailyTimer = null;
    if (document.body.classList.contains('daily')) loadDaily().catch(() => {});
    if (document.body.classList.contains('roi')) loadRoi().catch(() => {});
    if (document.body.classList.contains('errors')) loadErrors().catch(() => {});
  }, 1500);
}

async function loadDaily() {
  state.daily = await fetchJson('/api/daily');
  renderDaily(state.daily);
}

// day cost = sum of its per-model costs (null only if nothing priced)
function dayCost(day) {
  let usd = 0, priced = false;
  for (const m of day.models || []) {
    const c = costUsd(m.usage, m.model);
    if (c != null) { usd += c; priced = true; }
  }
  return priced ? usd : null;
}

function renderDaily(d) {
  const days = d.days || [];
  const t = d.totals || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };

  let totCost = 0, anyPriced = false;
  for (const day of days) { const c = dayCost(day); if (c != null) { totCost += c; anyPriced = true; } }
  $('dTotCost').textContent = anyPriced ? '$' + totCost.toFixed(2) : '—';
  $('dTotIn').textContent = fmtTok(t.input);
  $('dTotOut').textContent = fmtTok(t.output);
  $('dTotCacheR').textContent = fmtTok(t.cacheRead);
  $('dTotCacheW').textContent = fmtTok(t.cacheWrite);
  $('dTotTurns').textContent = fmtInt(t.turns);
  $('dTotSessions').textContent = fmtInt(d.sessionCount);
  $('dTotDays').textContent = fmtInt(days.length);
  $('dailyRange').textContent = days.length ? `${days[days.length - 1].day} → ${days[0].day}` : '';

  // day table (newest first), thin amber fill behind cost ~ relative spend
  const costs = days.map(dayCost).filter((c) => c != null);
  const maxCost = costs.length ? Math.max(...costs) : 1;
  const rows = days.map((day) => {
    const c = dayCost(day);
    const pct = c != null && maxCost ? Math.max(2, (c / maxCost) * 100) : 0;
    const wd = new Date(day.day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
    return `<tr>
      <td class="day">${day.day}<span class="wd">${wd}</span></td>
      <td class="num">${fmtInt(day.sessions)}</td>
      <td class="num">${fmtInt(day.turns)}</td>
      <td class="num">${fmtTok(day.usage.input)}</td>
      <td class="num strong">${fmtTok(day.usage.output)}</td>
      <td class="num dim">${fmtTok(day.usage.cacheRead)}</td>
      <td class="num dim">${fmtTok(day.usage.cacheWrite)}</td>
      <td class="num cost" style="--p:${pct}%">${c != null ? '$' + c.toFixed(c >= 10 ? 2 : 3) : '—'}</td>
    </tr>`;
  }).join('');
  $('dailyTable').innerHTML = days.length ? `<table>
    <thead><tr>
      <th>day</th><th class="num">sess</th><th class="num">turns</th>
      <th class="num">in</th><th class="num">out</th>
      <th class="num">cache r</th><th class="num">cache w</th><th class="num">cost</th>
    </tr></thead>
    <tbody>${rows}</tbody></table>` : '<div class="none">no local sessions yet</div>';

  // by-model breakdown over the whole range
  const bm = (d.byModel || []).map((m) => ({ model: m.model, usd: costUsd(m.usage, m.model) }));
  const maxUsd = Math.max(1e-6, ...bm.map((m) => m.usd || 0));
  $('dailyByModel').innerHTML = bm.length ? bm.map((m) => {
    const label = (m.model || 'unknown').replace('claude-', '').replace(/-\d{8}$/, '');
    return `<div class="tb">
      <span class="name" title="${escapeHtml(m.model || '')}">${escapeHtml(label)}</span>
      <span class="bar"><i style="width:${Math.max(2, ((m.usd || 0) / maxUsd) * 100)}%"></i></span>
      <span class="n">${m.usd != null ? '$' + m.usd.toFixed(2) : '—'}</span>
    </div>`;
  }).join('') : '<div class="none">no data</div>';

  drawDailyChart(days);
}

function drawDailyChart(daysDesc) {
  const canvas = $('dailyChart');
  if (!canvas) return;
  const days = [...(daysDesc || [])].reverse(); // oldest → newest
  const cssW = Math.max(120, (canvas.parentElement.clientWidth || 600) - 28);
  const cssH = 140;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  canvas.style.margin = '10px 14px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (!days.length) return;
  const vals = days.map((d) => { const c = dayCost(d); return c == null ? 0 : c; });
  const maxV = Math.max(...vals, 1e-6);
  const n = days.length;
  const slot = cssW / n;
  const bw = Math.max(1.5, slot - 1);
  days.forEach((day, i) => {
    const h = (vals[i] / maxV) * (cssH - 24);
    ctx.fillStyle = '#ffb000';
    ctx.fillRect(i * slot, cssH - h - 14, bw, h);
  });
  ctx.fillStyle = '#5d5742';
  ctx.font = '10px "Spline Sans Mono"';
  ctx.fillText(`cost / day · peak $${maxV >= 1 ? maxV.toFixed(2) : maxV.toFixed(3)}`, 2, 10);
}

// ------------------------------------------------------------------ roi / leverage
const ROI_DEFAULTS = { rate: 250, minPerEdit: 4, minPerCommand: 1, minPerAsk: 5 };

function roiKnobs() {
  try { return { ...ROI_DEFAULTS, ...JSON.parse(localStorage.getItem('ccscope.roi.knobs') || '{}') }; }
  catch { return { ...ROI_DEFAULTS }; }
}
function saveKnobs(k) { localStorage.setItem('ccscope.roi.knobs', JSON.stringify(k)); }
function roiRatings() {
  try { return JSON.parse(localStorage.getItem('ccscope.roi.ratings') || '{}'); }
  catch { return {}; }
}
function saveRatings(r) { localStorage.setItem('ccscope.roi.ratings', JSON.stringify(r)); }

function heuristicHours(s, k) {
  return (s.edits * k.minPerEdit + s.commands * k.minPerCommand + s.userInputs * k.minPerAsk) / 60;
}
function sessionHours(s, k, ratings) {
  const r = ratings[s.id];
  return (r && typeof r.hours === 'number') ? r.hours : heuristicHours(s, k);
}
function isRated(s, ratings) {
  const r = ratings[s.id];
  return !!(r && typeof r.hours === 'number');
}
// session cost priced per-model (matches the daily roll-up)
function roiSessionCost(s) {
  if (Array.isArray(s.usageByModel) && s.usageByModel.length) {
    let usd = 0;
    for (const m of s.usageByModel) { const c = costUsd(m.usage, m.model); if (c) usd += c; }
    return usd;
  }
  return costUsd(s.usage, s.model) || 0;
}
const fmtHrs = (h) => (h >= 100 ? Math.round(h).toLocaleString() : h.toFixed(1)) + 'h';
const fmtUsd0 = (v) => '$' + Math.round(v).toLocaleString();

async function loadRoi() {
  state.roi = await fetchJson('/api/roi');
  renderRoi();
}

function renderRoi() {
  if (!state.roi) return;
  const k = roiKnobs();
  const ratings = roiRatings();
  const sessions = state.roi.sessions || [];

  // reflect knobs into the inputs (without clobbering one being edited)
  const ae = document.activeElement;
  const set = (id, v) => { const el = $(id); if (el && el !== ae) el.value = v; };
  set('roiRate', k.rate); set('roiEdit', k.minPerEdit); set('roiCmd', k.minPerCommand); set('roiAsk', k.minPerAsk);

  let totHours = 0, totCost = 0, rated = 0;
  for (const s of sessions) {
    totHours += sessionHours(s, k, ratings);
    const c = roiSessionCost(s); totCost += c;
    if (isRated(s, ratings)) rated++;
  }
  const value = totHours * k.rate;
  const t = state.roi.totals || { edits: 0, commands: 0 };

  $('roiHours').textContent = fmtHrs(totHours);
  $('roiValue').textContent = fmtUsd0(value);
  $('roiMult').textContent = totCost > 0 ? (value / totCost).toFixed(1) + '×' : '—';
  $('roiNet').textContent = fmtUsd0(value - totCost);
  $('roiOutput').textContent = fmtInt(t.edits) + ' / ' + fmtInt(t.commands);
  $('roiCostRef').textContent = '$' + totCost.toFixed(2);
  $('roiSrc').textContent = `${rated} rated · ${sessions.length - rated} auto-estimated · ${t.days || 0}d`;

  // by project (computed client-side so manual overrides flow through)
  const pm = new Map();
  for (const s of sessions) {
    let p = pm.get(s.project);
    if (!p) { p = { project: s.project, sessions: 0, asks: 0, edits: 0, commands: 0, subagents: 0, cost: 0, hours: 0 }; pm.set(s.project, p); }
    p.sessions++; p.asks += s.userInputs; p.edits += s.edits; p.commands += s.commands; p.subagents += s.subagents;
    const c = roiSessionCost(s); p.cost += c;
    p.hours += sessionHours(s, k, ratings);
  }
  const projects = [...pm.values()].sort((a, b) => b.hours - a.hours);
  const projRows = projects.map((p) => {
    const v = p.hours * k.rate;
    return `<tr>
      <td class="proj">${escapeHtml(p.project)}</td>
      <td class="num">${fmtInt(p.sessions)}</td>
      <td class="num">${fmtInt(p.asks)}</td>
      <td class="num">${fmtInt(p.edits)}</td>
      <td class="num">${fmtInt(p.commands)}</td>
      <td class="num faint">$${p.cost.toFixed(2)}</td>
      <td class="num">${fmtHrs(p.hours)}</td>
      <td class="num val">${fmtUsd0(v)}</td>
      <td class="num cost" style="--p:${totCost ? Math.max(2, (p.cost / Math.max(...projects.map((x) => x.cost), 1)) * 100) : 0}%">${p.cost > 0 ? (v / p.cost).toFixed(1) + '×' : '—'}</td>
    </tr>`;
  }).join('');
  $('roiProjects').innerHTML = projects.length ? `<table>
    <thead><tr><th>project</th><th class="num">sess</th><th class="num">asks</th><th class="num">edits</th><th class="num">cmds</th><th class="num">cost</th><th class="num">hours</th><th class="num">value</th><th class="num">roi×</th></tr></thead>
    <tbody>${projRows}</tbody></table>` : '<div class="none">no sessions</div>';

  // sessions — biggest cost first (most worth rating); inline hours override
  const byCost = [...sessions].sort((a, b) => roiSessionCost(b) - roiSessionCost(a));
  const sessRows = byCost.map((s) => {
    const c = roiSessionCost(s);
    const est = heuristicHours(s, k);
    const r = ratings[s.id];
    const hrsVal = (r && typeof r.hours === 'number') ? r.hours : '';
    const v = sessionHours(s, k, ratings) * k.rate;
    return `<tr class="${isRated(s, ratings) ? 'rated' : ''}">
      <td class="proj">${escapeHtml(s.project)}</td>
      <td class="msg" title="${escapeHtml(s.firstUser || '')}">${escapeHtml(s.firstUser || '—')}</td>
      <td class="num">${fmtInt(s.turns)}</td>
      <td class="num">${fmtInt(s.edits)}</td>
      <td class="num">${fmtInt(s.commands)}</td>
      <td class="num faint">$${c.toFixed(2)}</td>
      <td class="num"><input class="roi-hrs" data-id="${escapeHtml(s.id)}" type="number" min="0" step="0.5" value="${hrsVal}" placeholder="${est.toFixed(1)}"></td>
      <td class="num val">${fmtUsd0(v)}</td>
    </tr>`;
  }).join('');
  $('roiSessions').innerHTML = sessions.length ? `<table>
    <thead><tr><th>project</th><th>first ask</th><th class="num">turns</th><th class="num">edits</th><th class="num">cmds</th><th class="num">cost</th><th class="num">hours</th><th class="num">value</th></tr></thead>
    <tbody>${sessRows}</tbody></table>` : '<div class="none">no sessions</div>';
}

function bindRoi() {
  const onKnob = () => {
    const k = roiKnobs();
    k.rate = Math.max(0, Number($('roiRate').value) || 0);
    k.minPerEdit = Math.max(0, Number($('roiEdit').value) || 0);
    k.minPerCommand = Math.max(0, Number($('roiCmd').value) || 0);
    k.minPerAsk = Math.max(0, Number($('roiAsk').value) || 0);
    saveKnobs(k);
    renderRoi();
  };
  for (const id of ['roiRate', 'roiEdit', 'roiCmd', 'roiAsk']) $(id).addEventListener('input', onKnob);
  $('roiReset').addEventListener('click', () => {
    localStorage.removeItem('ccscope.roi.knobs');
    localStorage.removeItem('ccscope.roi.ratings');
    renderRoi();
  });
  // delegate manual hours overrides on the sessions table
  $('roiSessions').addEventListener('change', (e) => {
    const input = e.target.closest && e.target.closest('input.roi-hrs');
    if (!input) return;
    const ratings = roiRatings();
    const id = input.dataset.id;
    const val = input.value.trim();
    if (val === '') delete ratings[id];
    else ratings[id] = { hours: Math.max(0, Number(val) || 0) };
    saveRatings(ratings);
    renderRoi();
  });
}

// ------------------------------------------------------------------ flounder view
// Per-class colour + the "discipline" guidance shown in the detail panel. This is
// the bridge from measurement to architecture: each class names a fix you could
// ship as a skill rule, a typed-status wrapper, or an MCP tool.
const ERR_CLASSES = {
  expected_empty:    { color: '#7dd87d', what: 'A search returned nothing and the agent treated it like a failure — re-running or changing tack instead of accepting "none".', why: 'Empty ≠ error. The tool gave a valid empty result; the agent can\'t tell it apart from a real failure.', fix: 'Wrapper returns a typed <b>expected_empty</b> status; skill rule: "no matches is a valid answer, do not retry."' },
  user_rejected:     { color: '#7dd87d', what: 'A human declined the tool use. <b>Not floundering</b> — counted here only because it surfaces as an error result.', why: 'You said no (permission prompt, plan rejection). Working as intended.', fix: 'Nothing to fix. Useful as a denominator caveat: subtract these from the "real" error rate.' },
  stale_edit:        { color: '#ff8c2b', what: 'An Edit/Write failed its precondition — file not read first, or the match string no longer matches.', why: 'Pure agent discipline: edited before reading, or against a stale view of the file.', fix: 'Skill rule: "always Read before Edit; re-read after any external change." The single cheapest discipline win.' },
  unknown_tool:      { color: '#ff5c45', what: 'The agent called a tool that doesn\'t exist or isn\'t registered/loaded.', why: 'Invented a tool name, or an MCP tool exists without a tier/registration entry.', fix: 'Register the tool with its server/tier so it resolves; skill rule: search for the tool before invoking it.' },
  mcp_auth:          { color: '#ff5c45', what: 'An MCP server rejected the call — token expired / needs re-authorization.', why: 'Auth lifecycle, not the agent. But blind retries against an expired token burn tokens.', fix: 'Centralize auth in a relay/gateway so refresh is handled once, off the agent\'s path.' },
  mcp_transport:     { color: '#ff5c45', what: 'MCP transport failure — HTTP POST to the server errored, or a stale handle (e.g. a closed browser tab).', why: 'Server/network/handle problem outside the model.', fix: 'Relay with retries + a typed status; skill rule: refresh the handle (tabs_context) before reuse.' },
  connect_error:     { color: '#b07a00', what: 'Could not reach an endpoint — server down or unreachable.', why: 'Upstream availability, not the agent.', fix: 'Health-check before the run; typed <b>blocked_missing_dependency</b> status so the agent stops, not spins.' },
  binary_file:       { color: '#b07a00', what: 'Tried to read a binary file (e.g. .docx/.pdf) with a text tool.', why: 'Agent assumed text; the file is binary.', fix: 'Skill rule: route .docx/.pdf/binary through the right extractor; wrapper that picks the tool by extension.' },
  shell_failure:     { color: '#ff8c2b', what: 'A raw shell command failed — bad syntax, wrong cwd, command not found, non-zero exit.', why: 'Agent invented a command shape or assumed repo/cwd state it never checked.', fix: 'Preflight cwd/repo state; <b>repo_*</b> wrappers with one canonical command shape. Promote the worst offenders to MCP.' },
  aws_format:        { color: '#ff5c45', what: 'An AWS CLI call was malformed — bad flags, missing profile/region, expired creds, wrong service syntax.', why: 'Raw `aws ...` through Bash is high-variance; the agent guesses option names and auth.', fix: 'An <b>aws_ssm_run</b> / typed AWS tool that handles auth + flags. This is the poster child for an MCP tool.' },
  brain_validation:  { color: '#57c7d4', what: 'A capture/ingest tool rejected the payload on validation.', why: 'Payload didn\'t match the capture schema; the agent built it by hand.', fix: 'A <b>brain_capture_validate</b> wrapper that shapes + validates before sending, returning a typed status.' },
  webfetch_miss:     { color: '#b07a00', what: 'A web fetch/search failed or came back empty — unreachable, blocked, rate-limited, or no results.', why: 'Often the open internet, not the agent — but blind retries burn tokens.', fix: 'Wrapper distinguishes transient (retry-once) from terminal (give up). Skill rule: cap fetch retries.' },
  file_not_found:    { color: '#ff8c2b', what: 'A path didn\'t exist — ENOENT, wrong relative path, stale location.', why: 'Agent assumed a file/dir without confirming it from a search or listing first.', fix: 'Preflight with a search/glob before read/edit; skill rule: never assume a path.' },
  permission_denied: { color: '#ff5c45', what: 'An operation was blocked — permission denied, EACCES, denied by policy/sandbox.', why: 'Agent attempted a privileged or out-of-scope action.', fix: 'Scope tools/permissions up front; surface the block as a typed <b>blocked</b> status, not a retry.' },
  validation:        { color: '#ff5c45', what: 'A tool rejected its input — schema/argument validation, missing required field.', why: 'Arguments were malformed or a required parameter was omitted.', fix: 'Typed wrappers with validated params; the contract lives in code, not in the prompt.' },
  timeout:           { color: '#b07a00', what: 'A call timed out.', why: 'Slow upstream, oversized operation, or a hung command.', fix: 'Bounded timeouts + a typed <b>timeout</b> status so the agent backs off deliberately.' },
  real_error:        { color: '#ff5c45', what: 'A genuine error that doesn\'t fit the other buckets.', why: 'Mixed bag — inspect the previews to see if a new class is hiding here.', fix: 'Read the samples; if a pattern repeats, give it its own class + fix.' },
};
function clsMeta(c) { return ERR_CLASSES[c] || { color: '#978f74', what: c, why: '—', fix: '—' }; }

async function loadErrors() {
  state.errors = await fetchJson('/api/errors');
  renderErrors();
}

function renderErrors() {
  const d = state.errors;
  if (!d) return;
  const pct = (r) => (r * 100).toFixed(r >= 0.1 ? 0 : 1) + '%';
  $('eRate').textContent = d.totalCalls ? pct(d.errorRate) : '—';
  $('eErrored').textContent = fmtInt(d.erroredCalls);
  $('eTotal').textContent = fmtInt(d.totalCalls);
  $('eBurn').textContent = fmtTok(d.tokensOnErroredTurns);
  $('eTop').textContent = d.classes.length ? d.classes[0].cls : '—';
  $('eSpirals').textContent = fmtInt(d.spirals.length);
  $('eEmpty').textContent = fmtInt(d.expectedEmpty);

  // tool index — by error count; click to focus
  const maxErr = Math.max(1, ...d.tools.map((t) => t.errors));
  $('eTools').innerHTML = d.tools.slice(0, 40).map((t) => {
    const sel = state.errFocus.kind === 'tool' && state.errFocus.key === t.tool ? ' sel' : '';
    const clean = t.errors === 0 ? ' clean' : '';
    return `<div class="ob-tool${sel}${clean}" data-tool="${escapeHtml(t.tool)}">
      <span class="tname" title="${escapeHtml(t.tool)}">${escapeHtml(t.tool)}</span>
      <span><span class="terr">${t.errors}</span><span class="trate">${t.total ? Math.round((t.errors / t.total) * 100) : 0}% of ${t.total}</span></span>
    </div>`;
  }).join('') || '<div class="none">no tool calls yet</div>';

  // failure-class cards
  const maxCls = Math.max(1, ...d.classes.map((c) => c.count));
  $('eClasses').innerHTML = d.classes.map((c) => {
    const m = clsMeta(c.cls);
    const sel = state.errFocus.kind === 'class' && state.errFocus.key === c.cls ? ' sel' : '';
    const share = d.erroredCalls ? Math.round((c.count / d.erroredCalls) * 100) : 0;
    return `<div class="ob-card${sel}" data-class="${escapeHtml(c.cls)}" style="--cls:${m.color}">
      <div class="cname">${escapeHtml(c.cls)}</div>
      <div class="ccount">${c.count}</div>
      <div class="cmeta">${share}% of failures</div>
      <div class="cbar"><i style="width:${Math.max(4, (c.count / maxCls) * 100)}%"></i></div>
    </div>`;
  }).join('') || '<div class="none">no failures recorded — clean run</div>';

  // retry spirals
  $('eSpiralList').innerHTML = d.spirals.length ? d.spirals.map((s) => `
    <div class="ob-spiral">
      <span class="scount">${s.count}×</span>
      <span class="sname">${escapeHtml(s.name)}</span>
      <span class="sclass">${escapeHtml(s.errorClass)}</span>
      <span class="sin" title="${escapeHtml(s.inputPreview || '')}">${escapeHtml(s.inputPreview || '')}</span>
    </div>`).join('') : '<div class="none">no identical call errored twice — no retry-loop signature</div>';

  renderErrTrend(d.daily || []);
  renderErrDetail();
}

// 7-day error rate vs the prior 7 days — the "did the skill help" readout.
function renderErrTrend(daily) {
  const sum = (arr) => arr.reduce((a, x) => ({ e: a.e + x.errored, t: a.t + x.total }), { e: 0, t: 0 });
  const last7 = daily.slice(-7);
  const prior7 = daily.slice(-14, -7);
  const r7 = sum(last7), rp = sum(prior7);
  const cur = r7.t ? r7.e / r7.t : 0;
  const prev = rp.t ? rp.e / rp.t : 0;
  const el = $('eTrendDelta');
  if (!last7.length) { el.textContent = 'no data yet'; el.className = 'sub'; }
  else if (!prior7.length) { el.textContent = `last 7d: ${(cur * 100).toFixed(1)}%`; el.className = 'sub'; }
  else {
    const d = cur - prev;
    const arrow = d < -0.001 ? '▼' : d > 0.001 ? '▲' : '▬';
    el.innerHTML = `7d <b>${(cur * 100).toFixed(1)}%</b> vs prior ${(prev * 100).toFixed(1)}% <span style="color:${d <= 0 ? 'var(--green)' : 'var(--orange)'}">${arrow} ${(Math.abs(d) * 100).toFixed(1)}pt</span>`;
    el.className = 'sub';
  }
  drawErrTrend(daily.slice(-45));
}

function drawErrTrend(days) {
  const canvas = $('errTrend');
  if (!canvas) return;
  const cssW = Math.max(120, (canvas.parentElement.clientWidth || 600) - 28);
  const cssH = 120;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  canvas.style.margin = '10px 14px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (!days.length) { ctx.fillStyle = '#5d5742'; ctx.font = '10px "Spline Sans Mono"'; ctx.fillText('no data', 2, 14); return; }
  const rates = days.map((d) => d.rate || 0);
  const maxR = Math.max(...rates, 0.01);
  const tot = days.reduce((a, d) => ({ e: a.e + d.errored, t: a.t + d.total }), { e: 0, t: 0 });
  const mean = tot.t ? tot.e / tot.t : 0;
  const n = days.length, slot = cssW / n, bw = Math.max(1.5, slot - 1.5);
  days.forEach((d, i) => {
    const h = (d.rate / maxR) * (cssH - 24);
    ctx.fillStyle = d.rate > mean * 1.25 ? '#ff8c2b' : '#b07a00';
    ctx.fillRect(i * slot, cssH - h - 14, bw, h);
  });
  // mean line
  const my = cssH - 14 - (mean / maxR) * (cssH - 24);
  ctx.strokeStyle = '#ffb000'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(0, my); ctx.lineTo(cssW, my); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#5d5742'; ctx.font = '10px "Spline Sans Mono"';
  ctx.fillText(`daily error rate · peak ${(maxR * 100).toFixed(1)}% · mean ${(mean * 100).toFixed(1)}%`, 2, 10);
}

function renderErrDetail() {
  const d = state.errors;
  if (!d) return;
  const f = state.errFocus;
  let samples = d.samples;
  let title = 'recent failures · all';
  let meta = null;
  if (f.kind === 'class') { samples = samples.filter((s) => s.errorClass === f.key); title = `failure class · ${f.key}`; meta = clsMeta(f.key); }
  else if (f.kind === 'tool') { samples = samples.filter((s) => s.tool === f.key); title = `tool · ${f.key}`; }
  $('eDetailTitle').textContent = title;

  if (meta) {
    $('eDetailWhat').innerHTML = meta.what;
    $('eDetailWhy').innerHTML = meta.why;
    $('eDetailFix').innerHTML = meta.fix;
  } else {
    $('eDetailWhat').innerHTML = 'Click a <b>failure class</b> card to see what it is, the likely cause, and the discipline fix.';
    $('eDetailWhy').innerHTML = 'Or click a <b>tool</b> in the index to see only its failures.';
    $('eDetailFix').innerHTML = 'The fixes map to the four layers: skill rule, typed wrapper, MCP tool, or relay.';
  }

  $('eSamples').innerHTML = samples.length ? samples.slice(0, 60).map((s) => {
    const m = clsMeta(s.errorClass);
    return `<div class="ob-sample" style="border-left-color:${m.color}">
      <div class="sh"><span class="stool">${escapeHtml(s.tool)}</span><span class="scls">${escapeHtml(s.errorClass)}</span><span class="sproj">${escapeHtml(s.project)} · ${fmtClock(s.ts)}</span></div>
      ${s.inputPreview ? `<div class="sin">↳ ${escapeHtml(s.inputPreview)}</div>` : ''}
      <div class="sbody">${escapeHtml(s.preview || '(no preview captured)')}</div>
    </div>`;
  }).join('') : '<div class="none">no samples for this focus</div>';
}

function bindErrors() {
  $('eTools').addEventListener('click', (e) => {
    const el = e.target.closest('.ob-tool'); if (!el) return;
    const tool = el.dataset.tool;
    state.errFocus = (state.errFocus.kind === 'tool' && state.errFocus.key === tool) ? { kind: null, key: null } : { kind: 'tool', key: tool };
    renderErrors();
  });
  $('eClasses').addEventListener('click', (e) => {
    const el = e.target.closest('.ob-card'); if (!el) return;
    const cls = el.dataset.class;
    state.errFocus = (state.errFocus.kind === 'class' && state.errFocus.key === cls) ? { kind: null, key: null } : { kind: 'class', key: cls };
    renderErrors();
  });
}

// ------------------------------------------------------------------ live feed (hook-fed)
async function loadLiveFeed() {
  try { state.feed = await fetchJson('/api/livefeed'); } catch { /* server briefly busy */ }
  renderFeed();
}

const FEED_GLYPH = { tool: '🔧', prompt: '👤', stop: '⏹', subagent_stop: '◧', notification: '🔔' };
function feedRowHtml(ev) {
  const g = FEED_GLYPH[ev.kind] || '·';
  const err = ev.kind === 'tool' && ev.isError ? ' err' : '';
  let main;
  if (ev.kind === 'tool') {
    main = `<span class="ftool">${escapeHtml(ev.tool || '?')}</span> <span class="fin">${escapeHtml(ev.inputPreview || '')}</span>${ev.isError ? `<span class="fcls">${escapeHtml(ev.errorClass || 'error')}</span>` : ''}`;
  } else if (ev.kind === 'prompt') {
    main = `<span class="fprompt">▸ ${escapeHtml(ev.text || '')}</span>`;
  } else {
    main = `<span class="ftext">${escapeHtml(ev.kind)}${ev.text ? ' · ' + escapeHtml(ev.text) : ''}</span>`;
  }
  return `<div class="feed-row${err}">
    <span class="ftime">${fmtClock(ev.ts)}</span>
    <span class="fglyph">${g}</span>
    <span class="fmain">${main}</span>
    <span class="fproj">${escapeHtml(ev.project || '')}</span>
  </div>`;
}

function feedVisible(ev) { return !($('feedErrOnly') && $('feedErrOnly').checked) || (ev.kind === 'tool' && ev.isError); }

function renderFeed() {
  const host = $('feedList');
  if (!host) return;
  const rows = state.feed.filter(feedVisible);
  host.innerHTML = rows.length ? rows.map(feedRowHtml).join('') : '<div class="feed-empty">no activity yet — wire the cc-scope hook (see below) and run any Claude Code session.</div>';
  updateFeedStats();
  if ($('feedScroll') && $('feedScroll').checked) host.scrollTop = host.scrollHeight;
}

function appendFeedRow(ev) {
  const host = $('feedList');
  if (!host) return;
  const empty = host.querySelector('.feed-empty');
  if (empty) host.innerHTML = '';
  if (feedVisible(ev)) {
    host.insertAdjacentHTML('beforeend', feedRowHtml(ev));
    if ($('feedScroll') && $('feedScroll').checked) host.scrollTop = host.scrollHeight;
  }
  updateFeedStats();
}

function updateFeedStats() {
  const f = state.feed;
  $('fCount').textContent = fmtInt(f.length);
  $('fErr').textContent = fmtInt(f.filter((e) => e.kind === 'tool' && e.isError).length);
  $('fSessions').textContent = fmtInt(new Set(f.map((e) => e.sessionId).filter(Boolean)).size);
  $('fLast').textContent = f.length ? fmtClock(f[f.length - 1].ts) : '—';
}

function bindFeed() {
  $('feedClear').addEventListener('click', () => { state.feed = []; renderFeed(); });
  $('feedErrOnly').addEventListener('change', renderFeed);
}

// ------------------------------------------------------------------ skills view
async function loadSkills() {
  state.skills = await fetchJson('/api/skills');
  if (!state.skillFocus && state.skills.skills.length) state.skillFocus = state.skills.skills[0].slug;
  renderSkills();
}

const PRESENCE_TITLE = { ok: 'in sync', staged: 'staged for upload — not confirmed live in cloud', drift: 'diverged from canonical', missing: 'not deployed' };
const PRESENCE_MARK = { ok: ' ✓', staged: ' ⇡', drift: ' ±', missing: ' ·' };

function renderSkills() {
  const d = state.skills;
  if (!d) return;
  const tools = d.tools || [];
  const c = d.counts || {};
  $('skTotal').textContent = fmtInt(c.total || 0);
  $('skClaude').textContent = fmtInt((c.byTool || {}).claude || 0);
  $('skCodex').textContent = fmtInt((c.byTool || {}).codex || 0);
  $('skCowork').textContent = fmtInt((c.byTool || {}).cowork || 0);
  $('skDrift').textContent = fmtInt(c.drift || 0);
  $('skNeed').textContent = fmtInt(c.needed || 0);
  $('skCmds').textContent = fmtInt(c.commands || 0);
  $('skCanon').textContent = d.canonicalRoot ? 'canonical: ' + d.canonicalRoot.replace(/\\/g, '/').split('/').slice(-2).join('/') : 'no canonical repo — run skillsync import';
  $('skIndexSub').textContent = `${d.skills.length} skills · ${tools.length} tools`;

  // index — coverage dots per tool
  $('skList').innerHTML = d.skills.map((s) => {
    const sel = state.skillFocus === s.slug ? ' sel' : '';
    const dots = tools.map((t) => `<span class="dot ${s.presence[t.key]}" title="${escapeHtml(t.label)}: ${PRESENCE_TITLE[s.presence[t.key]]}"></span>`).join('');
    return `<div class="ob-tool${sel}" data-skill="${escapeHtml(s.slug)}">
      <span class="tname" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
      <span class="scov">${dots}</span>
    </div>`;
  }).join('') || '<div class="none">no skills found</div>';

  // cards — one per skill with coverage pills
  $('skCards').innerHTML = d.skills.map((s) => {
    const sel = state.skillFocus === s.slug ? ' sel' : '';
    const pills = tools.map((t) => `<span class="sk-pill ${s.presence[t.key]}">${t.key}${PRESENCE_MARK[s.presence[t.key]] || ' ·'}</span>`).join('');
    return `<div class="ob-card sk-card${sel}" data-skill="${escapeHtml(s.slug)}">
      <div class="cname">${escapeHtml(s.name)}</div>
      <div class="cmeta">${escapeHtml((s.description || '').slice(0, 90))}${(s.description || '').length > 90 ? '…' : ''}</div>
      <div class="sk-pills">${pills}</div>
    </div>`;
  }).join('') || '<div class="none">no skills</div>';

  // needed gaps from flounder
  $('skNeeded').innerHTML = (d.needed || []).length ? d.needed.map((n) => `
    <div class="ob-spiral">
      <span class="sneed ${n.covered ? '' : 'gap'}">${n.covered ? '✓' : '✗'}</span>
      <span class="sname">${escapeHtml(n.skill)}</span>
      <span class="sclass">${escapeHtml(n.fromClass)} · ${n.failures} fails</span>
      <span class="sin" title="${escapeHtml(n.why)}">${escapeHtml(n.why)}</span>
    </div>`).join('') : '<div class="none">no failure-derived gaps — run some sessions through the FLOUNDER lens first</div>';

  // claude commands
  $('skCommands').innerHTML = (d.commands || []).length
    ? d.commands.map((cmd) => `<span class="sk-cmd" title="${escapeHtml(cmd.description || '')}"><span class="slash">/</span>${escapeHtml(cmd.slug)}</span>`).join('')
    : '<div class="none">no commands</div>';

  renderSkillDetail();
}

function renderSkillDetail() {
  const d = state.skills;
  if (!d) return;
  const s = (d.skills || []).find((x) => x.slug === state.skillFocus);
  if (!s) { $('skDetailTitle').textContent = 'select a skill'; return; }
  $('skDetailTitle').textContent = s.name;
  $('skDetailSub').textContent = `${s.canonical ? 'canonical' : 'tool-local (not in canonical repo)'} · status ${s.status}`;
  $('skWhat').innerHTML = escapeHtml(s.description || '(no description in frontmatter)');
  $('skDeployed').innerHTML = (d.tools || []).map((t) => {
    const p = s.presence[t.key];
    const col = p === 'ok' ? 'var(--green)' : p === 'staged' ? 'var(--cyan)' : p === 'drift' ? 'var(--orange)' : 'var(--ink-faint)';
    return `<div><span style="color:${col}">●</span> ${escapeHtml(t.label)} — ${PRESENCE_TITLE[p]}</div>`;
  }).join('');
  $('skTags').innerHTML = `<div>${(s.tags || []).map((t) => `<span class="sk-pill">${escapeHtml(t)}</span>`).join(' ') || '<span class="muted">no tags</span>'}</div>
    <div style="margin-top:6px">targets: ${escapeHtml((s.targets || []).join(', '))}</div>`;
  $('skBody').innerHTML = `<div class="ob-sample"><div class="sbody">${escapeHtml(s.body || '(no body)')}</div></div>`;
}

function bindSkills() {
  const pick = (e) => {
    const el = e.target.closest('[data-skill]');
    if (!el) return;
    state.skillFocus = el.dataset.skill;
    renderSkills();
  };
  $('skList').addEventListener('click', pick);
  $('skCards').addEventListener('click', pick);
}

// ------------------------------------------------------------------ inspector
let insTurn = null;

async function openInspector(turn) {
  insTurn = turn;
  $('inspector').hidden = false;
  $('insTitle').textContent = `${turn.messageId} · ${turn.requestId || 'no request id'}`;
  setTab('overview');
}

function closeInspector() { $('inspector').hidden = true; insTurn = null; }

async function getWire(id) {
  if (state.wireCache.has(id)) return state.wireCache.get(id);
  const rec = await fetchJson('/api/wire/' + encodeURIComponent(id));
  state.wireCache.set(id, rec);
  if (state.wireCache.size > 20) state.wireCache.delete(state.wireCache.keys().next().value);
  return rec;
}

async function setTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  const body = $('insBody');
  const t = insTurn;
  if (!t) return;

  if (name === 'overview') {
    const w = t.wire;
    body.innerHTML = `<div class="kv">
      ${kv('time', fmtClock(w ? w.startedAt : t.ts))}
      ${kv('model', t.model)}
      ${kv('stop reason', t.stopReason || '?')}
      ${kv('sidechain', t.isSidechain ? 'yes (sub-agent)' : 'no')}
      ${kv('round-trip', w ? fmtDur(w.durationMs) : 'no wire capture')}
      ${kv('time to first byte', w ? fmtDur(w.ttfbMs) : '—')}
      ${kv('messages in context', w ? fmtInt(w.messagesInRequest) : '—')}
      ${kv('tools offered', w ? fmtInt(w.toolsOffered) : '—')}
      ${kv('system prompt size', w ? fmtInt(w.systemChars) + ' chars' : '—')}
      ${kv('thinking', t.hasThinking ? 'yes' : 'no')}
      ${kv('tokens', t.usage ? `in ${fmtInt(t.usage.input_tokens)} · out ${fmtInt(t.usage.output_tokens)} · cache-write ${fmtInt(t.usage.cache_creation_input_tokens)} · cache-read ${fmtInt(t.usage.cache_read_input_tokens)}` : '—')}
      ${kv('tool calls', t.tools.length ? '' : 'none')}
    </div>` + t.tools.map((c) => `
      <div class="block-card tool${c.isError ? ' toolerr' : ''}">
        <div class="bh">tool_use · ${escapeHtml(c.name)}${c.isError ? ` · ✗ ${escapeHtml(c.errorClass || 'error')}` : ''}${c.resultSize != null ? ` · result ${fmtInt(c.resultSize)} chars` : ''}</div>
        <div class="bb">${escapeHtml(c.inputPreview || '')}${c.isError && c.resultPreview ? `\n↳ ${escapeHtml(c.resultPreview)}` : ''}</div>
      </div>`).join('');
    return;
  }

  if (!t.wire) {
    body.innerHTML = '<p class="meta">No wire capture for this turn — the session was not run through the ccspy proxy. Transcript-side data only (see overview).</p>';
    return;
  }

  body.innerHTML = '<p class="meta">loading wire record…</p>';
  let rec;
  try { rec = await getWire(t.wire.id); }
  catch (err) { body.innerHTML = `<p class="meta">failed to load: ${escapeHtml(err.message)}</p>`; return; }

  body.innerHTML = '';
  if (name === 'request') {
    body.appendChild(jsonTree(rec.request, 'request', 1));
  } else if (name === 'response') {
    const msg = rec.response.message || rec.response.body;
    if (msg && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const card = document.createElement('div');
        if (block.type === 'thinking') {
          card.className = 'block-card thinking';
          card.innerHTML = `<div class="bh">thinking</div><div class="bb">${escapeHtml(block.thinking || '(redacted/empty)')}</div>`;
        } else if (block.type === 'text') {
          card.className = 'block-card';
          card.innerHTML = `<div class="bh">text</div><div class="bb">${escapeHtml(block.text || '')}</div>`;
        } else if (block.type === 'tool_use') {
          card.className = 'block-card tool';
          card.innerHTML = `<div class="bh">tool_use · ${escapeHtml(block.name)}</div><div class="bb">${escapeHtml(JSON.stringify(block.input, null, 2))}</div>`;
        } else {
          card.className = 'block-card';
          card.innerHTML = `<div class="bh">${escapeHtml(block.type)}</div><div class="bb">${escapeHtml(JSON.stringify(block, null, 2).slice(0, 4000))}</div>`;
        }
        body.appendChild(card);
      }
      const meta = document.createElement('div');
      meta.appendChild(jsonTree({ usage: msg.usage, stop_reason: msg.stop_reason, eventCounts: rec.response.eventCounts }, 'meta', 1));
      body.appendChild(meta);
    } else {
      body.appendChild(jsonTree(rec.response, 'response', 1));
    }
  } else if (name === 'raw') {
    body.appendChild(jsonTree(rec, 'wire record', 1));
  }
}

function kv(k, v) { return `<span class="k">${escapeHtml(k)}</span><span class="v">${typeof v === 'string' && v.startsWith('<') ? v : escapeHtml(String(v))}</span>`; }

// Lazy collapsible JSON tree (handles multi-MB payloads).
function jsonTree(value, label, openDepth) {
  const root = document.createElement('div');
  root.className = 'jt';
  root.appendChild(jsonNode(label, value, openDepth));
  return root;
}

function jsonNode(key, value, openDepth) {
  const isObj = value !== null && typeof value === 'object';
  if (!isObj) {
    const span = document.createElement('div');
    let cls = 'n', text = String(value);
    if (typeof value === 'string') { cls = 's'; text = JSON.stringify(value); }
    else if (typeof value === 'boolean' || value === null) cls = 'b';
    span.innerHTML = `<span class="k">${escapeHtml(key)}</span>: <span class="${cls}">${escapeHtml(text)}</span>`;
    return span;
  }
  const isArr = Array.isArray(value);
  const size = isArr ? value.length : Object.keys(value).length;
  const det = document.createElement('details');
  if (openDepth > 0 && size <= 30) det.open = true;
  const sum = document.createElement('summary');
  sum.innerHTML = `<span class="k">${escapeHtml(key)}</span> <span class="meta">${isArr ? `[${size}]` : `{${size}}`}</span>`;
  det.appendChild(sum);
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
    for (const [k, v] of entries) det.appendChild(jsonNode(String(k), v, openDepth - 1));
  };
  if (det.open) build();
  det.addEventListener('toggle', build, { once: true });
  return det;
}

// ------------------------------------------------------------------ boot
async function main() {
  bindGallery();
  $('sessionPicker').addEventListener('change', (e) => selectSession(e.target.value).catch(console.error));
  $('followLive').addEventListener('change', autoFollow);
  $('insClose').addEventListener('click', closeInspector);
  $('inspector').addEventListener('click', (e) => { if (e.target.id === 'inspector') closeInspector(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeInspector(); });
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));
  for (const b of document.querySelectorAll('#viewtabs button')) b.addEventListener('click', () => setView(b.dataset.view));
  bindRoi();
  bindErrors();
  bindFeed();
  bindSkills();
  window.addEventListener('resize', () => {
    scheduleRender();
    if (document.body.classList.contains('daily') && state.daily) drawDailyChart(state.daily.days);
    if (document.body.classList.contains('errors') && state.errors) drawErrTrend((state.errors.daily || []).slice(-45));
  });

  try { state.pricing = await fetchJson('/pricing.json'); } catch { state.pricing = null; }
  await loadSessions();
  if (state.sessions.length) await selectSession(state.sessions[0].id);
  connectSSE();
  loadAccountUsage();
  setInterval(loadAccountUsage, 5 * 60 * 1000);
}

main().catch((err) => {
  setConn('server unreachable', 'bad');
  console.error(err);
});
